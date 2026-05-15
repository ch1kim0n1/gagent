import * as fs from 'fs/promises';
import { ExecutionReceipt } from '../types/quality-rubric.js';

export interface RegressionBaseline {
  dimension: string;
  baseline: number;
  tolerance: number;
  direction: 'min' | 'max';
  min_samples?: number;
}

export interface RegressionGateResult {
  passed: boolean;
  dimension: string;
  current: number;
  baseline: number;
  tolerance: number;
  direction: 'min' | 'max';
  delta: number;
  wilson_95_ci?: { lower: number; upper: number };
}

export async function loadRegressionBaselines(path: string): Promise<RegressionBaseline[]> {
  const content = await fs.readFile(path, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as RegressionBaseline);
}

export function evaluateRegressionGates(
  receipt: ExecutionReceipt,
  baselines: RegressionBaseline[],
): { passed: boolean; results: RegressionGateResult[] } {
  const results = baselines.map(baseline => evaluateDimension(receipt, baseline));
  return {
    passed: results.every(result => result.passed),
    results,
  };
}

function evaluateDimension(receipt: ExecutionReceipt, baseline: RegressionBaseline): RegressionGateResult {
  const current = getReceiptMetric(receipt, baseline.dimension);
  const delta = current - baseline.baseline;
  const allowed = baseline.baseline * baseline.tolerance;
  const passed = baseline.direction === 'min'
    ? current + allowed >= baseline.baseline
    : current <= baseline.baseline + allowed;

  return {
    passed,
    dimension: baseline.dimension,
    current,
    baseline: baseline.baseline,
    tolerance: baseline.tolerance,
    direction: baseline.direction,
    delta,
    wilson_95_ci: baseline.dimension === 'overall_score'
      ? wilson95(receipt.hard_gates_passed ? 1 : 0, Math.max(1, baseline.min_samples || 1))
      : undefined,
  };
}

function getReceiptMetric(receipt: ExecutionReceipt, dimension: string): number {
  if (dimension === 'overall_score') return receipt.overall_score;
  if (dimension === 'cost_usd') return receipt.cost_usd || 0;
  if (dimension === 'latency_ms') return Number(receipt.metadata?.latency_ms || receipt.metadata?.duration_ms || 0);
  if (dimension === 'escalation_rate') {
    const consensus = receipt.metadata?.consensus;
    return consensus?.tier3_invoked || receipt.metadata?.tier3_invoked ? 1 : 0;
  }
  const score = receipt.scores?.[dimension]?.score;
  if (typeof score === 'number') return score;
  const metadataValue = receipt.metadata?.[dimension];
  return typeof metadataValue === 'number' ? metadataValue : 0;
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 0 };
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
