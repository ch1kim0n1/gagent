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
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    const detected = await registry.detectAll();
    
    if (options.json) {
      console.log(JSON.stringify(detected, null, 2));
      return;
    }
    
    if (!options.quiet) {
      console.log(chalk.blue('GAgent Initialization'));
      console.log('');
      
      console.log('Detected tools:');
      for (const [name, info] of Object.entries(detected)) {
        const status = info.installed 
          ? chalk.green('✓') 
          : chalk.yellow('○');
        console.log(`  ${status} ${name}: ${info.version || 'unknown'}`);
      }
    }
    
    if (!options.detectOnly) {
      if (!options.quiet) {
        console.log('');
        console.log('Configuring integration...');
      }
      await config.initialize(detected);
      if (!options.quiet) {
        console.log(chalk.green('Configuration saved to ~/.gagent/config.json'));
      }
    }
  });

program
  .command('health')
  .description('Health check across all tools')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    const health = await registry.healthCheck();
    
    if (options.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    
    if (!options.quiet) {
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
    }
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
  .option('--budget-usd <amount>', 'Maximum budget in USD for this run')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (task, options) => {
    // Basic input validation
    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      console.error(chalk.red('Error: Task must be a non-empty string'));
      process.exit(1);
    }
    
    if (task.length > 10000) {
      console.error(chalk.red('Error: Task description too long (max 10000 characters)'));
      process.exit(1);
    }

    if (task.includes('\0')) {
      console.error(chalk.red('Error: Task contains invalid characters'));
      process.exit(1);
    }

    const parallel = parseInt(options.parallel);
    if (isNaN(parallel) || parallel < 1 || parallel > 100) {
      console.error(chalk.red('Error: Parallel must be a number between 1 and 100'));
      process.exit(1);
    }

    // Budget validation
    if (options.budgetUsd !== undefined) {
      const budget = parseFloat(options.budgetUsd);
      if (isNaN(budget) || budget <= 0) {
        console.error(chalk.red('Error: Budget must be a positive number'));
        process.exit(1);
      }
    }

    const runOptions = {
      task: task.trim(),
      parallel,
      verify: options.verify || options.full,
      cognitiveCheck: options.cognitiveCheck || options.full,
      learn: options.learn || options.full,
      dryRun: options.dryRun,
      budgetUsd: options.budgetUsd ? parseFloat(options.budgetUsd) : undefined
    };
    
    if (runOptions.dryRun) {
      if (!options.quiet) {
        console.log(chalk.blue('Dry run - would execute:'));
        console.log(pipeline.describe(runOptions));
      }
      return;
    }
    
    if (!options.quiet) {
      console.log(chalk.blue(`Running: ${runOptions.task}`));
    }
    if (!options.quiet) {
      console.log('');
    }
    const result = await pipeline.execute(runOptions);
    
    if (!options.quiet) {
      console.log('');
      if (result.success) {
        console.log(chalk.green('✓ Pipeline completed'));
        console.log(`  Winner: ${result.winner?.id || 'N/A'}`);
        console.log(`  Score: ${result.winner?.score || 'N/A'}`);
      } else {
        console.log(chalk.red('✗ Pipeline failed'));
        console.log(`  Error: ${result.error}`);
      }
    }
  });

program
  .command('sync')
  .description('Sync state across all tools')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    if (!options.quiet) {
      console.log(chalk.blue('Syncing all tools...'));
    }
    await registry.syncAll();
    if (!options.quiet) {
      console.log(chalk.green('Sync complete'));
    }
  });

program
  .command('config')
  .description('View or edit configuration')
  .option('--get <key>', 'Get config value')
  .option('--set <key> <value>', 'Set config value')
  .option('--quiet', 'Suppress output for CI use')
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
      if (!options.quiet) {
        console.log(chalk.green('Config updated'));
      }
    } else {
      console.log(config.view());
    }
  });

program
  .command('serve')
  .description('Start MCP server for Claude Code integration')
  .option('--port <port>', 'HTTP port (default: stdio)')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    if (!options.quiet) {
      console.log(chalk.blue('Starting GAgent MCP server...'));
    }
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

program
  .command('eval')
  .description('Run evaluation on pipeline performance')
  .option('-c, --corpus <path>', 'Path to test corpus JSON')
  .option('--cycles <number>', 'Number of cycles to run for statistical comparison', '1')
  .option('--budget-usd <amount>', 'Maximum budget in USD', '10')
  .option('-o, --output <path>', 'Write output to file (JSON format)')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    console.log(chalk.blue('[GAgent] Running evaluation'));

    try {
      if (!options.corpus) {
        console.error(chalk.red('[GAgent] --corpus is required'));
        process.exit(1);
      }

      const cycles = parseInt(options.cycles);
      if (isNaN(cycles) || cycles < 1) {
        console.error(chalk.red('[GAgent] --cycles must be a positive integer'));
        process.exit(1);
      }

      const budget = parseFloat(options.budgetUsd);
      if (isNaN(budget) || budget <= 0) {
        console.error(chalk.red('[GAgent] --budget-usd must be a positive number'));
        process.exit(1);
      }

      const fs = await import('fs/promises');
      const corpusContent = await fs.readFile(options.corpus, 'utf-8');
      const corpus = JSON.parse(corpusContent);

      const allResults = [];
      for (let cycle = 0; cycle < cycles; cycle++) {
        console.log(chalk.gray(`Cycle ${cycle + 1}/${cycles}`));
        const cycleResults = [];
        for (const testCase of corpus) {
          const startTime = Date.now();
          const result = await pipeline.execute({
            task: testCase.task,
            parallel: testCase.parallel || 5,
            verify: testCase.verify || false,
            cognitiveCheck: testCase.cognitiveCheck || false,
            learn: testCase.learn || false,
            dryRun: testCase.dryRun || false,
            budgetUsd: budget,
          });
          const duration = Date.now() - startTime;

          cycleResults.push({
            test_id: testCase.id,
            success: result.success,
            winner: result.winner,
            duration_ms: duration,
            error: result.error,
          });
        }
        allResults.push(cycleResults);
      }

      // Calculate statistical summary
      const flatResults = allResults.flat();
      const summary = {
        cycles: cycles,
        total_tests: flatResults.length,
        passed: flatResults.filter(r => r.success).length,
        failed: flatResults.filter(r => !r.success).length,
        avg_duration: flatResults.reduce((sum, r) => sum + r.duration_ms, 0) / flatResults.length,
        std_duration: calculateStdDev(flatResults.map(r => r.duration_ms)),
        results_by_cycle: allResults,
      };

      if (options.output) {
        await fs.writeFile(options.output, JSON.stringify(summary, null, 2));
        console.log(chalk.green(`[GAgent] Results written to ${options.output}`));
      } else {
        console.log(chalk.green.bold('\n[GAgent] Evaluation completed'));
        console.log(chalk.gray(`Cycles: ${summary.cycles}`));
        console.log(chalk.gray(`Total tests: ${summary.total_tests}`));
        console.log(chalk.gray(`Passed: ${summary.passed}`));
        console.log(chalk.gray(`Failed: ${summary.failed}`));
        console.log(chalk.gray(`Avg duration: ${summary.avg_duration.toFixed(2)}ms (±${summary.std_duration.toFixed(2)}ms)`));
      }

      process.exit(0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Evaluation failed:'), error);
      process.exit(1);
    }
  });

program
  .command('replay <id>')
  .description('Replay a previous execution using stored receipt or corpus hash')
  .option('--corpus <path>', 'Path to corpus directory (for hash replay)', './.gbrain-corpus')
  .option('--dry-run', 'Show what would be done without executing')
  .option('--cycles <n>', 'Number of cycles to run (for statistical comparison)', '1')
  .option('--budget-usd <amount>', 'Maximum budget in USD', '10')
  .action(async (id, options) => {
    // Check if ID looks like a hash (64 hex chars) or receipt ID
    const isHash = /^[a-f0-9]{64}$/i.test(id);

    if (isHash) {
      // Use ReplayManager for hash-based replay
      try {
        const { ReplayManager } = await import('../../shared/src/core/replay-manager.js');
        const replayManager = new ReplayManager(options.corpus);
        
        const result = await replayManager.retrieve(id);
        
        if (!result.found) {
          console.error(chalk.red(`[GAgent] Hash not found in corpus: ${id}`));
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(chalk.yellow('[GAgent] Dry run - would replay:'));
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        }

        console.log(chalk.blue(`[GAgent] Replaying hash: ${id}`));
        console.log(chalk.gray(`Tool: ${result.metadata.tool}`));
        console.log(chalk.gray(`Timestamp: ${result.metadata.timestamp}`));
        console.log(chalk.gray(`Task: ${result.metadata.task || 'N/A'}`));
        console.log(chalk.green('\nContent:'));
        console.log(result.content);
        process.exit(0);
      } catch (error) {
        console.error(chalk.red('[GAgent] Replay failed:'), error);
        process.exit(1);
      }
    } else {
      // Use receipt file for receipt ID replay
      console.log(chalk.blue(`[GAgent] Replaying receipt: ${id}`));

      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        
        // Find receipt in weekly receipt files
        const now = new Date();
        const year = now.getFullYear();
        const weekNum = Math.ceil((now.getTime() - new Date(year, 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));
        const week = `${year}-W${String(weekNum).padStart(2, '0')}`;
        
        const receiptPath = path.join(process.cwd(), 'gagent', 'test', 'baselines', `receipts-${week}.jsonl`);
        
        const content = await fs.readFile(receiptPath, 'utf8');
        const lines = content.trim().split('\n').filter((l: string) => l);
        
        let targetReceipt = null;
        for (const line of lines) {
          const receipt = JSON.parse(line);
          if (receipt.id === id || receipt.request_id === id) {
            targetReceipt = receipt;
            break;
          }
        }
        
        if (!targetReceipt) {
          console.error(chalk.red(`[GAgent] Receipt not found: ${id}`));
          process.exit(1);
        }
        
        if (options.dryRun) {
          console.log(chalk.yellow('[GAgent] Dry run - would replay:'));
          console.log(JSON.stringify(targetReceipt, null, 2));
          process.exit(0);
        }
        
        console.log(chalk.gray(`Task: ${targetReceipt.task}`));
        console.log(chalk.gray(`Original timestamp: ${targetReceipt.timestamp}`));
        
        // Re-execute with original parameters
        const cycles = parseInt(options.cycles);
        if (isNaN(cycles) || cycles < 1) {
          console.error(chalk.red('[GAgent] --cycles must be a positive integer'));
          process.exit(1);
        }

        const budget = parseFloat(options.budgetUsd);
        if (isNaN(budget) || budget <= 0) {
          console.error(chalk.red('[GAgent] --budget-usd must be a positive number'));
          process.exit(1);
        }

        const result = await pipeline.execute({
          task: targetReceipt.task,
          parallel: targetReceipt.options?.parallel || 1,
          verify: targetReceipt.options?.verify || false,
          cognitiveCheck: targetReceipt.options?.cognitiveCheck || false,
          learn: targetReceipt.options?.learn || false,
          dryRun: false,
          cycles,
          budgetUsd: budget,
        });
        
        console.log('');
        if (result.success) {
          console.log(chalk.green('✓ Replay completed'));
          console.log(`  Winner: ${result.winner?.id || 'N/A'}`);
          console.log(`  Score: ${result.winner?.score || 'N/A'}`);
        } else {
          console.log(chalk.red('✗ Replay failed'));
          console.log(`  Error: ${result.error}`);
        }
        
        process.exit(0);
      } catch (error) {
        console.error(chalk.red('[GAgent] Replay failed:'), error);
        process.exit(1);
      }
    }
  });

program
  .command('registry')
  .description('Manage tool registry')
  .option('--list', 'List all registered tools')
  .option('--enable <tool>', 'Enable a tool')
  .option('--disable <tool>', 'Disable a tool')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    const toolStatus = tools.map((tool) => ({
      tool,
      enabled: config.isToolEnabled(tool),
    }));

    if (options.json) {
      console.log(JSON.stringify(toolStatus, null, 2));
    } else if (options.list && !options.quiet) {
      console.log(chalk.blue('[GAgent] Tool Registry'));
      console.log(chalk.bold('\nRegistered Tools:'));
      for (const status of toolStatus) {
        const enabled = status.enabled ? chalk.green('enabled') : chalk.red('disabled');
        console.log(`  ${status.tool}: ${enabled}`);
      }
    } else if (options.enable && !options.quiet) {
      console.log(chalk.yellow(`\n[GAgent] Tool enablement requires config file update: ${options.enable}`));
      console.log(chalk.gray('Edit ~/.gagent/config.json to enable tools'));
    } else if (options.disable && !options.quiet) {
      console.log(chalk.yellow(`\n[GAgent] Tool disablement requires config file update: ${options.disable}`));
      console.log(chalk.gray('Edit ~/.gagent/config.json to disable tools'));
    } else if (!options.quiet) {
      console.log(chalk.yellow('Use --list, --enable, or --disable'));
    }

    process.exit(0);
  });

program
  .command('cost')
  .description('View LLM spend and cost tracking')
  .option('--day', 'Show today\'s spend (default)')
  .option('--week', 'Show this week\'s spend')
  .option('--month', 'Show this month\'s spend')
  .option('--by-model', 'Break down by model')
  .option('--by-operation', 'Break down by operation')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { BudgetLedger } = await import('../../shared/src/core/budget-ledger.js');
      const ledger = new BudgetLedger({ max_budget_usd: 1000 }, 'gagent');
      await ledger.init();

      let spend = 0;
      if (options.week) {
        spend = ledger.getWeeklySpend();
      } else if (options.month) {
        spend = ledger.getMonthlySpend();
      } else {
        spend = ledger.getDailySpend();
      }

      if (options.json) {
        const breakdown: Record<string, any> = {};
        if (options.byModel) {
          breakdown['by_model'] = ledger.getSpendByModel();
        }
        if (options.byOperation) {
          breakdown['by_operation'] = ledger.getSpendByModel();
        }
        console.log(JSON.stringify({ spend, ...breakdown }, null, 2));
      } else {
        const period = options.week ? 'this week' : options.month ? 'this month' : 'today';
        console.log(chalk.blue(`LLM Spend ${period}: $${spend.toFixed(4)}`));
        
        if (options.byModel) {
          const byModel = ledger.getSpendByModel();
          console.log(chalk.gray('\nBy model:'));
          for (const [model, cost] of Object.entries(byModel)) {
            console.log(`  ${model}: $${(cost as number).toFixed(4)}`);
          }
        }
        
        if (options.byOperation) {
          const byOp = ledger.getSpendByModel();
          console.log(chalk.gray('\nBy operation:'));
          for (const [op, cost] of Object.entries(byOp)) {
            console.log(`  ${op}: $${(cost as number).toFixed(4)}`);
          }
        }
      }
      
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Cost query failed:'), error);
      process.exit(1);
    }
  });

program
  .command('trend')
  .description('Show agent run success rate trend over time')
  .option('--window <days>', 'Number of days to look back', '7')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const windowDays = parseInt(options.window);
      if (isNaN(windowDays) || windowDays < 1) {
        console.error(chalk.red('[GAgent] --window must be a positive integer'));
        process.exit(1);
      }

      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const registry = new ReceiptRegistry('gagent');

      const now = new Date();
      const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const receipts = await registry.getAllBetween(start, now);

      const total = receipts.length;
      const passed = receipts.filter((r: any) => r.exit_code === 0).length;
      const successRate = total === 0 ? 0 : passed / total;

      // Determine trend by comparing first half vs second half of window
      let trend: 'stable' | 'improving' | 'degrading' = 'stable';
      if (total >= 4) {
        const mid = Math.floor(total / 2);
        const firstHalf = receipts.slice(0, mid);
        const secondHalf = receipts.slice(mid);
        const firstRate = firstHalf.filter((r: any) => r.exit_code === 0).length / firstHalf.length;
        const secondRate = secondHalf.filter((r: any) => r.exit_code === 0).length / secondHalf.length;
        if (secondRate - firstRate > 0.05) trend = 'improving';
        else if (firstRate - secondRate > 0.05) trend = 'degrading';
      }

      const result = { window_days: windowDays, success_rate: successRate, trend };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log(chalk.blue('[GAgent] Success Rate Trend'));
        console.log(`  Window: ${windowDays} days`);
        console.log(`  Runs: ${total}`);
        console.log(`  Success rate: ${(successRate * 100).toFixed(1)}%`);
        const trendColor = trend === 'improving' ? 'green' : trend === 'degrading' ? 'red' : 'yellow';
        console.log(`  Trend: ${chalk[trendColor](trend)}`);
      }

      process.exit(0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Trend query failed:'), error);
      process.exit(1);
    }
  });

program
  .command('regress')
  .description('Run a regression check comparing current performance to baseline')
  .option('--baseline <rate>', 'Baseline pass rate to compare against', '0.7')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const baselineRate = parseFloat(options.baseline);
      if (isNaN(baselineRate) || baselineRate < 0 || baselineRate > 1) {
        console.error(chalk.red('[GAgent] --baseline must be a number between 0 and 1'));
        process.exit(1);
      }

      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const registry = new ReceiptRegistry('gagent');

      const now = new Date();
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const receipts = await registry.getAllBetween(start, now);

      const total = receipts.length;
      const passed = receipts.filter((r: any) => r.exit_code === 0).length;
      const currentRate = total === 0 ? 0 : passed / total;
      const delta = currentRate - baselineRate;
      const regressionPassed = currentRate >= baselineRate;

      const result = {
        passed: regressionPassed,
        current_rate: currentRate,
        baseline_rate: baselineRate,
        delta,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log(chalk.blue('[GAgent] Regression Check'));
        const statusColor = regressionPassed ? 'green' : 'red';
        const statusLabel = regressionPassed ? '✓ PASSED' : '✗ FAILED';
        console.log(`  Status: ${chalk[statusColor](statusLabel)}`);
        console.log(`  Current rate: ${(currentRate * 100).toFixed(1)}%`);
        console.log(`  Baseline rate: ${(baselineRate * 100).toFixed(1)}%`);
        const deltaLabel = delta >= 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;
        console.log(`  Delta: ${delta >= 0 ? chalk.green(deltaLabel) : chalk.red(deltaLabel)}`);
      }

      process.exit(regressionPassed ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('[GAgent] Regression check failed:'), error);
      process.exit(1);
    }
  });

program
  .command('drift')
  .description('Detect if agent behavior has drifted from baseline')
  .option('--window <n>', 'Number of recent runs to check', '10')
  .option('--baseline-error-rate <rate>', 'Expected baseline error rate', '0.1')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const windowSize = parseInt(options.window);
      if (isNaN(windowSize) || windowSize < 1) {
        console.error(chalk.red('[GAgent] --window must be a positive integer'));
        process.exit(1);
      }

      const baselineErrorRate = parseFloat(options.baselineErrorRate);
      if (isNaN(baselineErrorRate) || baselineErrorRate < 0 || baselineErrorRate > 1) {
        console.error(chalk.red('[GAgent] --baseline-error-rate must be a number between 0 and 1'));
        process.exit(1);
      }

      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const registry = new ReceiptRegistry('gagent');

      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const allReceipts = await registry.getAllBetween(start, now);

      // Take the last N receipts
      const recent = allReceipts.slice(-windowSize);
      const total = recent.length;
      const errors = recent.filter((r: any) => r.exit_code !== 0).length;
      const errorRate = total === 0 ? 0 : errors / total;

      const DRIFT_THRESHOLD = 0.1;
      const drifted = Math.abs(errorRate - baselineErrorRate) > DRIFT_THRESHOLD;

      const result = {
        drifted,
        error_rate: errorRate,
        baseline_error_rate: baselineErrorRate,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log(chalk.blue('[GAgent] Drift Detection'));
        const driftColor = drifted ? 'red' : 'green';
        const driftLabel = drifted ? '⚠ DRIFT DETECTED' : '✓ No drift';
        console.log(`  Status: ${chalk[driftColor](driftLabel)}`);
        console.log(`  Runs checked: ${total}`);
        console.log(`  Current error rate: ${(errorRate * 100).toFixed(1)}%`);
        console.log(`  Baseline error rate: ${(baselineErrorRate * 100).toFixed(1)}%`);
      }

      process.exit(drifted ? 1 : 0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Drift detection failed:'), error);
      process.exit(1);
    }
  });

function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

program.parse();
