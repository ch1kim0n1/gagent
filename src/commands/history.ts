import chalk from 'chalk';

interface RunRecord {
  run_id: string;
  task: string;
  output: string;
  exit_code: number;
  cost_usd: number;
  timestamp: string;
}

export interface HistoryOptions {
  limit: number;
  json: boolean;
  failed: boolean;
}

function loadRuns(limit: number, failedOnly: boolean): RunRecord[] {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = path.join(process.env.HOME || '/tmp', '.gagent', 'gagent.db');
    const fs = require('fs');
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    const sql = failedOnly
      ? 'SELECT * FROM agent_runs WHERE exit_code != 0 ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT * FROM agent_runs ORDER BY timestamp DESC LIMIT ?';
    const rows = db.prepare(sql).all(limit) as RunRecord[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}

export async function historyCommand(options: HistoryOptions): Promise<void> {
  const runs = loadRuns(options.limit, options.failed);

  if (options.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  if (runs.length === 0) {
    console.log(chalk.gray('No runs found. Start with: gagent llm-run "<your task>"'));
    return;
  }

  console.log(chalk.blue(`Recent runs (${runs.length}):`));
  console.log('');

  for (const run of runs) {
    const icon = run.exit_code === 0 ? chalk.green('✓') : chalk.red('✗');
    const id = run.run_id.slice(0, 8);
    const task = run.task.length > 55 ? run.task.slice(0, 52) + '...' : run.task;
    const cost = run.cost_usd > 0 ? chalk.gray(` | $${run.cost_usd.toFixed(5)}`) : '';
    const ts = new Date(run.timestamp).toLocaleString();
    console.log(`  ${icon} [${id}] ${task}${cost}`);
    console.log(`       ${chalk.gray(ts)}`);
  }
}
