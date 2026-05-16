import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { randomUUID } from 'crypto';

// Cost rates per million tokens [input, output]
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-haiku-4-5-20251001': [0.25, 1.25],
  'claude-3-5-haiku-20241022': [0.25, 1.25],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-3-5-sonnet-20241022': [3.0, 15.0],
  'claude-opus-4-6': [15.0, 75.0],
  'claude-3-opus-20240229': [15.0, 75.0],
};

export interface RunLlmOptions {
  model: string;
  maxTokens: number;
  system?: string;
  json: boolean;
  quiet: boolean;
}

interface RunRecord {
  run_id: string;
  task: string;
  output: string;
  exit_code: number;
  cost_usd: number;
  timestamp: string;
}

function saveRunRecord(record: RunRecord): void {
  try {
    // Lazy import to avoid requiring better-sqlite3 if not available
    const Database = require('better-sqlite3');
    const path = require('path');
    const fs = require('fs');
    const dbDir = path.join(process.env.HOME || '/tmp', '.gagent');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'gagent.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      task TEXT,
      output TEXT,
      exit_code INTEGER,
      cost_usd REAL,
      timestamp TEXT
    )`);
    db.prepare(`INSERT OR REPLACE INTO agent_runs (run_id, task, output, exit_code, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      record.run_id, record.task, record.output, record.exit_code, record.cost_usd, record.timestamp
    );
    db.close();
  } catch {
    // Non-fatal: if SQLite fails, we still return the output
  }
}

export async function runLlmCommand(task: string, options: RunLlmOptions): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: ANTHROPIC_API_KEY not set'));
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const startMs = Date.now();
  const runId = randomUUID();

  if (!options.quiet && !options.json) {
    console.log(chalk.blue(`Running: ${task}`));
    console.log(chalk.gray(`Model: ${options.model} | ID: ${runId.slice(0, 8)}`));
    console.log('');
  }

  try {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      system: options.system ?? 'You are a helpful assistant. Be concise and direct.',
      messages: [{ role: 'user', content: task }],
    });

    const outputText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const elapsedMs = Date.now() - startMs;
    const { input_tokens, output_tokens } = response.usage;
    const [inRate, outRate] = MODEL_COSTS[options.model] ?? [3.0, 15.0];
    const costUsd = (input_tokens * inRate + output_tokens * outRate) / 1_000_000;

    saveRunRecord({
      run_id: runId,
      task,
      output: outputText,
      exit_code: 0,
      cost_usd: costUsd,
      timestamp: new Date().toISOString(),
    });

    if (options.json) {
      console.log(JSON.stringify({
        run_id: runId,
        task,
        output: outputText,
        model: options.model,
        tokens: { input: input_tokens, output: output_tokens },
        cost_usd: costUsd,
        elapsed_ms: elapsedMs,
      }, null, 2));
      return;
    }

    if (options.quiet) {
      console.log(outputText);
    } else {
      console.log(chalk.green('─'.repeat(60)));
      console.log(outputText);
      console.log(chalk.green('─'.repeat(60)));
      console.log('');
      console.log(chalk.gray(
        `Tokens: ${input_tokens}in/${output_tokens}out | Cost: $${costUsd.toFixed(6)} | Time: ${elapsedMs}ms | ID: ${runId.slice(0, 8)}`
      ));
    }
  } catch (err: any) {
    const elapsedMs = Date.now() - startMs;
    saveRunRecord({
      run_id: runId,
      task,
      output: err.message ?? 'unknown error',
      exit_code: 1,
      cost_usd: 0,
      timestamp: new Date().toISOString(),
    });
    if (options.json) {
      console.log(JSON.stringify({ run_id: runId, error: err.message, elapsed_ms: elapsedMs }));
    } else {
      console.error(chalk.red(`Error: ${err.message}`));
    }
    process.exit(1);
  }
}
