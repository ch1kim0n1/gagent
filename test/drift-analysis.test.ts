import {
  analyzeCohortDrift,
  deterministicSample,
  executionReceiptToCohortSnapshot,
  parseWindowDuration,
} from '../src/core/drift-analysis.js';
import { ExecutionReceipt } from '../src/types/quality-rubric.js';

const now = new Date('2026-05-15T12:00:00.000Z');

function snapshot(cohort: string, daysAgo: number, metrics: Record<string, number>, frustrated = false) {
  return {
    cohort,
    timestamp: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    count: metrics.count ?? 1,
    total: 1,
    frustrated,
    metrics,
  };
}

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    receipt_id: '11111111-1111-4111-8111-111111111111',
    schema_version: 1,
    timestamp: now.toISOString(),
    project: 'gagent',
    rubric_name: 'gagent_v1',
    rubric_sha8: 'abcdef12',
    input_hash: 'inputhash',
    models_used: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
    config_hash: 'confighash',
    verdict: 'pass',
    scores: {
      overall_score: { score: 0.9, confidence: 0.9, weight: 1 },
    },
    overall_score: 0.9,
    hard_gates_passed: true,
    cost_usd: 0.01,
    metadata: {
      task: 'analysis',
      consensus: { tier2_invoked: true },
    },
    ...overrides,
  };
}

describe('gagent drift analysis', () => {
  it('parses duration windows and samples deterministically with lexical tie-breaking', () => {
    expect(parseWindowDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseWindowDuration('24h')).toBe(24 * 60 * 60 * 1000);
    expect(() => parseWindowDuration('10x')).toThrow();
    expect(deterministicSample(['b', 'a', 'c'], 10, item => item)).toEqual(['a', 'b', 'c']);
  });

  it('detects cohort count anomalies with zero-stddev fallback and brand-new handling', () => {
    const results = analyzeCohortDrift([
      snapshot('enterprise', 14, { count: 2, latency_ms: 100 }),
      snapshot('enterprise', 13, { count: 2, latency_ms: 100 }),
      snapshot('enterprise', 2, { count: 4, latency_ms: 130 }),
      snapshot('enterprise', 1, { count: 4, latency_ms: 130 }),
      snapshot('new-cohort', 2, { count: 3 }),
      snapshot('new-cohort', 1, { count: 3 }),
    ], {
      windowMs: parseWindowDuration('7d'),
      minSamples: 2,
      now,
    });

    const enterprise = results.find(result => result.cohort === 'enterprise');
    const brandNew = results.find(result => result.cohort === 'new-cohort');

    expect(enterprise?.anomalies.map(anomaly => anomaly.reason)).toContain('zero_stddev_fallback');
    expect(brandNew?.brand_new).toBe(true);
    expect(brandNew?.anomalies.map(anomaly => anomaly.reason)).toContain('new_cohort_count');
  });

  it('converts receipts and flags statistical escalation-rate drift', () => {
    const escalatedSnapshot = executionReceiptToCohortSnapshot(receipt());
    expect(escalatedSnapshot.metrics?.escalation_rate).toBe(1);

    const results = analyzeCohortDrift([
      snapshot('analysis', 14, { escalation_rate: 0 }),
      snapshot('analysis', 13, { escalation_rate: 0 }),
      snapshot('analysis', 12, { escalation_rate: 0 }),
      snapshot('analysis', 11, { escalation_rate: 1 }),
      snapshot('analysis', 2, { escalation_rate: 1 }),
      snapshot('analysis', 1, { escalation_rate: 1 }),
    ], {
      windowMs: parseWindowDuration('7d'),
      minSamples: 2,
      now,
    });

    const analysis = results.find(result => result.cohort === 'analysis');
    expect(analysis?.anomalies.map(anomaly => anomaly.metric)).toContain('escalation_rate');
  });
});
