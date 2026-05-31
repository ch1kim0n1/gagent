import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { StructuredLogger } from './logger.js';

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
 * Open a SQLite database. Prefers `better-sqlite3` (Node).
 * Falls back to `bun:sqlite` when running under Bun (e.g. `bun test`).
 *
 * When NEITHER native driver can be loaded — for example in the PyPI/pip
 * distribution, which bundles the JS but cannot ship a compiled native addon
 * (no MSVC / build toolchain) — `openDatabase` returns a volatile, pure-JS
 * in-memory shim that implements the same minimal statement surface this
 * module relies on. This lets persistence-backed commands (`health`, `run`,
 * `receipts`, …) run to completion instead of throwing on a missing binding.
 * The data is non-durable (process lifetime only).
 *
 * Set `GAGENT_REQUIRE_SQLITE=1` to disable the fallback and restore the
 * historical hard-fail behavior when durable persistence is mandatory.
 */
function openDatabase(dbPath: string): any {
  // Try better-sqlite3 first (Node path)
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (betterErr) {
    // Fall through to bun:sqlite
    try {
      // bun:sqlite is only resolvable under the Bun runtime; require dynamically
      // so a Node/tsc build does not need its type declarations. The Node path
      // (better-sqlite3) above is canonical.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Database } = require('bun:sqlite') as { Database: new (path: string) => any };
      const bunDb = new Database(dbPath);
      return {
        exec: (sql: string) => bunDb.exec(sql),
        prepare: (sql: string) => {
          const stmt = bunDb.prepare(sql);
          return {
            get: (...args: any[]) => stmt.get(...args),
            all: (...args: any[]) => stmt.all(...args),
            run: (...args: any[]) => stmt.run(...args),
          };
        },
        pragma: (s: string) => {
          // better-sqlite3 returns rows from pragma; bun:sqlite uses prepare().all().
          // Some pragmas (e.g. wal_checkpoint(TRUNCATE)) may fail under exec but
          // succeed under prepare/all; only fall back if prepare itself errors.
          try {
            const stmt = bunDb.prepare(`PRAGMA ${s};`);
            try { return stmt.all(); } catch { return stmt.run(); }
          } catch {
            // Last-resort: try exec but don't throw; pragma is best-effort.
            try { bunDb.exec(`PRAGMA ${s};`); } catch { /* ignore */ }
            return undefined;
          }
        },
        transaction: (fn: (...args: any[]) => any) => (...args: any[]) => {
          bunDb.exec('BEGIN');
          try {
            const result = fn(...args);
            bunDb.exec('COMMIT');
            return result;
          } catch (e) {
            bunDb.exec('ROLLBACK');
            throw e;
          }
        },
        close: () => bunDb.close(),
      };
    } catch (_bunErr) {
      // Neither native driver loaded. Honor the explicit hard-fail opt-in.
      if (process.env.GAGENT_REQUIRE_SQLITE === '1') {
        throw betterErr;
      }
      // Graceful degradation: use a volatile in-memory shim so the CLI keeps
      // working without a native binding (e.g. the pip-installed bundle).
      return new InMemoryDatabase();
    }
  }
}

/**
 * Volatile, dependency-free fallback used when no native SQLite driver
 * (better-sqlite3 / bun:sqlite) can be loaded.
 *
 * It is NOT a general SQL engine. It implements only the fixed set of
 * statements GAgentPersistenceManager issues, matched by a stable substring of
 * each (whitespace-normalized) SQL string. Data lives only for the process
 * lifetime, which is acceptable for the pip-installed bundle where the native
 * engine is absent. Durable SQLite remains fully unchanged when a native driver
 * IS available — this class is never constructed in that case.
 */
class InMemoryDatabase {
  private tables: {
    schema_version: Array<{ version: number; applied_at: string }>;
    migrations: Array<{ version: number; name: string; applied_at: string }>;
    agent_runs: any[];
    escalation_metrics: Array<{ key: string; value_json: string; updated_at: string }>;
    llm_call_history: any[];
    cost_ledger: any[];
    ingestion_checkpoints: Array<{ source: string; last_rowid: number; updated_at: string }>;
  } = {
    schema_version: [],
    migrations: [],
    agent_runs: [],
    escalation_metrics: [],
    llm_call_history: [],
    cost_ledger: [],
    ingestion_checkpoints: [],
  };

  /** Marker so the manager can detect the volatile fallback. */
  public readonly __inMemory = true;

  /** Snapshot every table (used to serialize a JSON backup). */
  dumpTables(): Record<string, any[]> {
    return JSON.parse(JSON.stringify(this.tables));
  }

  /** Replace table contents from a snapshot (used to restore a JSON backup). */
  loadTables(snapshot: Record<string, any[]>): void {
    for (const key of Object.keys(this.tables) as Array<keyof typeof this.tables>) {
      if (Array.isArray(snapshot[key])) {
        (this.tables[key] as any[]) = snapshot[key];
      }
    }
  }

  pragma(_directive: string): any {
    // No-op: journaling / foreign-key / wal_checkpoint pragmas are meaningless
    // in memory. Return undefined to mirror best-effort pragma semantics.
    return undefined;
  }

  exec(_sql: string): void {
    // DDL (CREATE TABLE/INDEX, ALTER TABLE) is a no-op; tables already exist as
    // typed arrays above.
  }

  transaction<T>(operation: (...args: any[]) => T): (...args: any[]) => T {
    // No real atomicity guarantees, but preserves the call signature so
    // `db.transaction(fn)()` works exactly as the native driver expects.
    return (...args: any[]) => operation(...args);
  }

  close(): void {
    // Nothing to release.
  }

  prepare(sql: string): {
    run: (...params: any[]) => { changes: number };
    get: (...params: any[]) => any;
    all: (...params: any[]) => any[];
  } {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const tables = this.tables;

    const upsert = (table: any[], keyField: string, row: Record<string, any>) => {
      const idx = table.findIndex((r) => r[keyField] === row[keyField]);
      if (idx >= 0) table[idx] = row;
      else table.push(row);
    };
    const byTimestampDesc = (rows: any[], field = 'timestamp') =>
      [...rows].sort((a, b) => String(b[field]).localeCompare(String(a[field])));

    return {
      run: (...params: any[]) => {
        if (norm.includes('INSERT OR REPLACE INTO schema_version')) {
          upsert(tables.schema_version, 'version', { version: params[0], applied_at: params[1] });
        } else if (norm.includes('INSERT OR REPLACE INTO migrations') || norm.includes('INSERT INTO migrations')) {
          upsert(tables.migrations, 'version', { version: params[0], name: params[1], applied_at: params[2] });
        } else if (norm.includes('INSERT OR REPLACE INTO agent_runs')) {
          upsert(tables.agent_runs, 'run_id', {
            run_id: params[0], task: params[1], output: params[2], exit_code: params[3],
            cost_usd: params[4], timestamp: params[5], dyad_id: params[6], message_count: params[7],
          });
        } else if (norm.includes('INSERT OR REPLACE INTO escalation_metrics')) {
          upsert(tables.escalation_metrics, 'key', { key: 'current', value_json: params[0], updated_at: params[1] });
        } else if (norm.includes('INSERT OR REPLACE INTO llm_call_history')) {
          upsert(tables.llm_call_history, 'id', {
            id: params[0], model_id: params[1], input_tokens: params[2], output_tokens: params[3],
            cost_usd: params[4], operation: params[5], timestamp: params[6], metadata_json: params[7],
          });
        } else if (norm.includes('INSERT OR REPLACE INTO cost_ledger')) {
          upsert(tables.cost_ledger, 'id', {
            id: params[0], operation: params[1], model_id: params[2], cost_usd: params[3],
            timestamp: params[4], metadata_json: params[5],
          });
        } else if (norm.includes('INSERT OR REPLACE INTO ingestion_checkpoints')) {
          upsert(tables.ingestion_checkpoints, 'source', { source: params[0], last_rowid: params[1], updated_at: params[2] });
        }
        return { changes: 1 };
      },
      get: (...params: any[]) => {
        if (norm.includes('MAX(version) AS version FROM schema_version')) {
          return tables.schema_version.length
            ? { version: Math.max(...tables.schema_version.map((r) => r.version)) }
            : { version: null };
        }
        if (norm.includes('value_json FROM escalation_metrics')) {
          const row = tables.escalation_metrics.find((r) => r.key === 'current');
          return row ? { value_json: row.value_json } : undefined;
        }
        if (norm.includes('FROM agent_runs') && norm.includes('WHERE run_id = ?')) {
          return tables.agent_runs.find((r) => r.run_id === params[0]) || undefined;
        }
        if (norm.includes('last_rowid FROM ingestion_checkpoints')) {
          const row = tables.ingestion_checkpoints.find((r) => r.source === params[0]);
          return row ? { last_rowid: row.last_rowid } : undefined;
        }
        return undefined;
      },
      all: (...params: any[]) => {
        if (norm.includes('FROM agent_runs')) {
          if (norm.includes('WHERE timestamp >= ? AND timestamp <= ?')) {
            return byTimestampDesc(tables.agent_runs)
              .filter((r) => r.timestamp >= params[0] && r.timestamp <= params[1])
              .map((r) => ({
                run_id: r.run_id, task: r.task, exit_code: r.exit_code, cost_usd: r.cost_usd, timestamp: r.timestamp,
              }));
          }
          const rows = byTimestampDesc(tables.agent_runs);
          if (norm.includes('LIMIT ?')) {
            return rows.slice(0, params[0]).map((r) => ({
              run_id: r.run_id, task: r.task, output: r.output, exit_code: r.exit_code,
              cost_usd: r.cost_usd, timestamp: r.timestamp, dyad_id: r.dyad_id, message_count: r.message_count,
            }));
          }
          return rows; // SELECT * for export
        }
        if (norm.includes('FROM llm_call_history')) return byTimestampDesc(tables.llm_call_history);
        if (norm.includes('FROM cost_ledger')) return byTimestampDesc(tables.cost_ledger);
        if (norm.includes('FROM ingestion_checkpoints')) return byTimestampDesc(tables.ingestion_checkpoints, 'updated_at');
        if (norm.includes('FROM migrations')) {
          return [...tables.migrations].sort((a, b) => a.version - b.version);
        }
        return [];
      },
    };
  }
}

/**
 * SQLite Persistence Manager for GAgent
 *
 * Stores agent run records, escalation metrics, LLM history, and cost ledger rows.
 * Persistence is REQUIRED - fails if no SQLite driver can be loaded.
 */
export class GAgentPersistenceManager {
  private db: any;
  private dbPath: string;
  private readonly SCHEMA_VERSION = 3;
  private logger: StructuredLogger;
  private backupDir: string;
  private backupRetentionCount: number;
  /** True when running on the volatile in-memory fallback (no native SQLite). */
  public readonly inMemory: boolean = false;

  constructor(dbPath?: string) {
    this.logger = new StructuredLogger('gagent-persistence');
    const resolvedPath = dbPath || process.env.GAGENT_DB_PATH || path.join(os.homedir(), '.gagent', 'gagent.db');
    this.dbPath = resolvedPath;
    const dataDir = path.dirname(resolvedPath);
    this.backupDir = process.env.GAGENT_BACKUP_DIR || path.join(dataDir, 'backups');
    this.backupRetentionCount = Math.max(1, Number(process.env.GAGENT_BACKUP_RETENTION || '10'));
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.db = openDatabase(this.dbPath);
      // openDatabase returns an InMemoryDatabase shim when no native SQLite
      // driver could be loaded (and GAGENT_REQUIRE_SQLITE !== '1').
      (this as { inMemory: boolean }).inMemory = this.db?.__inMemory === true;
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

  /**
   * Get current schema version from database
   */
  getCurrentSchemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number } | undefined;
    return row?.version || 0;
  }

  /**
   * Run migrations to a specific target version
   * @deprecated Use automatic migrations in initializeSchema instead
   */
  async runMigrationsTo(targetVersion: number): Promise<void> {
    const currentVersion = this.getCurrentSchemaVersion();
    if (targetVersion <= currentVersion) {
      this.logger.info(`Schema already at version ${currentVersion}, no migration needed`);
      return;
    }

    if (targetVersion > this.SCHEMA_VERSION) {
      throw new Error(`Target version ${targetVersion} exceeds maximum supported version ${this.SCHEMA_VERSION}`);
    }

    this.logger.info(`Migrating from schema version ${currentVersion} to ${targetVersion}`);
    this.runMigrations(currentVersion);
    this.logger.info('Migration completed successfully');
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
    if (this.inMemory) {
      // No native DB file to copy; serialize the volatile in-memory state to a
      // JSON artifact so the backup command still produces something usable.
      const backupPath = destinationPath || path.join(
        this.backupDir,
        `gagent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      );
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, JSON.stringify({
        schema_version: this.SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        tables: this.db.dumpTables(),
      }, null, 2));
      return backupPath;
    }
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
    if (this.inMemory) {
      // Restore a JSON backup into the in-memory store. If the backup is a
      // native .db file (created on a host that had better-sqlite3) we cannot
      // read it here, so accept only JSON snapshots in fallback mode.
      const snapshot = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      this.db.loadTables(snapshot.tables || {});
      return;
    }
    this.db.close();
    // Remove the existing DB file and any stale WAL/SHM sidecar files left by
    // the previous connection; otherwise reopening (especially under bun:sqlite)
    // may surface stale state or surface disk-I/O errors.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stale = `${this.dbPath}${suffix}`;
      if (fs.existsSync(stale)) {
        try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ }
      }
    }
    fs.copyFileSync(sourcePath, this.dbPath);
    this.db = openDatabase(this.dbPath);
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
