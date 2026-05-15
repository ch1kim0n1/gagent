/**
 * Base engine interface for GAgent database abstraction
 * Provides a unified interface for different database backends
 */

export interface EngineConfig {
  type: 'postgres' | 'sqlite' | 'memory';
  connectionString?: string;
  readConnectionString?: string;
  dbPath?: string;
  maxConnections?: number;
}

export interface QueryOptions {
  transaction?: boolean;
  timeout?: number;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
  affectedRows?: number;
}

/**
 * Base database engine interface
 * All database implementations must implement this interface
 */
export interface BrainEngine {
  /**
   * Initialize the database connection
   */
  initialize(): Promise<void>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  /**
   * Execute a SQL query
   */
  query<T = unknown>(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult<T>>;

  /**
   * Execute a SQL command (INSERT, UPDATE, DELETE)
   */
  execute(sql: string, params?: unknown[], options?: QueryOptions): Promise<number>;

  /**
   * Begin a transaction
   */
  beginTransaction(): Promise<void>;

  /**
   * Commit a transaction
   */
  commitTransaction(): Promise<void>;

  /**
   * Rollback a transaction
   */
  rollbackTransaction(): Promise<void>;

  /**
   * Check if the database is healthy
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get database statistics
   */
  getStats(): Promise<DatabaseStats>;

  /**
   * Run database migrations
   */
  migrate(): Promise<void>;
}

export interface DatabaseStats {
  totalSize: number;
  tableSizes: Record<string, number>;
  connectionCount: number;
  uptime: number;
}

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}
