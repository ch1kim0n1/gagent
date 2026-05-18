import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  attributes: Record<string, unknown>;
  status: 'ok' | 'error';
  error?: string;
}

interface HealthCheckLike {
  service: string;
  healthy: boolean;
  latency_ms: number;
  error?: string;
  timestamp: string;
}

const SENSITIVE_KEYS = /(?:api[_-]?key|token|secret|password|authorization|email|phone|ssn|credit[_-]?card)/i;
const API_KEY_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function redactPII(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPII);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redactPII(nested),
    ]));
  }
  if (typeof value === 'string') {
    return value.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]').replace(API_KEY_PATTERN, '[REDACTED_SECRET]');
  }
  return value;
}

export class LocalLogger {
  private context: Record<string, unknown> = {};

  constructor(private toolName: string, private level: LogLevel = 'INFO') {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('DEBUG', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', message, context);
  }

  error(message: string, error?: Error | Record<string, unknown>): void {
    this.write('ERROR', message, error instanceof Error ? { error: error.message, stack: error.stack } : error);
  }

  child(context: Record<string, unknown>): LocalLogger {
    const child = new LocalLogger(this.toolName, this.level);
    child.context = { ...this.context, ...context };
    return child;
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const levels: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    if (levels.indexOf(level) < levels.indexOf(this.level)) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.toolName,
      message,
      ...(redactPII(this.context) as Record<string, unknown>),
      ...(redactPII(context ?? {}) as Record<string, unknown>),
    };
    const line = JSON.stringify(entry);
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (level === 'DEBUG') console.debug(line);
    else console.info(line);
  }
}

export const coreLogger = new LocalLogger('gagent', (process.env.GAGENT_LOG_LEVEL as LogLevel) || 'INFO');

export class LocalAuditLogger {
  private auditDir: string;
  private retentionDays: number;

  constructor(private tool: string) {
    this.auditDir = process.env.GAGENT_AUDIT_DIR || path.join(os.homedir(), `.${tool}`, 'audit');
    this.retentionDays = Number(process.env.GAGENT_LOG_RETENTION_DAYS || '7');
    fs.mkdirSync(this.auditDir, { recursive: true });
    this.rotateOldLogs();
  }

  /**
   * Rotate old logs based on retention policy
   */
  private rotateOldLogs(): void {
    try {
      if (!fs.existsSync(this.auditDir)) return;

      const files = fs.readdirSync(this.auditDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      for (const file of files) {
        const filePath = path.join(this.auditDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile() && stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      console.error(`[LocalAuditLogger] Failed to rotate logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async log(entry: {
    operation: string;
    decision: string;
    reasoning?: string;
    model_tier?: string;
    model_name?: string;
    cost_usd?: number;
    tokens?: number;
    latency_ms?: number;
    success: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    this.logDecision(entry);
  }

  logDecision(entry: {
    operation: string;
    decision: string;
    reasoning?: string;
    correlation_id?: string;
    trace_id?: string;
    model_tier?: string;
    model_name?: string;
    cost_usd?: number;
    tokens?: number;
    latency_ms?: number;
    success: boolean;
    metadata?: Record<string, unknown>;
    error?: string;
  }): void {
    this.append(`decisions-${isoWeek(new Date())}.jsonl`, {
      timestamp: new Date().toISOString(),
      tool: this.tool,
      ...entry,
    });
  }

  logShellJob(entry: {
    command: string;
    cwd?: string;
    exit_code?: number;
    duration_ms?: number;
    correlation_id?: string;
    trace_id?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }): void {
    this.append(`shell-jobs-${isoWeek(new Date())}.jsonl`, {
      timestamp: new Date().toISOString(),
      tool: this.tool,
      ...entry,
    });
  }

  logSecurityEvent(entry: {
    event: string;
    actor?: string;
    target?: string;
    scope?: string;
    success: boolean;
    correlation_id?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }): void {
    this.append(`security-${isoWeek(new Date())}.jsonl`, {
      timestamp: new Date().toISOString(),
      tool: this.tool,
      ...entry,
    });
  }

  private append(fileName: string, entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(path.join(this.auditDir, fileName), JSON.stringify(redactPII(entry)) + '\n', 'utf8');
    } catch (error) {
      coreLogger.warn('Audit write failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  increment(name: string, labels: Record<string, string> = {}, count = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + count);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    const values = this.histograms.get(key) ?? [];
    values.push(value);
    if (values.length > 5000) values.shift();
    this.histograms.set(key, values);
  }

  recordPublicMethod(method: string, durationMs: number, status: 'ok' | 'error'): void {
    this.increment('gagent_public_method_throughput_total', { method, status });
    this.observe('gagent_public_method_latency_ms', durationMs, { method });
    if (status === 'error') this.increment('gagent_public_method_errors_total', { method });
  }

  prometheus(): string {
    const lines: string[] = [
      '# HELP gagent_public_method_throughput_total Total public method calls by method and status.',
      '# TYPE gagent_public_method_throughput_total counter',
    ];
    for (const [key, value] of this.counters) {
      lines.push(`${key} ${value}`);
    }
    lines.push('# HELP gagent_public_method_latency_ms Public method latency quantiles.');
    lines.push('# TYPE gagent_public_method_latency_ms summary');
    for (const [key, values] of this.histograms) {
      const { name, labels } = parseMetricKey(key);
      for (const quantile of [0.5, 0.95, 0.99]) {
        lines.push(`${name}{${formatLabels({ ...labels, quantile: String(quantile) })}} ${quantileValue(values, quantile).toFixed(3)}`);
      }
      lines.push(`${name}_count{${formatLabels(labels)}} ${values.length}`);
    }
    return lines.join('\n') + '\n';
  }

  openTelemetry(): Record<string, unknown> {
    return {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gagent' } }] },
        scopeMetrics: [{
          scope: { name: 'gagent.local' },
          metrics: this.snapshot(),
        }],
      }],
    };
  }

  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([key, values]) => [key, {
        count: values.length,
        p50: quantileValue(values, 0.5),
        p95: quantileValue(values, 0.95),
        p99: quantileValue(values, 0.99),
      }])),
    };
  }
}

export class Tracer {
  private spans: SpanRecord[] = [];

  startSpan(name: string, attributes: Record<string, unknown> = {}, traceparent?: string): SpanRecord {
    const parsed = parseTraceparent(traceparent);
    const span: SpanRecord = {
      trace_id: parsed?.traceId ?? crypto.randomBytes(16).toString('hex'),
      span_id: crypto.randomBytes(8).toString('hex'),
      parent_span_id: parsed?.spanId,
      name,
      started_at: new Date().toISOString(),
      attributes: redactPII(attributes) as Record<string, unknown>,
      status: 'ok',
    };
    this.spans.push(span);
    if (this.spans.length > 1000) this.spans.shift();
    return span;
  }

  endSpan(span: SpanRecord, error?: Error): void {
    const endedAt = new Date();
    span.ended_at = endedAt.toISOString();
    span.duration_ms = endedAt.getTime() - new Date(span.started_at).getTime();
    span.status = error ? 'error' : 'ok';
    span.error = error?.message;
  }

  getTraceparent(span: SpanRecord): string {
    return `00-${span.trace_id}-${span.span_id}-01`;
  }

  snapshot(): SpanRecord[] {
    return [...this.spans];
  }
}

export class GAgentObservability {
  readonly logger: LocalLogger;
  readonly audit: LocalAuditLogger;
  readonly metrics: MetricsRegistry;
  readonly tracer: Tracer;
  private lastHealthScore = 100;

  constructor(private tool = 'gagent') {
    this.logger = new LocalLogger(tool, (process.env.GAGENT_LOG_LEVEL as LogLevel) || 'INFO');
    this.audit = new LocalAuditLogger(tool);
    this.metrics = new MetricsRegistry();
    this.tracer = new Tracer();
  }

  async alertOnHealthDrop(score: number, checks: HealthCheckLike[]): Promise<void> {
    const threshold = Number(process.env.GAGENT_HEALTH_ALERT_THRESHOLD || '80');
    const webhook = process.env.GAGENT_HEALTH_WEBHOOK_URL;
    if (!webhook || score >= threshold || this.lastHealthScore < threshold) {
      this.lastHealthScore = score;
      return;
    }
    this.lastHealthScore = score;
    const payload = redactPII({
      tool: this.tool,
      event: 'health_drop',
      score,
      threshold,
      failed_checks: checks.filter(check => !check.healthy),
      timestamp: new Date().toISOString(),
    });
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logger.warn('Health alert webhook failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      metrics: this.metrics.snapshot(),
      traces: this.tracer.snapshot(),
    };
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const labelText = formatLabels(labels);
  return labelText ? `${name}{${labelText}}` : name;
}

function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  const match = key.match(/^([^{]+)(?:\{(.+)\})?$/);
  if (!match) return { name: key, labels: {} };
  const labels: Record<string, string> = {};
  for (const part of (match[2] ?? '').split(',').filter(Boolean)) {
    const [labelKey, rawValue] = part.split('=');
    labels[labelKey] = rawValue.replace(/^"|"$/g, '');
  }
  return { name: match[1], labels };
}

function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
    .join(',');
}

function quantileValue(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function parseTraceparent(traceparent?: string): { traceId: string; spanId: string } | null {
  const match = traceparent?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/i);
  return match ? { traceId: match[1], spanId: match[2] } : null;
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
