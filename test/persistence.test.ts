import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEngine } from '../src/core/engine-factory';
import { PostgreSQLEngine } from '../src/core/postgres-engine';
import { GAgentPersistenceManager } from '../src/core/gagent-persistence';

describe('GAgent persistence parity', () => {
  it('runs versioned migrations, persists metrics/history, exports JSON, and restores backups', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-persistence-'));
    const dbPath = path.join(dir, 'gagent.db');
    const manager = new GAgentPersistenceManager(dbPath);

    manager.transaction(() => {
      manager.addAgentRun({
        run_id: 'run-1',
        task: 'persist task',
        output: 'ok',
        exit_code: 0,
        cost_usd: 0.012,
        timestamp: '2026-05-15T00:00:00.000Z',
      });
      manager.saveEscalationMetrics({ total_tasks: 1, tier1_count: 1 });
      manager.addLlmCall({
        model_id: 'claude-haiku-4-5',
        input_tokens: 12,
        output_tokens: 4,
        cost_usd: 0.001,
        operation: 'planning',
      });
      manager.addCostEntry({
        operation: 'planning',
        model_id: 'claude-haiku-4-5',
        cost_usd: 0.001,
      });
    });

    const backupPath = manager.backup(path.join(dir, 'backup.db'));
    const exported = manager.exportJson();
    expect(exported.schema_version).toBe(2);
    expect(exported.agent_runs).toHaveLength(1);
    expect(exported.escalation_metrics.total_tasks).toBe(1);
    expect(exported.llm_call_history).toHaveLength(1);
    expect(exported.cost_ledger).toHaveLength(1);
    manager.close();

    const restored = new GAgentPersistenceManager(path.join(dir, 'restored.db'));
    restored.restore(backupPath);
    expect(restored.getAgentRunById('run-1')?.task).toBe('persist task');
    expect(restored.loadEscalationMetrics<{ total_tasks: number }>()?.total_tasks).toBe(1);
    restored.close();
  });

  it('wires the Postgres adapter and read-replica configuration through the engine factory', () => {
    const engine = createEngine({
      type: 'postgres',
      connectionString: 'postgresql://writer/gagent',
      readConnectionString: 'postgresql://reader/gagent',
    });
    expect(engine).toBeInstanceOf(PostgreSQLEngine);
  });
});
