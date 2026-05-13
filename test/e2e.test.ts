// gagent/test/e2e.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { GAgentConfig } from '../src/config/manager';
import { ToolRegistry } from '../src/tools/registry';
import { Pipeline } from '../src/pipeline/orchestrator';
import path from 'path';
import os from 'os';

describe('GAgent E2E (mocked)', () => {
  let config: GAgentConfig;
  let registry: ToolRegistry;
  let pipeline: Pipeline;

  beforeEach(() => {
    const tmpFile = path.join(os.tmpdir(), `gagent-e2e-${Date.now()}.json`);
    config = new GAgentConfig({ configPath: tmpFile });
    registry = new ToolRegistry(config);
    pipeline = new Pipeline(registry, config);
  });

  it('initializes config and pipeline', () => {
    expect(config).toBeDefined();
    expect(pipeline).toBeDefined();
  });

  it('config has expected structure', () => {
    const raw = config.getRaw();
    expect(raw).toBeDefined();
    expect(raw.version).toBeDefined();
    expect(raw.tools).toBeDefined();
  });

  it('registry is initialized', () => {
    expect(registry).toBeDefined();
  });
});
