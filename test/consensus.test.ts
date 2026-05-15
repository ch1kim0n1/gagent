import { Pipeline } from '../src/pipeline/orchestrator';
import { ToolRegistry } from '../src/tools/registry';
import { GAgentConfig } from '../src/config/manager';
import fs from 'fs';
import os from 'os';
import path from 'path';

function makeConfig(): GAgentConfig {
  const tmpFile = path.join(os.tmpdir(), `gagent-consensus-test-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    version: '0.1.0',
    tools: {
      gbrain: { enabled: false },
      gstack: { enabled: false },
      gorchestrator: { enabled: false },
      gmirror: { enabled: false },
      gtom: { enabled: false },
      glearn: { enabled: false },
    },
    integration: { event_bus: 'gbrain', shared_memory: true, cross_tool_sync: true },
    pipeline: { default_parallel: 3, max_parallel: 10, verification_threshold: 0.7, cognitive_check_threshold: 0.6 },
  }));
  const config = new GAgentConfig({ configPath: tmpFile });
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  return config;
}

function vote(winnerIndex: number, dimensions?: Record<string, number>): string {
  return JSON.stringify({
    winnerIndex,
    confidence: 0.9,
    dimensions: dimensions || {
      correctness: 0.9,
      completeness: 0.85,
      reliability: 0.8,
      safety: 0.95,
    },
    reasoning: 'test vote',
  });
}

function makePipelineWithResponses(responses: string[]) {
  const config = makeConfig();
  const pipeline = new Pipeline(new ToolRegistry(config), config);
  const modelsByTier = {
    tier1: 'claude-haiku-4-5-20251001',
    tier2: 'claude-sonnet-4-6',
    tier3: 'claude-opus-4-7',
  };
  const calls: string[] = [];

  (pipeline as any).llmClient = {
    getModelByTier: (tier: keyof typeof modelsByTier) => modelsByTier[tier],
    getTotalCostUsd: () => 0,
    call: async (_prompt: string, options: { model: string }) => {
      const content = responses[calls.length];
      calls.push(options.model);
      return {
        content,
        input_tokens: 100,
        output_tokens: 50,
        model_id: options.model,
        cost_usd: 0.001,
        latency_ms: 10,
      };
    },
  };

  return { pipeline, calls };
}

const attempts = [
  { id: 'a0', output: 'first attempt' },
  { id: 'a1', output: 'second attempt' },
] as any[];

const options = {
  task: 'choose best',
  parallel: 2,
  verify: false,
  cognitiveCheck: false,
  learn: false,
  dryRun: true,
};

describe('Pipeline multi-model consensus', () => {
  it('invokes tier3 after tier1 and tier2 fail to agree', async () => {
    const { pipeline, calls } = makePipelineWithResponses([
      vote(1),
      vote(0),
      vote(1),
    ]);

    const winnerIndex = await (pipeline as any).judgeWinnerWithLLM(attempts, options);
    const consensus = (pipeline as any).lastConsensusSummary;

    expect(winnerIndex).toBe(1);
    expect(calls).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
    ]);
    expect(consensus.tier3_invoked).toBe(true);
    expect(consensus.valid_votes).toBe(3);
    expect(consensus.agreement_ratio).toBeCloseTo(2 / 3);
    expect(consensus.per_dimension_agreement.correctness.wilson_95_ci.lower).toBeGreaterThanOrEqual(0);
    expect(consensus.small_sample_note).toBe(true);
  });

  it('early-stops when the first two valid models agree', async () => {
    const { pipeline, calls } = makePipelineWithResponses([
      vote(0),
      vote(0),
      vote(1),
    ]);

    const winnerIndex = await (pipeline as any).judgeWinnerWithLLM(attempts, options);
    const consensus = (pipeline as any).lastConsensusSummary;

    expect(winnerIndex).toBe(0);
    expect(calls).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]);
    expect(consensus.early_stopped).toBe(true);
    expect(consensus.tier3_invoked).toBe(false);
  });

  it('disqualifies model votes that omit required dimensions', async () => {
    const { pipeline } = makePipelineWithResponses([
      vote(0, { correctness: 0.9, completeness: 0.9, reliability: 0.9 }),
      vote(1),
      vote(1),
    ]);

    const winnerIndex = await (pipeline as any).judgeWinnerWithLLM(attempts, options);
    const consensus = (pipeline as any).lastConsensusSummary;

    expect(winnerIndex).toBe(1);
    expect(consensus.votes[0].disqualified).toBe(true);
    expect(consensus.votes[0].disqualification_reason).toContain('missing dimensions: safety');
    expect(consensus.valid_votes).toBe(2);
  });
});
