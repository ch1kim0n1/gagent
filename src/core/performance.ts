export type ProgressPhase =
  | 'queued'
  | 'prime'
  | 'plan'
  | 'execute'
  | 'verify'
  | 'cognitive_check'
  | 'select'
  | 'persist'
  | 'learn'
  | 'complete'
  | 'cancelled';

export interface ProgressEvent {
  phase: ProgressPhase;
  message: string;
  progress: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class BackpressureError extends Error {
  constructor(message: string, public readonly retryAfterMs: number) {
    super(message);
    this.name = 'BackpressureError';
  }
}

export class TaskBackpressureLimiter {
  private active = 0;
  private queue: QueueEntry[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueDepth = maxConcurrency * 4,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Task cancelled before execution'));
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new BackpressureError('Task queue is full; retry later', 1000));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, signal };
      entry.onAbort = () => {
        this.queue = this.queue.filter(item => item !== entry);
        reject(new Error('Task cancelled while queued'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  getStats(): { active: number; queued: number; maxConcurrency: number; maxQueueDepth: number } {
    return { active: this.active, queued: this.queue.length, maxConcurrency: this.maxConcurrency, maxQueueDepth: this.maxQueueDepth };
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(new Error('Task cancelled while queued'));
        continue;
      }
      this.active++;
      entry.resolve(() => this.release());
    }
  }
}

export class TTLCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries = 256, private readonly ttlMs = 5 * 60 * 1000) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  stats(): { entries: number; maxEntries: number; ttlMs: number } {
    return { entries: this.entries.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs };
  }
}

export interface BenchmarkSample {
  name: string;
  duration_ms: number;
  heap_used_mb: number;
  rss_mb: number;
  success: boolean;
}

export function memorySnapshotMb(): { heap_used_mb: number; rss_mb: number } {
  const usage = process.memoryUsage();
  return {
    heap_used_mb: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
    rss_mb: Number((usage.rss / 1024 / 1024).toFixed(2)),
  };
}

export function summarizeBenchmark(samples: BenchmarkSample[]): {
  runs: number;
  success_rate: number;
  p50_ms: number;
  p95_ms: number;
  max_rss_mb: number;
  max_heap_used_mb: number;
} {
  const durations = samples.map(sample => sample.duration_ms).sort((a, b) => a - b);
  const percentile = (p: number) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))];
  return {
    runs: samples.length,
    success_rate: samples.length === 0 ? 0 : samples.filter(sample => sample.success).length / samples.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_rss_mb: samples.reduce((max, sample) => Math.max(max, sample.rss_mb), 0),
    max_heap_used_mb: samples.reduce((max, sample) => Math.max(max, sample.heap_used_mb), 0),
  };
}
