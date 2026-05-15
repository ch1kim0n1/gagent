/**
 * Migration system for GAgent
 * Manages database schema migrations
 */

import { BrainEngine, Migration } from './engine.js';
import { coreLogger } from './observability.js';

export class Migrator {
  private engine: BrainEngine;
  private migrations: Migration[] = [];

  constructor(engine: BrainEngine) {
    this.engine = engine;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
  }

  async run(): Promise<void> {
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await this.engine.query<{ version: number }>(
      'SELECT MAX(version) as version FROM migrations'
    );
    const currentVersion = result.rows[0]?.version || 0;

    for (const migration of this.migrations) {
      if (migration.version > currentVersion) {
        coreLogger.info('Running migration', { version: migration.version, name: migration.name });
        await this.engine.execute(migration.up);
        await this.engine.execute(
          'INSERT INTO migrations (version, name) VALUES (?, ?)',
          [migration.version, migration.name]
        );
      }
    }
  }

  async rollback(targetVersion: number): Promise<void> {
    const result = await this.engine.query<{ version: number }>(
      'SELECT MAX(version) as version FROM migrations'
    );
    const currentVersion = result.rows[0]?.version || 0;

    for (let i = this.migrations.length - 1; i >= 0; i--) {
      const migration = this.migrations[i];
      if (migration.version > targetVersion && migration.version <= currentVersion) {
        coreLogger.info('Rolling back migration', { version: migration.version, name: migration.name });
        await this.engine.execute(migration.down);
        await this.engine.execute(
          'DELETE FROM migrations WHERE version = ?',
          [migration.version]
        );
      }
    }
  }

  async getStatus(): Promise<{ current: number; pending: number }> {
    const result = await this.engine.query<{ version: number }>(
      'SELECT MAX(version) as version FROM migrations'
    );
    const currentVersion = result.rows[0]?.version || 0;
    const pending = this.migrations.filter(m => m.version > currentVersion).length;

    return { current: currentVersion, pending };
  }
}

export const createMigrator = (engine: BrainEngine): Migrator => {
  return new Migrator(engine);
};
