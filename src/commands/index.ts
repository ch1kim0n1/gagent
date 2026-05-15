/**
 * Command index for GAgent
 * Registers all available commands
 */

import { registerCommands } from './command-registry.js';
import { initCommand } from './init.js';
import { doctorCommand } from './doctor.js';
import { skillCommand } from './skill.js';
import { skillpackCommand } from './skillpack.js';
import { configCommand } from './config.js';
import { serveCommand } from './serve.js';
import { agentCommand } from './agent.js';
import { taskCommand } from './task.js';
import { logsCommand } from './logs.js';
import { versionCommand } from './version.js';
import { helpCommand } from './help.js';
import { exportCommand } from './export.js';
import { importCommand } from './import.js';
import { validateCommand } from './validate.js';
import { benchmarkCommand } from './benchmark.js';
import { resetCommand } from './reset.js';
import { backupCommand } from './backup.js';
import { metricsCommand } from './metrics.js';
import { healthCheckCommand } from './health-check.js';
import { authCommand } from './auth.js';
import { apiKeyCommand } from './api-key.js';

export function registerAllCommands(): void {
  registerCommands([
    initCommand,
    doctorCommand,
    skillCommand,
    skillpackCommand,
    configCommand,
    serveCommand,
    agentCommand,
    taskCommand,
    logsCommand,
    versionCommand,
    helpCommand,
    exportCommand,
    importCommand,
    validateCommand,
    benchmarkCommand,
    resetCommand,
    backupCommand,
    metricsCommand,
    healthCheckCommand,
    authCommand,
    apiKeyCommand,
  ]);
}
