/**
 * SQLite engine implementation for GAgent
 * Uses embedded SQLite database for local development
 */

import Database from 'better-sqlite3';
import { BrainEngine, EngineConfig, QueryOptions, QueryResult, DatabaseStats } from './engine.js';

export class SQLiteEngine implements BrainEngine {
  private db: Database.Database | null = null;
  private config: EngineConfig;
  private connectionCount = 0;
  private startTime = Date.now();
  private inTransaction = false;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const dbPath = this.config.dbPath || ':memory:';
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.connectionCount++;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.connectionCount--;
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = [], options?: QueryOptions): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.all(...params) as T[];
    
    return {
      rows: result,
      rowCount: result.length,
    };
  }

  async execute(sql: string, params: unknown[] = [], options?: QueryOptions): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes;
  }

  async beginTransaction(): Promise<void> {
    if (!this.db || this.inTransaction) {
      throw new Error('Transaction already in progress or database not initialized');
    }
    this.db.exec('BEGIN TRANSACTION');
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.db || !this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    this.db.exec('COMMIT');
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.db || !this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    this.db.exec('ROLLBACK');
    this.inTransaction = false;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.db) {
      return false;
    }
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async getStats(): Promise<DatabaseStats> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const tableSizes: Record<string, number> = {};
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    
    for (const table of tables) {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get() as { count: number };
      tableSizes[table.name] = result.count;
    }

    return {
      totalSize: 0,
      tableSizes,
      connectionCount: this.connectionCount,
      uptime: Date.now() - this.startTime,
    };
  }

  async migrate(): Promise<void> {
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
  }
}
