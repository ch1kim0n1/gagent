import { describe, it, expect, beforeEach } from '@jest/globals';
import { Pipeline } from '../src/pipeline/orchestrator';
import { ToolRegistry } from '../src/tools/registry';
import { GAgentConfig } from '../src/config/manager';
import path from 'path';
import fs from 'fs';
import os from 'os';

function makeConfig(overrides?: Record<string, { enabled: boolean }>): GAgentConfig {
  const tmpFile = path.join(os.tmpdir(), `gagent-pipeline-test-${Date.now()}-${Math.random()}.json`);
  const tools: Record<string, { enabled: boolean }> = {
    gbrain: { enabled: false },
    gstack: { enabled: true },
    gorchestrator: { enabled: false },
    gmirror: { enabled: false },
    gtom: { enabled: false },
    glearn: { enabled: false },
    ...overrides,
  };
  const configData = {
    version: '0.1.0',
    tools,
    integration: { event_bus: 'gbrain', shared_memory: true, cross_tool_sync: true },
    pipeline: { default_parallel: 3, max_parallel: 10, verification_threshold: 0.7, cognitive_check_threshold: 0.6 },
  };
  fs.writeFileSync(tmpFile, JSON.stringify(configData));
  const config = new GAgentConfig({ configPath: tmpFile });
  // Clean up temp file
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  return config;
}

describe('Pipeline', () => {
  let pipeline: Pipeline;
  let registry: ToolRegistry;
  let config: GAgentConfig;

  beforeEach(() => {
    config = makeConfig();
    registry = new ToolRegistry(config);
    pipeline = new Pipeline(registry, config);
  });

  it('describe() returns a non-empty string', () => {
    const plan = pipeline.describe({
      task: 'Build a login page',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(typeof plan).toBe('string');
    expect(plan.length).toBeGreaterThan(0);
  });

  it('describe() contains GStack for single execution', () => {
    const plan = pipeline.describe({
      task: 'Single task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(plan).toContain('GStack');
  });

  it('describe() mentions GOrchestrator when parallel > 1', () => {
    const plan = pipeline.describe({
      task: 'Parallel task',
      parallel: 3,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(plan).toContain('GOrchestrator');
  });

  it('describe() mentions GMirror when verify is true', () => {
    const plan = pipeline.describe({
      task: 'Verified task',
      parallel: 1,
      verify: true,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(plan).toContain('GMirror');
  });

  it('describe() mentions GToM when cognitiveCheck is true', () => {
    const plan = pipeline.describe({
      task: 'Cognitive task',
      parallel: 1,
      verify: false,
      cognitiveCheck: true,
      learn: false,
      dryRun: false,
    });
    expect(plan).toContain('GToM');
  });

  it('describe() mentions GLearn when learn is true', () => {
    const plan = pipeline.describe({
      task: 'Learning task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: true,
      dryRun: false,
    });
    expect(plan).toContain('GLearn');
  });

  it('describe() does NOT mention GOrchestrator for parallel=1', () => {
    const plan = pipeline.describe({
      task: 'Single task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(plan).not.toContain('GOrchestrator');
  });

  it('describe() always contains GBrain priming step', () => {
    const plan = pipeline.describe({
      task: 'Any task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(plan).toContain('GBrain');
  });

  it('execute() returns an object with success field', async () => {
    // In test env, exec calls fail since tools aren't installed.
    // Verify graceful error handling — execute() has outer try/catch.
    const result = await pipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    expect(typeof result.success).toBe('boolean');
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it('execute() returns success:false with error when all tools disabled', async () => {
    const disabledConfig = makeConfig({
      gbrain: { enabled: false },
      gstack: { enabled: false },
      gorchestrator: { enabled: false },
    });
    const disabledRegistry = new ToolRegistry(disabledConfig);
    const disabledPipeline = new Pipeline(disabledRegistry, disabledConfig);

    const result = await disabledPipeline.execute({
      task: 'Test task',
      parallel: 1,
      verify: false,
      cognitiveCheck: false,
      learn: false,
      dryRun: false,
    });
    // runSingle throws 'GStack not enabled' which is caught by outer try/catch
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
