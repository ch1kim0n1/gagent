import { DyadAnalysisHandler } from '../src/handlers/dyad-analysis-handler';
import { DyadAnalysisTask } from '../src/types';

const messages = Array.from({ length: 10 }, (_, index) => ({
  rowid: index + 1,
  text: `redacted message ${index + 1}`,
  participant_id: index % 2 === 0 ? 'a'.repeat(16) : 'b'.repeat(16),
  timestamp: `2026-05-15T00:00:${String(index).padStart(2, '0')}.000Z`,
}));

function task(overrides: Partial<DyadAnalysisTask> = {}): DyadAnalysisTask {
  return {
    task: 'analyze_relationship_window',
    parameters: {
      dyad_id: 'abcdef0123456789',
      message_window: messages,
      detectors: ['emotion_labeling', 'bid_classification'],
      time_range: {
        start: '2026-05-15T00:00:00.000Z',
        end: '2026-05-15T00:10:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('DyadAnalysisHandler', () => {
  it('runs each requested detector and sums costs', async () => {
    const llm = {
      call: jest.fn()
        .mockResolvedValueOnce({ content: '{"should_refuse":false,"confidence":0.9,"explanation":"ok"}', model_id: 'gpt-test', cost_usd: 0.001, latency_ms: 1, input_tokens: 1, output_tokens: 1 })
        .mockResolvedValueOnce({ content: '{"result":{"emotion":"sad"},"confidence":0.8}', model_id: 'gpt-test', cost_usd: 0.002, latency_ms: 2, input_tokens: 1, output_tokens: 1 })
        .mockResolvedValueOnce({ content: '{"result":{"bid":"toward"},"confidence":0.7}', model_id: 'gpt-test', cost_usd: 0.003, latency_ms: 3, input_tokens: 1, output_tokens: 1 }),
    };

    const result = await new DyadAnalysisHandler(llm as any).execute(task());

    expect(llm.call).toHaveBeenCalledTimes(3);
    expect(result.detector_results).toHaveLength(2);
    expect(result.cost_usd).toBeCloseTo(0.005);
    expect(result.partial_result).toBeUndefined();
  });

  it('returns early when the refusal classifier fires', async () => {
    const llm = {
      call: jest.fn().mockResolvedValueOnce({
        content: '{"should_refuse":true,"reason":"insufficient_data","confidence":0.95,"explanation":"too little data"}',
        model_id: 'gpt-test',
        cost_usd: 0.001,
        latency_ms: 1,
        input_tokens: 1,
        output_tokens: 1,
      }),
    };

    const result = await new DyadAnalysisHandler(llm as any).execute(task());

    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(result.ethical_refusal?.should_refuse).toBe(true);
    expect(result.detector_results).toHaveLength(0);
  });

  it('returns partial detector results when the cost hard gate is exceeded', async () => {
    const llm = {
      call: jest.fn()
        .mockResolvedValueOnce({ content: '{"should_refuse":false,"confidence":0.9,"explanation":"ok"}', model_id: 'gpt-test', cost_usd: 0, latency_ms: 1, input_tokens: 1, output_tokens: 1 })
        .mockResolvedValueOnce({ content: '{"result":{"emotion":"sad"},"confidence":0.8}', model_id: 'gpt-test', cost_usd: 0.02, latency_ms: 2, input_tokens: 1, output_tokens: 1 }),
    };

    const result = await new DyadAnalysisHandler(llm as any).execute(task({
      budget: { max_cost_usd: 0.01, max_latency_ms: 1000 },
    }));

    expect(result.partial_result).toBe(true);
    expect(result.detector_results).toHaveLength(1);
    expect(result.budget_error?.actual_cost_usd).toBe(0.02);
  });
});

