import { evaluateRegressionGates, loadRegressionBaselines } from '../src/core/regression-gates.js';
import { ExecutionReceipt } from '../src/types/quality-rubric.js';
import * as crypto from 'crypto';

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    receipt_id: crypto.randomUUID(),
    schema_version: 1,
    timestamp: new Date().toISOString(),
    project: 'gagent',
    rubric_name: 'gagent_v1',
    rubric_sha8: 'abcdef12',
    input_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    models_used: ['model-a'],
    config_hash: 'config',
    verdict: 'pass',
    scores: {
      overall_score: { score: 0.6, confidence: 0.9, weight: 1 },
    },
    overall_score: 0.6,
    hard_gates_passed: true,
    cost_usd: 0.01,
    metadata: {
      latency_ms: 100,
      consensus: { tier3_invoked: false },
    },
    ...overrides,
  };
}

describe('regression gates', () => {
  it('loads versioned JSONL baselines and evaluates score, cost, latency, and escalation', async () => {
    const baselines = await loadRegressionBaselines('test/baselines/regression-baselines.jsonl');
    const gate = evaluateRegressionGates(receipt(), baselines);

    expect(baselines.map(b => b.dimension)).toEqual([
      'overall_score',
      'cost_usd',
      'latency_ms',
      'escalation_rate',
    ]);
    expect(gate.passed).toBe(true);
    expect(gate.results.find(result => result.dimension === 'overall_score')?.wilson_95_ci).toBeDefined();
  });

  it('fails on cost, latency, and escalation regressions for CI exit integration', async () => {
    const baselines = await loadRegressionBaselines('test/baselines/regression-baselines.jsonl');
    const gate = evaluateRegressionGates(receipt({
      cost_usd: 0.2,
      metadata: {
        latency_ms: 20000,
        consensus: { tier3_invoked: true },
      },
    }), baselines);

    expect(gate.passed).toBe(false);
    expect(gate.results.filter(result => !result.passed).map(result => result.dimension)).toEqual([
      'cost_usd',
      'latency_ms',
      'escalation_rate',
    ]);
  });
});
