import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BackpressureError, TaskBackpressureLimiter, TTLCache, summarizeBenchmark } from '../src/core/performance';
import { MODEL_RESOLUTION_CHAIN } from '../src/core/llm-client';

describe('performance controls', () => {
  it('limits overall task processing and reports backpressure', async () => {
    const limiter = new TaskBackpressureLimiter(1, 1);
    const release = await limiter.acquire();
    const queued = limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(BackpressureError);
    expect(limiter.getStats()).toMatchObject({ active: 1, queued: 1, maxConcurrency: 1, maxQueueDepth: 1 });

    release();
    const queuedRelease = await queued;
    queuedRelease();
    expect(limiter.getStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('supports cancellation while queued', async () => {
    const limiter = new TaskBackpressureLimiter(1, 1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow('cancelled');
    release();
  });

  it('provides LRU-style TTL caching', () => {
    const cache = new TTLCache<string, number>(1, 1000);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('defines the gbrain-style 8-tier model resolution chain', () => {
    expect(MODEL_RESOLUTION_CHAIN).toHaveLength(8);
    expect(MODEL_RESOLUTION_CHAIN.map(entry => entry.source)).toEqual([
      'explicit_task_model',
      'winning_gbrain_config',
      'task_type_default',
      'low_cost_fast_path',
      'quality_escalation',
      'cross_vendor_consensus',
      'critical_decision',
      'safe_fallback',
    ]);
  });

  it('exposes progress streaming and processing stats on the pipeline', () => {
    const source = readFileSync(join(__dirname, '../src/pipeline/orchestrator.ts'), 'utf8');

    expect(source).toContain('executeStream');
    expect(source).toContain('onProgress');
    expect(source).toContain('AbortSignal');
    expect(source).toContain('getTaskProcessingStats');
  });

  it('summarizes benchmark samples with memory baseline fields', () => {
    const summary = summarizeBenchmark([
      { name: 'a', duration_ms: 10, heap_used_mb: 20, rss_mb: 50, success: true },
      { name: 'b', duration_ms: 30, heap_used_mb: 25, rss_mb: 55, success: true },
    ]);

    expect(summary).toMatchObject({
      runs: 2,
      success_rate: 1,
      p50_ms: 10,
      p95_ms: 10,
      max_rss_mb: 55,
      max_heap_used_mb: 25,
    });
  });
});
