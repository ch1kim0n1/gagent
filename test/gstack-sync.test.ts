import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ToolRegistry } from '../src/tools/registry';
import { GAgentConfig } from '../src/config/manager';

describe('GStack/GBrain sync', () => {
  let root: string;
  let config: GAgentConfig;
  let registry: ToolRegistry;
  let execSafe: jest.Mock;
  const tools = ['gbrain', 'gstack', 'gorchestrator', 'gmirror', 'gtom', 'glearn'];

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'gagent-gstack-sync-'));
    process.env.GAGENT_SYNC_ROOT = path.join(root, 'sync');
    config = new GAgentConfig({ configPath: path.join(root, 'config.json') });

    for (const tool of tools) {
      const toolPath = path.join(root, tool);
      mkdirSync(toolPath, { recursive: true });
      await config.set(`tools.${tool}.enabled`, true);
      await config.set(`tools.${tool}.path`, toolPath);
    }

    registry = new ToolRegistry(config);
    execSafe = jest.fn(async () => ({ stdout: '', stderr: '' }));
    (registry as any).execSafe = execSafe;
  });

  afterEach(() => {
    delete process.env.GAGENT_SYNC_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('adds the tools stage with pathhash8 source IDs and .gbrain-source attachments', async () => {
    const result = await registry.syncAll({ mode: 'full' });
    const toolsStage = result.stages.find(stage => stage.stage === 'tools');

    expect(result.status).toBe('ok');
    expect(toolsStage).toBeDefined();
    expect(toolsStage?.status).toBe('ok');
    expect(toolsStage?.items_total).toBe(tools.length);
    expect(toolsStage?.items_changed).toBe(tools.length);

    for (const tool of tools) {
      const dotfile = path.join(root, tool, '.gbrain-source');
      const source = JSON.parse(readFileSync(dotfile, 'utf8'));
      expect(source.tool).toBe(tool);
      expect(source.federated).toBe(true);
      expect(source.pathhash8).toMatch(/^[a-f0-9]{8}$/);
      expect(source.id).toBe(`gagent-${tool}-${source.pathhash8}`);
      expect(execSafe).toHaveBeenCalledWith('gbrain', ['sources', 'add', source.id, '--federated']);
    }

    expect(execSafe).toHaveBeenCalledWith('gbrain', ['sync']);
  });

  it('does not write files or run commands during dry-run sync', async () => {
    const result = await registry.syncAll({ mode: 'full', dryRun: true });

    expect(result.status).toBe('ok');
    expect(result.dry_run).toBe(true);
    expect(execSafe).not.toHaveBeenCalled();
    expect(result.stages.find(stage => stage.stage === 'tools')?.details?.commands.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expect(() => readFileSync(path.join(root, tool, '.gbrain-source'), 'utf8')).toThrow();
    }
  });

  it('cleans up legacy source IDs during full sync', async () => {
    const syncRoot = path.join(root, 'sync');
    const statePath = path.join(syncRoot, 'gstack-gbrain-sync-state.json');
    mkdirSync(syncRoot, { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      mode: 'incremental',
      sources: {
        gstack: {
          tool: 'gstack',
          id: 'legacy-gstack-source',
          path: path.join(root, 'gstack'),
          pathhash8: 'legacy',
          federated: true,
          dotfile_path: path.join(root, 'gstack', '.gbrain-source'),
          updated_at: new Date().toISOString(),
        },
      },
    }));

    const result = await registry.syncAll({ mode: 'full' });
    expect(result.stages.find(stage => stage.stage === 'tools')?.details?.legacy_cleanup).toContain('legacy-gstack-source');
    expect(execSafe).toHaveBeenCalledWith('gbrain', ['sources', 'remove', 'legacy-gstack-source']);
  });

  it('rejects active locks and takes over stale locks', async () => {
    const syncRoot = path.join(root, 'sync');
    const lockPath = path.join(syncRoot, 'gstack-gbrain-sync.lock');
    mkdirSync(syncRoot, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 1, created_at: new Date().toISOString() }));

    const locked = await registry.syncAll({ mode: 'incremental', lockTimeoutMs: 60_000 });
    expect(locked.status).toBe('error');
    expect(locked.stages[0].stage).toBe('lock');

    const stale = await registry.syncAll({ mode: 'incremental', lockTimeoutMs: 0 });
    expect(stale.status).toBe('ok');
  });
});
