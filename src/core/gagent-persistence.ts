import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { StructuredLogger } from '@gstack/shared/core';

export interface AgentRunRecord {
  run_id: string;
  task: string;
  output: string;
  exit_code: number;
  cost_usd: number;
  timestamp?: string;
  dyad_id?: string | null;
  message_count?: number | null;
}

export interface StoredLlmCall {
  id?: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  operation?: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface StoredCostEntry {
  id?: string;
  operation: string;
  model_id?: string;
  cost_usd: number;
  timestamp?: string;
  metadata?: Record<string, any>;
}

/**
 * SQLite Persistence Manager for GAgent
 *
 * Stores agent run records, escalation metrics, LLM history, and cost ledger rows.
 * Persistence is REQUIRED - fails if better-sqlite3 cannot be loaded.
 */
export class GAgentPersistenceManager {
  private db: any;
  private dbPath: string;
  private readonly SCHEMA_VERSION = 3;
  private logger: StructuredLogger;
  private backupDir: string;
  private backupRetentionCount: number;

  constructor(dbPath?: string) {
    this.logger = new StructuredLogger('gagent-persistence');
    const resolvedPath = dbPath || process.env.GAGENT_DB_PATH || path.join(os.homedir(), '.gagent', 'gagent.db');
    this.dbPath = resolvedPath;
    const dataDir = path.dirname(resolvedPath);
    this.backupDir = process.env.GAGENT_BACKUP_DIR || path.join(dataDir, 'backups');
    this.backupRetentionCount = Math.max(1, Number(process.env.GAGENT_BACKUP_RETENTION || '10'));
    try {
      const Database = require('better-sqlite3');
      fs.mkdirSync(dataDir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.initializeSchema();
    } catch (error) {
      throw new Error(`Persistence is REQUIRED for GAgent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number } | undefined;
    const currentVersion = row?.version || 0;

    if (currentVersion < this.SCHEMA_VERSION) {
      this.runMigrations(currentVersion);
    }

    this.db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      this.SCHEMA_VERSION,
      new Date().toISOString()
    );
  }

  private runMigrations(fromVersion: number): void {
    const migrations = this.loadMigrations();
    for (const migration of migrations) {
      if (migration.version <= fromVersion || migration.version > this.SCHEMA_VERSION) {
        continue;
      }

      this.logger.info(`Running migration ${migration.version}: ${migration.name}`);
      this.db.transaction(() => {
        this.executeStatements(migration.sql);
        this.db.prepare('INSERT OR REPLACE INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          new Date().toISOString()
        );
      })();
    }
  }

  addAgentRun(run: AgentRunRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_runs
      (run_id, task, output, exit_code, cost_usd, timestamp, dyad_id, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.task,
      run.output,
      run.exit_code,
      run.cost_usd,
      run.timestamp || new Date().toISOString(),
      run.dyad_id || null,
      run.message_count ?? null
    );
  }

  getAgentRuns(limit: number = 100): Array<Required<AgentRunRecord>> {
    return this.db.prepare(`
      SELECT run_id, task, output, exit_code, cost_usd, timestamp, dyad_id, message_count
      FROM agent_runs
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<Required<AgentRunRecord>>;
  }

  getAgentRunById(runId: string): Required<AgentRunRecord> | undefined {
    return this.db.prepare(`
      SELECT run_id, task, output, exit_code, cost_usd, timestamp, dyad_id, message_count
      FROM agent_runs
      WHERE run_id = ?
    `).get(runId) as Required<AgentRunRecord> | undefined;
  }

  getAgentRunsInWindow(startTimestamp: string, endTimestamp: string): Array<{
    run_id: string;
    task: string;
    exit_code: number;
    cost_usd: number;
    timestamp: string;
  }> {
    return this.db.prepare(`
      SELECT run_id, task, exit_code, cost_usd, timestamp
      FROM agent_runs
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
    `).all(startTimestamp, endTimestamp) as Array<{
      run_id: string;
      task: string;
      exit_code: number;
      cost_usd: number;
      timestamp: string;
    }>;
  }

  saveEscalationMetrics(metrics: Record<string, any>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO escalation_metrics (key, value_json, updated_at)
      VALUES ('current', ?, ?)
    `).run(JSON.stringify(metrics), new Date().toISOString());
  }

  loadEscalationMetrics<T extends Record<string, any>>(): T | null {
    const row = this.db.prepare(`
      SELECT value_json FROM escalation_metrics WHERE key = 'current'
    `).get() as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }

  addLlmCall(call: StoredLlmCall): string {
    const id = call.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT OR REPLACE INTO llm_call_history
      (id, model_id, input_tokens, output_tokens, cost_usd, operation, timestamp, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      call.model_id,
      call.input_tokens,
      call.output_tokens,
      call.cost_usd,
      call.operation || null,
      call.timestamp || new Date().toISOString(),
      call.metadata ? JSON.stringify(call.metadata) : null
    );
    return id;
  }

  addCostEntry(entry: StoredCostEntry): string {
    const id = entry.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT OR REPLACE INTO cost_ledger
      (id, operation, model_id, cost_usd, timestamp, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.operation,
      entry.model_id || null,
      entry.cost_usd,
      entry.timestamp || new Date().toISOString(),
      entry.metadata ? JSON.stringify(entry.metadata) : null
    );
    return id;
  }

  saveCheckpoint(source: string, lastRowid: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ingestion_checkpoints (source, last_rowid, updated_at)
      VALUES (?, ?, ?)
    `).run(source, lastRowid, new Date().toISOString());
  }

  getCheckpoint(source: string): number | null {
    const row = this.db.prepare(`
      SELECT last_rowid FROM ingestion_checkpoints WHERE source = ?
    `).get(source) as { last_rowid: number } | undefined;
    return row ? row.last_rowid : null;
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  backup(destinationPath?: string): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const backupPath = destinationPath || path.join(
      this.backupDir,
      `gagent-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
    );
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(this.dbPath, backupPath);
    this.rotateBackups();
    return backupPath;
  }

  restore(sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Backup does not exist: ${sourcePath}`);
    }
    this.db.close();
    fs.copyFileSync(sourcePath, this.dbPath);
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initializeSchema();
  }

  exportJson(): Record<string, any> {
    return {
      schema_version: this.SCHEMA_VERSION,
      db_path: this.dbPath,
      exported_at: new Date().toISOString(),
      agent_runs: this.db.prepare('SELECT * FROM agent_runs ORDER BY timestamp DESC').all(),
      escalation_metrics: this.loadEscalationMetrics(),
      llm_call_history: this.db.prepare('SELECT * FROM llm_call_history ORDER BY timestamp DESC').all(),
      cost_ledger: this.db.prepare('SELECT * FROM cost_ledger ORDER BY timestamp DESC').all(),
      ingestion_checkpoints: this.db.prepare('SELECT * FROM ingestion_checkpoints ORDER BY updated_at DESC').all(),
      migrations: this.db.prepare('SELECT * FROM migrations ORDER BY version ASC').all(),
    };
  }

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  private rotateBackups(): void {
    const backups = fs.readdirSync(this.backupDir)
      .filter(name => /^gagent-.+\.db$/.test(name))
      .map(name => path.join(this.backupDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const stale of backups.slice(this.backupRetentionCount)) {
      fs.rmSync(stale, { force: true });
    }
  }

  private loadMigrations(): Array<{ version: number; name: string; sql: string }> {
    const migrationDirCandidates = [
      path.join(__dirname, 'migrations'),
      path.join(process.cwd(), 'src', 'core', 'migrations'),
    ];
    const migrationDir = migrationDirCandidates.find(candidate => fs.existsSync(candidate));
    if (!migrationDir) {
      return this.embeddedMigrations();
    }

    return fs.readdirSync(migrationDir)
      .filter(file => /^\d+_.+\.sql$/.test(file))
      .sort()
      .map(file => {
        const version = Number(file.split('_')[0]);
        return {
          version,
          name: file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
          sql: fs.readFileSync(path.join(migrationDir, file), 'utf8'),
        };
      });
  }

  private executeStatements(sql: string): void {
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/)) {
      const trimmed = statement.trim();
      if (trimmed) {
        try {
          this.db.exec(trimmed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/duplicate column name/i.test(message)) {
            continue;
          }
          throw error;
        }
      }
    }
  }

  private embeddedMigrations(): Array<{ version: number; name: string; sql: string }> {
    return [
      {
        version: 1,
        name: 'initial_schema',
        sql: `
          CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            task TEXT,
            output TEXT,
            exit_code INTEGER,
            cost_usd REAL,
            timestamp TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_agent_runs_timestamp ON agent_runs(timestamp);
        `,
      },
      {
        version: 2,
        name: 'persistent_metrics',
        sql: `
          CREATE TABLE IF NOT EXISTS escalation_metrics (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS llm_call_history (
            id TEXT PRIMARY KEY,
            model_id TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            operation TEXT,
            timestamp TEXT NOT NULL,
            metadata_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_llm_call_history_timestamp ON llm_call_history(timestamp);
          CREATE TABLE IF NOT EXISTS cost_ledger (
            id TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            model_id TEXT,
            cost_usd REAL NOT NULL DEFAULT 0,
            timestamp TEXT NOT NULL,
            metadata_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_timestamp ON cost_ledger(timestamp);
        `,
      },
      {
        version: 3,
        name: 'dyad_schema',
        sql: `
          ALTER TABLE agent_runs ADD COLUMN dyad_id TEXT;
          ALTER TABLE agent_runs ADD COLUMN message_count INTEGER;
          CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
            source TEXT PRIMARY KEY,
            last_rowid INTEGER NOT NULL,
            updated_at TEXT NOT NULL
          );
        `,
      },
    ];
  }
}
