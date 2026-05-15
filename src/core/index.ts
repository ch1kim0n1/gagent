/**
 * Core module exports for GAgent
 */

export type { BrainEngine, EngineConfig, QueryOptions, QueryResult, DatabaseStats, Migration } from './engine.js';
export { SQLiteEngine } from './sqlite-engine.js';
export { createEngine, createDefaultEngine } from './engine-factory.js';
export { Migrator, createMigrator } from './migrate.js';

export { SkillRegistry } from './skill-registry.js';
export type { Skill } from './skill-registry.js';
export { AgentRegistry } from './agent-registry.js';
export type { Agent } from './agent-registry.js';
export { TaskQueue } from './task-queue.js';
export type { Task } from './task-queue.js';
export { SkillExecutor } from './skill-executor.js';
export type { ExecutionContext, ExecutionResult } from './skill-executor.js';
export type { Skillpack } from './skillpack-registry.js';
export { SkillpackRegistry } from './skillpack-registry.js';

export { defaultConfig, loadConfig, mergeConfig } from './config.js';
export type { GAgentConfig } from './config.js';
export { generateId, hashString, sleep, retry } from './utils.js';
export { Logger, LogLevel, logger } from './logger.js';
export type { LogEntry } from './logger.js';
export {
  GAgentError,
  DatabaseError,
  ValidationError,
  SkillError,
  AgentError,
  TaskError,
} from './errors.js';
