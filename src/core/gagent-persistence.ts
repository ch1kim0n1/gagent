import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StructuredLogger } from '../../../shared/src/observability/structured-logger.js';

/**
 * SQLite Persistence Manager for GAgent
 *
 * Stores agent run records in a local SQLite database.
 * Persistence is REQUIRED - fails if better-sqlite3 cannot be loaded.
 */
export class GAgentPersistenceManager {
  private db: any;
  private dbPath: string;
  private readonly SCHEMA_VERSION = 1;
  private logger: StructuredLogger;

  constructor(dbPath?: string) {
    this.logger = new StructuredLogger('gagent-persistence');
    const resolvedPath = dbPath || path.join(os.homedir(), '.gagent', 'gagent.db');
    this.dbPath = resolvedPath;
    const dataDir = path.dirname(resolvedPath);
    try {
      const Database = require('better-sqlite3');
      fs.mkdirSync(dataDir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.initializeSchema();
    } catch (error) {
      throw new Error('Persistence is REQUIRED for GAgent.');
    }
  }

  private initializeSchema(): void {
    // Schema versioning table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    // Check current schema version
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    const currentVersion = row?.version || 0;

    if (currentVersion < this.SCHEMA_VERSION) {
      this.runMigrations(currentVersion);
    }

    // Agent runs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        task TEXT,
        output TEXT,
        exit_code INTEGER,
        cost_usd REAL,
        timestamp TEXT
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_timestamp ON agent_runs(timestamp)`);

    // Update schema version
    this.db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      this.SCHEMA_VERSION,
      new Date().toISOString()
    );
  }

  private runMigrations(fromVersion: number): void {
    // Migration framework - add future migrations here
    for (let v = fromVersion + 1; v <= this.SCHEMA_VERSION; v++) {
      this.logger.info(`Running migration to version ${v}`);
      // Add migration logic here when needed
    }
  }

  addAgentRun(run: {
    run_id: string;
    task: string;
    output: string;
    exit_code: number;
    cost_usd: number;
    timestamp?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_runs
      (run_id, task, output, exit_code, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.task,
      run.output,
      run.exit_code,
      run.cost_usd,
      run.timestamp || new Date().toISOString()
    );
  }

  getAgentRuns(limit: number = 100): Array<{
    run_id: string;
    task: string;
    output: string;
    exit_code: number;
    cost_usd: number;
    timestamp: string;
  }> {
    return this.db.prepare(`
      SELECT run_id, task, output, exit_code, cost_usd, timestamp
      FROM agent_runs
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      run_id: string;
      task: string;
      output: string;
      exit_code: number;
      cost_usd: number;
      timestamp: string;
    }>;
  }

  getAgentRunById(runId: string): {
    run_id: string;
    task: string;
    output: string;
    exit_code: number;
    cost_usd: number;
    timestamp: string;
  } | undefined {
    return this.db.prepare(`
      SELECT run_id, task, output, exit_code, cost_usd, timestamp
      FROM agent_runs
      WHERE run_id = ?
    `).get(runId) as {
      run_id: string;
      task: string;
      output: string;
      exit_code: number;
      cost_usd: number;
      timestamp: string;
    } | undefined;
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

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
