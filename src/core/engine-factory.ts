/**
 * Engine factory for creating database engine instances
 */

import { BrainEngine, EngineConfig } from './engine.js';
import { PostgreSQLEngine } from './postgres-engine.js';
import { SQLiteEngine } from './sqlite-engine.js';

export function createEngine(config: EngineConfig): BrainEngine {
  switch (config.type) {
    case 'sqlite':
    case 'memory':
      return new SQLiteEngine(config);
    case 'postgres':
      return new PostgreSQLEngine(config);
    default:
      throw new Error(`Unknown engine type: ${config.type}`);
  }
}

export function createDefaultEngine(): BrainEngine {
  return createEngine({
    type: 'sqlite',
    dbPath: './gagent.db',
  });
}
