import { describe, it, expect, beforeEach } from '@jest/globals';
import { ToolRegistry } from '../src/tools/registry';
import { GAgentConfig } from '../src/config/manager';
import path from 'path';
import os from 'os';

function makeConfig(): GAgentConfig {
  const nonExistent = path.join(os.tmpdir(), `gagent-registry-test-${Date.now()}.json`);
  return new GAgentConfig({ configPath: nonExistent });
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry(makeConfig());
  });

  it('listTools returns an empty array initially', () => {
    const tools = registry.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(0);
  });

  it('register and listTools shows registered tool', () => {
    registry.register('test-tool', {
      name: 'test-tool',
      description: 'A test tool',
      enabled: true,
      endpoint: 'http://localhost:9999',
    });
    const tools = registry.listTools();
    expect(tools.some(t => t.name === 'test-tool')).toBe(true);
  });

  it('listTools returns all registered tools', () => {
    registry.register('tool-a', {
      name: 'tool-a',
      description: 'Tool A',
      enabled: true,
      endpoint: 'http://localhost:9001',
    });
    registry.register('tool-b', {
      name: 'tool-b',
      description: 'Tool B',
      enabled: false,
      endpoint: 'http://localhost:9002',
    });
    const tools = registry.listTools();
    expect(tools.length).toBe(2);
  });

  it('isAvailable returns true for a registered enabled tool', () => {
    registry.register('available-tool', {
      name: 'available-tool',
      description: 'Available',
      enabled: true,
      endpoint: 'http://localhost:9999',
    });
    expect(registry.isAvailable('available-tool')).toBe(true);
  });

  it('isAvailable returns false for a disabled tool', () => {
    registry.register('disabled-tool', {
      name: 'disabled-tool',
      description: 'Disabled',
      enabled: false,
      endpoint: 'http://localhost:9999',
    });
    expect(registry.isAvailable('disabled-tool')).toBe(false);
  });

  it('isAvailable returns false for unknown tool', () => {
    expect(registry.isAvailable('nonexistent')).toBe(false);
  });

  it('re-registering a tool overwrites existing entry', () => {
    registry.register('my-tool', {
      name: 'my-tool',
      description: 'First',
      enabled: true,
      endpoint: 'http://localhost:1111',
    });
    registry.register('my-tool', {
      name: 'my-tool',
      description: 'Updated',
      enabled: false,
      endpoint: 'http://localhost:2222',
    });
    const tools = registry.listTools();
    expect(tools.length).toBe(1);
    expect(registry.isAvailable('my-tool')).toBe(false);
  });

  it('getRegisteredInfo returns the registered tool info', () => {
    registry.register('info-tool', {
      name: 'info-tool',
      description: 'Info tool',
      enabled: true,
      endpoint: 'http://localhost:5555',
    });
    const info = registry.getRegisteredInfo('info-tool');
    expect(info).toBeDefined();
    expect(info?.endpoint).toBe('http://localhost:5555');
    expect(info?.description).toBe('Info tool');
  });

  it('getRegisteredInfo returns undefined for unknown tool', () => {
    const info = registry.getRegisteredInfo('ghost');
    expect(info).toBeUndefined();
  });

  it('getEnabledTools uses config, not registered tools', () => {
    // getEnabledTools reads from GAgentConfig, not the registered map
    const enabledTools = registry.getEnabledTools();
    expect(Array.isArray(enabledTools)).toBe(true);
    // default config has all disabled
    expect(enabledTools.length).toBe(0);
  });
});
