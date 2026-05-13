#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { GAgentConfig } from './config/manager.js';
import { ToolRegistry } from './tools/registry.js';
import { Pipeline } from './pipeline/orchestrator.js';
import { startMcpServer } from './mcp/server.js';

const config = new GAgentConfig();
const registry = new ToolRegistry(config);
const pipeline = new Pipeline(registry, config);

program
  .name('gagent')
  .description('Unified CLI for the six-tool agent stack')
  .version('0.1.0');

// Core commands
program
  .command('init')
  .description('Initialize all six tools')
  .option('--detect-only', 'Only detect existing installs, do not modify')
  .option('--force', 'Force re-initialization')
  .action(async (options) => {
    console.log(chalk.blue('GAgent Initialization'));
    console.log('');
    
    const detected = await registry.detectAll();
    
    console.log('Detected tools:');
    for (const [name, info] of Object.entries(detected)) {
      const status = info.installed 
        ? chalk.green('✓') 
        : chalk.yellow('○');
      console.log(`  ${status} ${name}: ${info.version || 'unknown'}`);
    }
    
    if (!options.detectOnly) {
      console.log('');
      console.log('Configuring integration...');
      await config.initialize(detected);
      console.log(chalk.green('Configuration saved to ~/.gagent/config.json'));
    }
  });

program
  .command('health')
  .description('Health check across all tools')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const health = await registry.healthCheck();
    
    if (options.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    
    console.log(chalk.blue('GAgent Health Check'));
    console.log('');
    
    let score = 0;
    let maxScore = 0;
    
    for (const [name, check] of Object.entries(health)) {
      maxScore += 10;
      const status = check.healthy 
        ? chalk.green('✓ healthy') 
        : check.installed 
          ? chalk.yellow('⚠ issues') 
          : chalk.red('✗ not installed');
      
      if (check.healthy) score += 10;
      else if (check.installed) score += 5;
      
      console.log(`${name.padEnd(15)} ${status}`);
      if (check.message) {
        console.log(`  ${chalk.gray(check.message)}`);
      }
    }
    
    console.log('');
    const percentage = Math.round((score / maxScore) * 100);
    const color = percentage > 80 ? 'green' : percentage > 50 ? 'yellow' : 'red';
    console.log(`Overall health: ${chalk[color](percentage)}%`);
  });

program
  .command('run <task>')
  .description('Execute task through the pipeline')
  .option('-n, --parallel <n>', 'Number of parallel attempts', '1')
  .option('--verify', 'Run GMirror verification')
  .option('--cognitive-check', 'Run GToM authenticity check')
  .option('--learn', 'Capture to GLearn')
  .option('--full', 'Run full pipeline (parallel + verify + check + learn)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(async (task, options) => {
    const runOptions = {
      task,
      parallel: parseInt(options.parallel),
      verify: options.verify || options.full,
      cognitiveCheck: options.cognitiveCheck || options.full,
      learn: options.learn || options.full,
      dryRun: options.dryRun
    };
    
    if (runOptions.dryRun) {
      console.log(chalk.blue('Dry run - would execute:'));
      console.log(pipeline.describe(runOptions));
      return;
    }
    
    console.log(chalk.blue(`Running: ${task}`));
    console.log('');
    
    const result = await pipeline.execute(runOptions);
    
    console.log('');
    if (result.success) {
      console.log(chalk.green('✓ Pipeline completed'));
      console.log(`  Winner: ${result.winner?.id || 'N/A'}`);
      console.log(`  Score: ${result.winner?.score || 'N/A'}`);
    } else {
      console.log(chalk.red('✗ Pipeline failed'));
      console.log(`  Error: ${result.error}`);
    }
  });

program
  .command('sync')
  .description('Sync state across all tools')
  .action(async () => {
    console.log(chalk.blue('Syncing all tools...'));
    await registry.syncAll();
    console.log(chalk.green('Sync complete'));
  });

program
  .command('config')
  .description('View or edit configuration')
  .option('--get <key>', 'Get config value')
  .option('--set <key> <value>', 'Set config value')
  .action(async (options) => {
    if (options.get) {
      const value = config.get(options.get);
      console.log(value);
    } else if (options.set) {
      // Parse value as JSON if possible
      let parsed = options.set[1];
      try { parsed = JSON.parse(parsed); } catch {}
      config.set(options.set[0], parsed);
      await config.save();
      console.log(chalk.green('Config updated'));
    } else {
      console.log(config.view());
    }
  });

program
  .command('serve')
  .description('Start MCP server for Claude Code integration')
  .option('--port <port>', 'HTTP port (default: stdio)')
  .action(async (options) => {
    console.log(chalk.blue('Starting GAgent MCP server...'));
    await startMcpServer(registry, config, options.port);
  });

// Tool passthrough commands
const tools = ['brain', 'stack', 'orc', 'mirror', 'tom', 'learn'];
const toolMap: Record<string, string> = {
  brain: 'gbrain',
  stack: 'gstack',
  orc: 'gorchestrator',
  mirror: 'gmirror',
  tom: 'gtom',
  learn: 'glearn'
};

for (const tool of tools) {
  program
    .command(`${tool} [args...]`)
    .description(`Passthrough to ${toolMap[tool]}`)
    .allowUnknownOption()
    .action(async (args, _cmd, fullCmd) => {
      const toolName = toolMap[tool];
      const result = await registry.runTool(toolName, args || [], fullCmd.args);
      process.exit(result.exitCode);
    });
}

// Convenience aliases
program
  .command('run-parallel <task>')
  .description('Alias for: gagent run <task> --parallel 5')
  .option('--verify', 'Add verification')
  .action(async (task, options) => {
    await program.parseAsync([
      'node', 'gagent', 'run', task, 
      '--parallel', '5',
      ...(options.verify ? ['--verify'] : [])
    ]);
  });

program
  .command('run-verified <task>')
  .description('Alias for: gagent run <task> --parallel 5 --verify')
  .action(async (task) => {
    await program.parseAsync([
      'node', 'gagent', 'run', task,
      '--parallel', '5', '--verify'
    ]);
  });

program
  .command('run-safe <task>')
  .description('Alias for: gagent run <task> --parallel 5 --verify --cognitive-check')
  .action(async (task) => {
    await program.parseAsync([
      'node', 'gagent', 'run', task,
      '--parallel', '5', '--verify', '--cognitive-check'
    ]);
  });

program
  .command('run-smart <task>')
  .description('Alias for full pipeline')
  .action(async (task) => {
    await program.parseAsync([
      'node', 'gagent', 'run', task, '--full'
    ]);
  });

program.parse();
