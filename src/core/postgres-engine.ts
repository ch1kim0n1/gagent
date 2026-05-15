/**
 * PostgreSQL engine implementation for concurrent-writer deployments.
 */

import { Pool, PoolClient } from 'pg';
import { BrainEngine, DatabaseStats, EngineConfig, QueryOptions, QueryResult } from './engine.js';

export class PostgreSQLEngine implements BrainEngine {
  private pool: Pool | null = null;
  private readPool: Pool | null = null;
  private client: PoolClient | null = null;
  private connectionCount = 0;
  private startTime = Date.now();
  private inTransaction = false;

  constructor(private config: EngineConfig) {}

  async initialize(): Promise<void> {
    const connectionString = this.config.connectionString || process.env.GAGENT_POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('PostgreSQL connection string is required');
    }

    this.pool = new Pool({
      connectionString,
      max: this.config.maxConnections ?? 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.connectionCount++;

    const readConnectionString = this.config.readConnectionString || process.env.GAGENT_POSTGRES_READ_REPLICA_URL;
    if (readConnectionString && readConnectionString !== connectionString) {
      this.readPool = new Pool({
        connectionString: readConnectionString,
        max: this.config.maxConnections ?? 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      this.connectionCount++;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connectionCount--;
    }
    if (this.readPool) {
      await this.readPool.end();
      this.readPool = null;
      this.connectionCount--;
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = [], options?: QueryOptions): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (options?.transaction && !this.inTransaction) {
      return this.runInTransaction((client) => this.queryWithClient<T>(client, sql, params));
    }

    const pool = this.shouldUseReadPool(sql) ? this.readPool! : this.pool;
    const client = this.client || await pool.connect();
    try {
      return await this.queryWithClient<T>(client, sql, params);
    } finally {
      if (!this.client) {
        client.release();
      }
    }
  }

  async execute(sql: string, params: unknown[] = [], options?: QueryOptions): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (options?.transaction && !this.inTransaction) {
      return this.runInTransaction(async (client) => {
        const result = await client.query(sql, params);
        return result.rowCount || 0;
      });
    }

    const client = this.client || await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rowCount || 0;
    } finally {
      if (!this.client) {
        client.release();
      }
    }
  }

  async beginTransaction(): Promise<void> {
    if (!this.pool || this.inTransaction) {
      throw new Error('Transaction already in progress or database not initialized');
    }
    this.client = await this.pool.connect();
    await this.client.query('BEGIN');
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.client || !this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.client || !this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    await this.client.query('ROLLBACK');
    this.client.release();
    this.client = null;
    this.inTransaction = false;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.pool) {
      return false;
    }
    try {
      await this.query('SELECT 1');
      if (this.readPool) {
        const client = await this.readPool.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async getStats(): Promise<DatabaseStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const tables = await this.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `);
    const tableSizes: Record<string, number> = {};
    for (const table of tables.rows) {
      const count = await this.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM "${table.tablename}"`);
      tableSizes[table.tablename] = Number(count.rows[0]?.count || 0);
    }

    return {
      totalSize: 0,
      tableSizes,
      connectionCount: this.connectionCount,
      uptime: Date.now() - this.startTime,
    };
  }

  async migrate(): Promise<void> {
    await this.execute(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  private shouldUseReadPool(sql: string): boolean {
    return Boolean(this.readPool && !this.inTransaction && /^\s*select\b/i.test(sql));
  }

  private async queryWithClient<T>(client: PoolClient, sql: string, params: unknown[]): Promise<QueryResult<T>> {
    const result = await client.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount || 0,
      affectedRows: result.rowCount || 0,
    };
  }

  private async runInTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
