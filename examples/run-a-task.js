// Run a task using GAGENT_OFFLINE_MODE=true — no GStack services required.
// In offline mode, GAgent executes the task directly via LLM without
// routing through GOrchestrator, GMirror, or GBrain.
//
// Setup: npm install && npm run build  (in gagent/)
// Env vars:
//   GAGENT_OFFLINE_MODE=true   (set below; skips all g-tool integrations)
//   ANTHROPIC_API_KEY          (required for LLM execution)
//
// Usage: node examples/run-a-task.js

process.env.GAGENT_OFFLINE_MODE = 'true';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

async function main() {
  let Pipeline;
  try {
    ({ Pipeline } = require('../dist/pipeline/orchestrator.js'));
  } catch {
    console.log('Built dist not found — run "npm run build" in gagent/ first.');
    console.log('\nWith GAGENT_OFFLINE_MODE=true, GAgent:');
    console.log('  - Skips GOrchestrator (no Docker sandbox)');
    console.log('  - Skips GMirror scoring');
    console.log('  - Skips GBrain enrichment');
    console.log('  - Calls the LLM directly for task execution');
    process.exit(0);
  }

  console.log(`GAGENT_OFFLINE_MODE=${process.env.GAGENT_OFFLINE_MODE}`);
  console.log('Running task without g-tool services...\n');

  const pipeline = new Pipeline({
    offlineMode: true,
  });

  const result = await pipeline.execute({
    task: 'Write a one-sentence description of what TypeScript is.',
    parallel: false,
    verify: false,
    cognitiveCheck: false,
    learn: false,
    budgetUsd: 0.05,
  });

  console.log('Task result:');
  console.log(`  Status:   ${result.status}`);
  console.log(`  Output:   ${result.output ?? result.best_attempt?.output ?? '(none)'}`);
  console.log(`  Cost USD: ${result.cost_usd ?? 0}`);

  if (result.status === 'error') {
    console.error('\nTask failed:', result.error);
    process.exit(1);
  }

  console.log('\nOffline task run completed successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
