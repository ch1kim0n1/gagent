import { describe, expect, it, beforeEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GBrainIntegrationClient,
  GBrainIntegrationError,
} from '../src/core/gbrain-integration.js';
import { GAgentConfig } from '../src/config/manager.js';
import { Pipeline } from '../src/pipeline/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeConfig(overrides?: Record<string, { enabled: boolean; config?: Record<string, unknown> }>): GAgentConfig {
  const tmpFile = path.join(os.tmpdir(), `gagent-gbrain-test-${Date.now()}-${Math.random()}.json`);
  const configData = {
    version: '0.1.0',
    tools: {
      gbrain: { enabled: true, config: { endpoint: 'http://gbrain.local' } },
      gstack: { enabled: false },
      gorchestrator: { enabled: false },
      gmirror: { enabled: false },
      gtom: { enabled: false },
      glearn: { enabled: false },
      ...overrides,
    },
    integration: { event_bus: 'gbrain', shared_memory: true, cross_tool_sync: true },
    pipeline: { default_parallel: 3, max_parallel: 10, verification_threshold: 0.7, cognitive_check_threshold: 0.6 },
  };
  fs.writeFileSync(tmpFile, JSON.stringify(configData));
  const config = new GAgentConfig({ configPath: tmpFile });
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  return config;
}

describe('GBrainIntegrationClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('sends auth headers and validates health responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
    } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      authToken: 'secret-token',
      maxRetries: 0,
    });

    await expect(client.healthCheck()).resolves.toEqual(expect.objectContaining({ status: 'healthy' }));
    expect(global.fetch).toHaveBeenCalledWith(
      'http://gbrain.local/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('searches GBrain context with response validation', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([{ page_id: 'p1', title: 'Prior task', content: 'Relevant context', tags: ['gagent'] }]),
    } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      maxRetries: 0,
    });

    const pages = await client.searchContext('build dashboard');

    expect(pages).toHaveLength(1);
    expect(pages[0].content).toBe('Relevant context');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pages/search?'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('retries transient page-write failures with backoff', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ page_id: 'page-1' }) } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      maxRetries: 1,
      initialBackoffMs: 1,
    });

    await expect(client.createPage({
      title: 'Pipeline',
      content: '{}',
      tags: ['gagent'],
    })).resolves.toEqual(expect.objectContaining({ page_id: 'page-1' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit breaker after repeated transient failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      maxRetries: 0,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerCooldownMs: 1000,
    });

    await expect(client.healthCheck()).rejects.toBeInstanceOf(GBrainIntegrationError);
    await expect(client.healthCheck()).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('supports MCP tool transport', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: [{ page_id: 'p1', content: 'context' }] }),
    } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      mcpEndpoint: 'http://gbrain.local/mcp',
      mode: 'mcp',
      maxRetries: 0,
    });

    const pages = await client.searchContext('build dashboard');

    expect(pages[0].page_id).toBe('p1');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://gbrain.local/mcp/tools/gbrain.search_pages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('publishes aggregated tool status as a daily GBrain page', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ page_id: 'daily-status' }),
    } as Response);

    const client = new GBrainIntegrationClient({
      endpoint: 'http://gbrain.local',
      maxRetries: 0,
    });

    await expect(client.publishDailyToolStatus({
      date: '2026-05-15',
      status: {
        gstack: { installed: true, healthy: true, score: 100 },
        gmirror: { installed: true, healthy: false, message: 'down', score: 30 },
      },
    })).resolves.toEqual(expect.objectContaining({ page_id: 'daily-status' }));

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.title).toBe('GAgent tool status 2026-05-15');
    expect(body.tags).toEqual(['gagent', 'tool-status', '2026-05-15']);
    expect(JSON.parse(body.content).status.gstack.healthy).toBe(true);
  });
});

describe('GAgent GBrain wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('primes pipeline execution with typed GBrain context', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([{ page_id: 'p1', content: 'prior successful run', tags: ['gagent'] }]),
    } as Response);

    const config = makeConfig();
    const pipeline = new Pipeline(new ToolRegistry(config), config, undefined, undefined, {
      endpoint: 'http://gbrain.local',
      maxRetries: 0,
    });

    const context = await (pipeline as any).primeBrain('build dashboard');

    expect(context[0].content).toBe('prior successful run');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pages/search?'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('registry health publishes daily GBrain tool status without failing health checks', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string, options: RequestInit) => {
      if (String(url).includes('/api/pages')) {
        return { ok: true, status: 200, json: async () => ({ page_id: 'daily-status' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ status: 'healthy' }) } as Response;
    });

    const config = makeConfig();
    const registry = new ToolRegistry(config);

    const health = await registry.healthCheck();

    expect(health.gbrain).toBeDefined();
    expect((global.fetch as jest.Mock).mock.calls.some(call => String(call[0]).includes('/api/pages'))).toBe(true);
  });
});
