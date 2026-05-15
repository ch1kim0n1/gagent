import * as crypto from 'crypto';
import { ExecutionReceipt } from '../types/quality-rubric.js';

export interface CohortMetricSnapshot {
  cohort: string;
  timestamp: string;
  count?: number;
  total?: number;
  frustrated?: boolean;
  metrics?: Record<string, number>;
}

export interface CohortAnomaly {
  metric: string;
  baseline_mean: number;
  current_mean: number;
  baseline_stddev: number;
  delta: number;
  reason: 'zero_stddev_fallback' | 'sigma_threshold' | 'new_cohort_count';
}

export interface CohortDriftResult {
  cohort: string;
  sample_size: number;
  baseline_size: number;
  current_size: number;
  brand_new: boolean;
  anomalies: CohortAnomaly[];
  frustration_wilson_95_ci: {
    baseline: { lower: number; upper: number };
    current: { lower: number; upper: number };
    degraded: boolean;
  };
}

export interface CohortDriftOptions {
  windowMs: number;
  minSamples?: number;
  sigmaThreshold?: number;
  sampleLimit?: number;
  seed?: string;
  now?: Date;
}

export function parseWindowDuration(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)([dhm])$/.exec(trimmed);
  if (!match) throw new Error('Window must use a duration like 7d, 24h, or 30m');
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000;
  return amount * multiplier;
}

export function deterministicSample<T>(
  items: T[],
  limit: number,
  key: (item: T) => string,
  seed = 'gagent',
): T[] {
  if (items.length <= limit) {
    return [...items].sort((a, b) => key(a).localeCompare(key(b)));
  }

  return [...items]
    .sort((a, b) => {
      const hashA = stableHash(`${seed}:${key(a)}`);
      const hashB = stableHash(`${seed}:${key(b)}`);
      return hashA.localeCompare(hashB) || key(a).localeCompare(key(b));
    })
    .slice(0, limit)
    .sort((a, b) => key(a).localeCompare(key(b)));
}

export function executionReceiptToCohortSnapshot(receipt: ExecutionReceipt): CohortMetricSnapshot {
  const metadata = receipt.metadata ?? {};
  const success = receipt.hard_gates_passed && receipt.verdict !== 'fail' ? 1 : 0;
  const escalationRate = extractEscalationRate(receipt);

  return {
    cohort: String(metadata.cohort || metadata.task_type || metadata.task || receipt.input_hash.substring(0, 8) || 'default'),
    timestamp: receipt.timestamp,
    count: 1,
    total: 1,
    frustrated: success < 0.5,
    metrics: {
      success_rate: success,
      error_rate: success < 0.5 ? 1 : 0,
      escalation_rate: escalationRate,
      overall_score: receipt.overall_score,
      latency_ms: Number(metadata.latency_ms || metadata.duration_ms || 0),
      cost_usd: receipt.cost_usd || 0,
    },
  };
}

export function analyzeCohortDrift(
  snapshots: CohortMetricSnapshot[],
  options: CohortDriftOptions,
): CohortDriftResult[] {
  const minSamples = options.minSamples ?? 5;
  const sigmaThreshold = options.sigmaThreshold ?? 1.5;
  const sampleLimit = options.sampleLimit ?? 500;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.windowMs);
  const sampled = deterministicSample(
    snapshots,
    sampleLimit,
    snapshot => `${snapshot.cohort}:${snapshot.timestamp}:${JSON.stringify(snapshot.metrics ?? {})}`,
    options.seed,
  );

  const byCohort = new Map<string, CohortMetricSnapshot[]>();
  for (const snapshot of sampled) {
    const cohort = snapshot.cohort || 'unknown';
    byCohort.set(cohort, [...(byCohort.get(cohort) ?? []), snapshot]);
  }

  return Array.from(byCohort.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, cohortSnapshots]) => {
      const baseline = cohortSnapshots.filter(snapshot => new Date(snapshot.timestamp) < cutoff);
      const current = cohortSnapshots.filter(snapshot => new Date(snapshot.timestamp) >= cutoff);
      const brandNew = baseline.length < minSamples || current.length < minSamples;

      return {
        cohort,
        sample_size: cohortSnapshots.length,
        baseline_size: baseline.length,
        current_size: current.length,
        brand_new: brandNew,
        anomalies: collectAnomalies(cohortSnapshots, baseline, current, brandNew, sigmaThreshold),
        frustration_wilson_95_ci: frustrationWilson(baseline, current),
      };
    });
}

function collectAnomalies(
  allSnapshots: CohortMetricSnapshot[],
  baseline: CohortMetricSnapshot[],
  current: CohortMetricSnapshot[],
  brandNew: boolean,
  sigmaThreshold: number,
): CohortAnomaly[] {
  const metricNames = new Set<string>(['count']);
  for (const snapshot of allSnapshots) {
    for (const metric of Object.keys(snapshot.metrics ?? {})) metricNames.add(metric);
  }

  const anomalies: CohortAnomaly[] = [];
  for (const metric of Array.from(metricNames).sort()) {
    const baselineValues = valuesForMetric(baseline, metric);
    const currentValues = valuesForMetric(current, metric);
    if (currentValues.length === 0) continue;

    const baselineMean = mean(baselineValues);
    const currentMean = mean(currentValues);
    const baselineStddev = stddev(baselineValues, baselineMean);
    const delta = currentMean - baselineMean;

    if (brandNew && metric === 'count' && currentMean > baselineMean + 1) {
      anomalies.push({ metric, baseline_mean: baselineMean, current_mean: currentMean, baseline_stddev: baselineStddev, delta, reason: 'new_cohort_count' });
      continue;
    }

    if (baselineValues.length === 0) continue;
    if (baselineStddev === 0 && Math.abs(delta) > 1) {
      anomalies.push({ metric, baseline_mean: baselineMean, current_mean: currentMean, baseline_stddev: baselineStddev, delta, reason: 'zero_stddev_fallback' });
    } else if (baselineStddev > 0 && Math.abs(delta) > sigmaThreshold * baselineStddev) {
      anomalies.push({ metric, baseline_mean: baselineMean, current_mean: currentMean, baseline_stddev: baselineStddev, delta, reason: 'sigma_threshold' });
    }
  }

  return anomalies;
}

function extractEscalationRate(receipt: ExecutionReceipt): number {
  const metadata = receipt.metadata ?? {};
  const consensus = metadata.consensus ?? {};
  if (typeof metadata.escalation_rate === 'number') return metadata.escalation_rate;
  if (metadata.escalated || metadata.tier2_invoked || metadata.tier3_invoked || consensus.tier2_invoked || consensus.tier3_invoked) return 1;
  return Array.isArray(receipt.models_used) && receipt.models_used.length > 1 ? 1 : 0;
}

function valuesForMetric(snapshots: CohortMetricSnapshot[], metric: string): number[] {
  return snapshots
    .map(snapshot => metric === 'count' ? (snapshot.count ?? 1) : snapshot.metrics?.[metric])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function frustrationWilson(
  baseline: CohortMetricSnapshot[],
  current: CohortMetricSnapshot[],
): CohortDriftResult['frustration_wilson_95_ci'] {
  const baselineCi = wilson95(baseline.filter(snapshot => snapshot.frustrated).length, Math.max(1, baseline.length));
  const currentCi = wilson95(current.filter(snapshot => snapshot.frustrated).length, Math.max(1, current.length));

  return {
    baseline: baselineCi,
    current: currentCi,
    degraded: currentCi.lower > baselineCi.upper,
  };
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length);
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  const z = 1.96;
  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return {
    lower: Math.max(0, (center - margin) / denominator),
    upper: Math.min(1, (center + margin) / denominator),
  };
}
