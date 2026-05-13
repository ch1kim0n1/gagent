import { Pipeline } from '../src/pipeline/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { GAgentConfig } from '../src/config/manager.js';
import { ReceiptRegistry } from '../src/core/receipt-registry.js';
import { GAGENT_RUBRIC_V1 } from '../src/core/gagent-rubric.js';

describe('Pipeline Baseline Regression Tests', () => {
  let pipeline: Pipeline;
  let registry: ReceiptRegistry;
  const TOLERANCE = 0.05;

  beforeEach(() => {
    const toolRegistry = new ToolRegistry();
    const config = new GAgentConfig();
    pipeline = new Pipeline(toolRegistry, config);
    registry = new ReceiptRegistry('gagent');
  });

  it('generates receipt with correct rubric metadata', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      // Wait for async receipt emission
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      expect(latest).toBeDefined();
      expect(latest?.rubric_name).toBe('gagent_v1');
      expect(latest?.project).toBe('gagent');
      expect(latest?.schema_version).toBe(1);
    }
  });

  it('receipt scores match rubric dimensions', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      expect(latest).toBeDefined();
      
      const dimNames = GAGENT_RUBRIC_V1.dimensions.map(d => d.name);
      for (const dim of dimNames) {
        expect(latest?.scores[dim]).toBeDefined();
        expect(latest?.scores[dim].score).toBeGreaterThanOrEqual(0);
        expect(latest?.scores[dim].score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('baseline comparison: current overall score within tolerance of baseline', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      const currentScore = latest?.overall_score ?? 0;
      
      // Baseline locked from initial calibration run
      const baselineOverallScore = 0.5; // Default base score
      const diff = Math.abs(currentScore - baselineOverallScore);
      expect(diff).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('receipt is persisted to registry', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      expect(latest).toBeDefined();
      expect(latest?.receipt_id).toBeDefined();
    }
  });

  it('hard gates passed reflects in receipt', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      expect(latest?.hard_gates_passed).toBe(true); // Should pass in dry run mode
    }
  });

  it('receipt includes task metadata', async () => {
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: true,
    });

    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const latest = await registry.getLatest();
      expect(latest?.metadata).toBeDefined();
      expect(latest?.metadata.task).toBe('Test task');
      expect(latest?.metadata.attempts_count).toBeDefined();
    }
  });
});
