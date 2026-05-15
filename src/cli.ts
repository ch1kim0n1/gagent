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
        maxScore += 100;
        const status = check.healthy 
          ? chalk.green('✓ healthy') 
          : check.installed 
            ? chalk.yellow('⚠ issues') 
            : chalk.red('✗ not installed');
        
        score += check.score ?? (check.healthy ? 100 : check.installed ? 50 : 0);
        
        const latency = check.latency_ms !== undefined ? ` ${Math.round(check.latency_ms)}ms` : '';
        const itemScore = check.score !== undefined ? ` score=${Math.round(check.score)}` : '';
        console.log(`${name.padEnd(15)} ${status}${latency}${itemScore}`);
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
  .option('--cycles <n>', 'Number of cycles to run', '1')
  .option('--budget-usd <amount>', 'Maximum budget in USD for this run')
  .option('--json', 'Output as JSON')
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
    const cycles = parseInt(options.cycles);
    if (isNaN(cycles) || cycles < 1 || cycles > 100) {
      console.error(chalk.red('Error: Cycles must be between 1 and 100'));
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
      budgetUsd: options.budgetUsd ? parseFloat(options.budgetUsd) : undefined,
      cycles
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
    const results = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (cycles > 1 && !options.quiet) {
        console.log(chalk.gray(`Cycle ${cycle + 1}/${cycles}`));
      }
      results.push(await pipeline.execute({ ...runOptions, cycles: 1 }));
    }
    const result = results[results.length - 1];
    if (options.json) {
      console.log(JSON.stringify(cycles === 1 ? result : { cycles, results }, null, 2));
      return;
    }
    
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
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    if (!options.quiet) {
      console.log(chalk.blue('Syncing all tools...'));
    }
    await registry.syncAll();
    if (options.json) {
      console.log(JSON.stringify({ status: 'synced', timestamp: new Date().toISOString() }, null, 2));
      return;
    }
    if (!options.quiet) {
      console.log(chalk.green('Sync complete'));
    }
  });

program
  .command('config')
  .description('View or edit configuration')
  .option('--get <key>', 'Get config value')
  .option('--set <key> <value>', 'Set config value')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    if (options.get) {
      const value = config.get(options.get);
      if (options.json) {
        console.log(JSON.stringify({ key: options.get, value }, null, 2));
      } else if (!options.quiet) {
        console.log(value);
      }
    } else if (options.set) {
      // Parse value as JSON if possible
      let parsed = options.set[1];
      try { parsed = JSON.parse(parsed); } catch {}
      await config.set(options.set[0], parsed);
      if (options.json) {
        console.log(JSON.stringify({ updated: options.set[0], value: parsed }, null, 2));
        return;
      }
      if (!options.quiet) {
        console.log(chalk.green('Config updated'));
      }
    } else if (options.json) {
      console.log(JSON.stringify(config.getRaw(), null, 2));
    } else if (!options.quiet) {
      console.log(config.view());
    } else {
    }
  });

program
  .command('serve')
  .description('Start MCP server for Claude Code integration')
  .option('--port <port>', 'HTTP port (default: stdio)')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    if (options.json) {
      console.log(JSON.stringify({ status: 'starting', port: options.port || 'stdio' }, null, 2));
    }
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
  .argument('[mode]', 'Optional mode, e.g. regress')
  .option('-c, --corpus <path>', 'Path to test corpus JSON')
  .option('--against <receipt>', 'Receipt path or ID to compare against in regress mode')
  .option('--cycles <number>', 'Number of cycles to run for statistical comparison', '1')
  .option('--budget-usd <amount>', 'Maximum budget in USD', '10')
  .option('-o, --output <path>', 'Write output to file (JSON format)')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (mode, options) => {
    if (mode === 'regress') {
      await runReceiptRegression(options.against, options);
      return;
    }

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
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (id, options) => {
    // Check if ID looks like a hash (64 hex chars) or receipt ID
    const isHash = /^[a-f0-9]{64}$/i.test(id);
    const isCorpusSha8 = /^[a-f0-9]{8}$/i.test(id);

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
        const { ReceiptRegistry } = await import('./core/receipt-registry.js');
        const receiptRegistry = new ReceiptRegistry('gagent');
        const targetReceipt = isCorpusSha8
          ? (await receiptRegistry.getByCorpusSha8(id)).at(-1)
          : await receiptRegistry.getByIdOrPath(id);
        
        if (!targetReceipt) {
          console.error(chalk.red(`[GAgent] Receipt not found: ${id}`));
          process.exit(1);
        }
        
        if (options.dryRun) {
          console.log(chalk.yellow('[GAgent] Dry run - would replay:'));
          console.log(JSON.stringify(targetReceipt, null, 2));
          process.exit(0);
        }
        
        const task = (targetReceipt as any).metadata?.task || (targetReceipt as any).task;
        if (!task) {
          console.error(chalk.red('[GAgent] Receipt does not contain replayable task metadata'));
          process.exit(1);
        }

        console.log(chalk.gray(`Task: ${task}`));
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
          task,
          parallel: (targetReceipt as any).metadata?.parallel || (targetReceipt as any).options?.parallel || 1,
          verify: (targetReceipt as any).metadata?.verify || (targetReceipt as any).options?.verify || false,
          cognitiveCheck: (targetReceipt as any).metadata?.cognitive_check || (targetReceipt as any).options?.cognitiveCheck || false,
          learn: (targetReceipt as any).metadata?.learn || (targetReceipt as any).options?.learn || false,
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
  .command('receipts')
  .description('List execution receipts')
  .option('--since <date>', 'Only include receipts since YYYY-MM-DD')
  .option('--until <date>', 'Only include receipts up to YYYY-MM-DD')
  .option('--limit <n>', 'Maximum number of receipts to print', '50')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const receiptRegistry = new ReceiptRegistry('gagent');
      const start = options.since ? new Date(options.since) : new Date(0);
      const end = options.until ? new Date(options.until) : new Date();
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        console.error(chalk.red('[GAgent] --since/--until must be valid dates'));
        process.exit(1);
      }

      const limit = parseInt(options.limit);
      if (isNaN(limit) || limit < 1) {
        console.error(chalk.red('[GAgent] --limit must be a positive integer'));
        process.exit(1);
      }

      const receipts = (await receiptRegistry.getAllBetween(start, end)).slice(-limit);
      if (options.json) {
        console.log(JSON.stringify(receipts, null, 2));
      } else if (!options.quiet) {
        for (const receipt of receipts) {
          console.log(`${receipt.timestamp} ${receipt.receipt_id} ${receipt.verdict} score=${receipt.overall_score.toFixed(3)} corpus=${receipt.metadata?.corpus_sha8 || receipt.input_hash.substring(0, 8)}`);
        }
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Receipt query failed:'), error);
      process.exit(1);
    }
  });

program
  .command('diff <receiptA> <receiptB>')
  .description('Diff two execution receipts')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (receiptA, receiptB, options) => {
    try {
      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const receiptRegistry = new ReceiptRegistry('gagent');
      const a = await receiptRegistry.getByIdOrPath(receiptA);
      const b = await receiptRegistry.getByIdOrPath(receiptB);
      if (!a || !b) {
        console.error(chalk.red('[GAgent] Both receipts must exist'));
        process.exit(1);
      }

      const diff = receiptRegistry.diff(a, b);
      if (options.json) {
        console.log(JSON.stringify(diff, null, 2));
      } else if (!options.quiet) {
        console.log(chalk.blue('[GAgent] Receipt Diff'));
        console.log(`  Verdict: ${diff.verdict.from} -> ${diff.verdict.to}`);
        console.log(`  Overall score: ${diff.overall_score.from} -> ${diff.overall_score.to} (${diff.overall_score.delta >= 0 ? '+' : ''}${diff.overall_score.delta.toFixed(3)})`);
        console.log(`  Cost: $${diff.cost_usd.from.toFixed(4)} -> $${diff.cost_usd.to.toFixed(4)} (${diff.cost_usd.delta >= 0 ? '+' : ''}${diff.cost_usd.delta.toFixed(4)})`);
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Receipt diff failed:'), error);
      process.exit(1);
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
  .command('models')
  .description('Show configured model tiers')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action((options) => {
    const models = {
      tier1: config.get('models.tier1') || process.env.GAGENT_TIER1_MODEL || 'claude-haiku-4-5-20251001',
      tier2: config.get('models.tier2') || process.env.GAGENT_TIER2_MODEL || 'claude-sonnet-4-6',
      tier3: config.get('models.tier3') || process.env.GAGENT_TIER3_MODEL || 'gpt-4o',
      default_tier: config.get('models.default_tier') || 'tier1',
    };
    if (options.json) {
      console.log(JSON.stringify(models, null, 2));
    } else if (!options.quiet) {
      console.log(chalk.blue('[GAgent] Model Tiers'));
      for (const [tier, model] of Object.entries(models)) {
        console.log(`  ${tier}: ${model}`);
      }
    }
  });

program
  .command('tier')
  .description('View or update the default model tier')
  .option('--set <tier>', 'Set default tier (tier1, tier2, tier3)')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    const validTiers = ['tier1', 'tier2', 'tier3'];
    if (options.set) {
      if (!validTiers.includes(options.set)) {
        console.error(chalk.red('[GAgent] --set must be one of: tier1, tier2, tier3'));
        process.exit(1);
      }
      await config.set('models.default_tier', options.set);
    }
    const current = config.get('models.default_tier') || 'tier1';
    if (options.json) {
      console.log(JSON.stringify({ default_tier: current }, null, 2));
    } else if (!options.quiet) {
      console.log(chalk.blue(`[GAgent] Default tier: ${current}`));
    }
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
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const { BudgetLedger } = await import('./core/budget-ledger.js');
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
          breakdown['by_operation'] = ledger.getSpendByOperation();
        }
        console.log(JSON.stringify({ spend, ...breakdown }, null, 2));
      } else if (!options.quiet) {
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
          const byOp = ledger.getSpendByOperation();
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
  .option('--baseline-file <path>', 'Versioned JSONL baseline file for per-dimension regression gates', 'gagent/test/baselines/regression-baselines.jsonl')
  .option('--against <receipt>', 'Compare latest receipt against a baseline receipt path or ID')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      if (options.against) {
        await runReceiptRegression(options.against, options);
        return;
      }

      if (options.baselineFile) {
        const { ReceiptRegistry } = await import('./core/receipt-registry.js');
        const { loadRegressionBaselines, evaluateRegressionGates } = await import('./core/regression-gates.js');
        const receiptRegistry = new ReceiptRegistry('gagent');
        const latest = await receiptRegistry.getLatest();
        if (latest) {
          const baselines = await loadRegressionBaselines(options.baselineFile);
          const gate = evaluateRegressionGates(latest, baselines);
          if (options.json) {
            console.log(JSON.stringify(gate, null, 2));
          } else if (!options.quiet) {
            console.log(chalk.blue('[GAgent] Regression Gates'));
            for (const result of gate.results) {
              const status = result.passed ? chalk.green('PASSED') : chalk.red('FAILED');
              console.log(`  ${result.dimension}: ${status} current=${result.current.toFixed(4)} baseline=${result.baseline.toFixed(4)} tolerance=${result.tolerance}`);
            }
          }
          process.exit(gate.passed ? 0 : 1);
        }
      }

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
  .option('--window <duration>', 'Current analysis window, e.g. 7d, 24h, 30m', '7d')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action(async (options) => {
    try {
      const { ReceiptRegistry } = await import('./core/receipt-registry.js');
      const { analyzeCohortDrift, executionReceiptToCohortSnapshot, parseWindowDuration } = await import('./core/drift-analysis.js');
      const windowMs = parseWindowDuration(options.window);
      const registry = new ReceiptRegistry('gagent');

      const now = new Date();
      const start = new Date(now.getTime() - windowMs * 2);
      const receipts = await registry.getAllBetween(start, now);
      const snapshots = receipts.map(executionReceiptToCohortSnapshot);
      const driftResults = analyzeCohortDrift(snapshots, { windowMs, now, seed: 'gagent-drift' });
      const alerts = driftResults.filter(result =>
        result.anomalies.length > 0 || result.frustration_wilson_95_ci.degraded,
      );

      const result = {
        drifted: alerts.length > 0,
        window: options.window,
        cohorts: driftResults,
        drift_results: driftResults,
        alerts,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log(chalk.blue('[GAgent] Drift Detection'));
        const driftColor = alerts.length > 0 ? 'red' : 'green';
        const driftLabel = alerts.length > 0 ? 'DRIFT DETECTED' : 'No drift';
        console.log(`  Status: ${chalk[driftColor](driftLabel)}`);
        console.log(`  Window: ${options.window}`);
        console.log(`  Receipts checked: ${receipts.length}`);
        console.log(`  Cohorts tracked: ${driftResults.length}`);
        for (const cohort of driftResults) {
          const status = cohort.anomalies.length > 0 || cohort.frustration_wilson_95_ci.degraded ? chalk.red('ALERT') : chalk.green('OK');
          const escalation = cohort.anomalies.filter((anomaly: any) => anomaly.metric === 'escalation_rate').length;
          console.log(`  ${status} ${cohort.cohort}: samples=${cohort.sample_size} anomalies=${cohort.anomalies.length} escalation_alerts=${escalation}`);
        }
      }

      process.exit(alerts.length > 0 ? 1 : 0);
    } catch (error) {
      console.error(chalk.red('[GAgent] Drift detection failed:'), error);
      process.exit(1);
    }
  });

program
  .command('completion')
  .description('Print shell completion script')
  .argument('[shell]', 'Shell type: bash, zsh, or fish', 'bash')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress output for CI use')
  .action((shell, options) => {
    const normalized = String(shell).toLowerCase();
    const script = buildCompletionScript(normalized);
    if (!script) {
      console.error(chalk.red('[GAgent] Shell must be one of: bash, zsh, fish'));
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify({ shell: normalized, script }, null, 2));
    } else if (!options.quiet) {
      console.log(script);
    }
  });

function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

async function runReceiptRegression(against: string | undefined, options: any): Promise<void> {
  if (!against) {
    console.error(chalk.red('[GAgent] --against is required for receipt regression'));
    process.exit(1);
  }

  const { ReceiptRegistry } = await import('./core/receipt-registry.js');
  const receiptRegistry = new ReceiptRegistry('gagent');
  const baseline = await receiptRegistry.getByIdOrPath(against);
  const latest = await receiptRegistry.getLatest();

  if (!baseline || !latest) {
    console.error(chalk.red('[GAgent] Baseline and latest receipts must both exist'));
    process.exit(1);
  }

  const diff = receiptRegistry.diff(baseline, latest);
  const regressionPassed =
    latest.overall_score >= baseline.overall_score &&
    latest.hard_gates_passed &&
    latest.verdict !== 'fail';

  const result = {
    passed: regressionPassed,
    baseline_receipt: baseline.receipt_id,
    current_receipt: latest.receipt_id,
    baseline_score: baseline.overall_score,
    current_score: latest.overall_score,
    delta: latest.overall_score - baseline.overall_score,
    diff,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.quiet) {
    console.log(chalk.blue('[GAgent] Receipt Regression Check'));
    console.log(`  Status: ${regressionPassed ? chalk.green('PASSED') : chalk.red('FAILED')}`);
    console.log(`  Baseline: ${baseline.receipt_id} (${baseline.overall_score.toFixed(3)})`);
    console.log(`  Current: ${latest.receipt_id} (${latest.overall_score.toFixed(3)})`);
    console.log(`  Delta: ${result.delta >= 0 ? chalk.green(`+${result.delta.toFixed(3)}`) : chalk.red(result.delta.toFixed(3))}`);
  }

  process.exit(regressionPassed ? 0 : 1);
}

function buildCompletionScript(shell: string): string | null {
  const commands = [
    'init',
    'health',
    'run',
    'sync',
    'config',
    'serve',
    'brain',
    'stack',
    'orc',
    'mirror',
    'tom',
    'learn',
    'run-parallel',
    'run-verified',
    'run-safe',
    'run-smart',
    'eval',
    'replay',
    'receipts',
    'diff',
    'registry',
    'models',
    'tier',
    'cost',
    'trend',
    'regress',
    'drift',
    'completion',
  ];
  const options = [
    '--help',
    '--version',
    '--json',
    '--quiet',
    '--cycles',
    '--budget-usd',
    '--parallel',
    '--verify',
    '--cognitive-check',
    '--learn',
    '--full',
    '--dry-run',
    '--corpus',
    '--against',
  ];
  const words = [...commands, ...options].join(' ');

  if (shell === 'bash') {
    return `_gagent_completions()
{
  local cur
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _gagent_completions gagent`;
  }

  if (shell === 'zsh') {
    return `#compdef gagent
_arguments '1:command:(${commands.join(' ')})' '*::option:(${options.join(' ')})'`;
  }

  if (shell === 'fish') {
    return [
      ...commands.map(command => `complete -c gagent -f -a ${command}`),
      ...options.map(option => `complete -c gagent -f -l ${option.slice(2)}`),
    ].join('\n');
  }

  return null;
}

program.parse();
