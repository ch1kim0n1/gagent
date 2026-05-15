import { describe, it, expect, beforeEach } from '@jest/globals';
import { GAgentConfig } from '../src/config/manager';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('GAgentConfig', () => {
  it('loads defaults when no config file exists', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}-nonexistent.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    expect(config).toBeDefined();
    const raw = config.getRaw();
    expect(raw).toBeDefined();
    expect(raw.version).toBe('0.1.0');
  });

  it('isToolEnabled returns false for gbrain by default', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    // Default config has all tools disabled
    expect(config.isToolEnabled('gbrain')).toBe(false);
  });

  it('isToolEnabled returns true after enabling a tool', async () => {
    const tmpFile = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const configData = {
      version: '0.1.0',
      tools: {
        gbrain: { enabled: true },
        gstack: { enabled: false },
        gorchestrator: { enabled: false },
        gmirror: { enabled: false },
        gtom: { enabled: false },
        glearn: { enabled: false },
      },
      integration: {
        event_bus: 'gbrain',
        shared_memory: true,
        cross_tool_sync: true,
      },
      pipeline: {
        default_parallel: 3,
        max_parallel: 10,
        verification_threshold: 0.7,
        cognitive_check_threshold: 0.6,
      },
    };
    fs.writeFileSync(tmpFile, JSON.stringify(configData));
    try {
      const config = new GAgentConfig({ configPath: tmpFile });
      expect(config.isToolEnabled('gbrain')).toBe(true);
      expect(config.isToolEnabled('gstack')).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('isToolEnabled returns false for unknown tool', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    expect(config.isToolEnabled('nonexistent-tool')).toBe(false);
  });

  it('get() returns nested config values', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    expect(config.get('pipeline.default_parallel')).toBe(3);
    expect(config.get('pipeline.max_parallel')).toBe(10);
    expect(config.get('integration.shared_memory')).toBe(true);
  });

  it('set() and get() round-trip a value', async () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    await config.set('pipeline.default_parallel', 5);
    expect(config.get('pipeline.default_parallel')).toBe(5);
  });

  it('getToolPath returns undefined for tool without path', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    expect(config.getToolPath('gbrain')).toBeUndefined();
  });

  it('view() returns valid JSON string', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    const viewed = config.view();
    expect(typeof viewed).toBe('string');
    const parsed = JSON.parse(viewed);
    expect(parsed.version).toBe('0.1.0');
  });

  it('getRaw() returns the full config object', () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    const raw = config.getRaw();
    expect(raw.tools).toBeDefined();
    expect(raw.integration).toBeDefined();
    expect(raw.pipeline).toBeDefined();
  });

  it('getEnabledTools returns empty array by default', async () => {
    const nonExistent = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    const config = new GAgentConfig({ configPath: nonExistent });
    const raw = config.getRaw();
    const enabledTools = Object.entries(raw.tools)
      .filter(([_, info]) => info.enabled)
      .map(([name]) => name);
    expect(enabledTools).toEqual([]);
  });

  it('falls back to defaults on malformed config file', () => {
    const tmpFile = path.join(os.tmpdir(), `gagent-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, 'not valid json {{{');
    try {
      const config = new GAgentConfig({ configPath: tmpFile });
      const raw = config.getRaw();
      expect(raw.version).toBe('0.1.0');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
