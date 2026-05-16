// Import PIIRedactor and EthicalRefusalClassifier directly — no services needed.
// Redacts PII from a sample message, then classifies whether the proposed insight
// should be refused for ethical reasons.
//
// Both classes work fully offline with the heuristic fallback path
// (no LLM key required for the heuristic path; provide ANTHROPIC_API_KEY for LLM path).
//
// Setup: npm install && npm run build  (in gagent/)
// No running services required.
//
// Usage: node examples/redact-and-classify.js

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

async function main() {
  let PIIRedactor, EthicalRefusalClassifier;
  try {
    ({ PIIRedactor } = require('../dist/core/pii-redactor.js'));
    ({ EthicalRefusalClassifier } = require('../dist/core/ethical-refusal-classifier.js'));
  } catch {
    console.log('Built dist not found — run "npm run build" in gagent/ first.');
    console.log('\nThis example shows:');
    console.log('  1. PIIRedactor.redactText()   — strips phones, emails, addresses');
    console.log('  2. EthicalRefusalClassifier.classify() — detects harmful insights');
    process.exit(0);
  }

  // --- Step 1: Redact PII ---
  const redactor = new PIIRedactor({
    redact_phone_numbers: true,
    redact_names: true,
    redact_locations: true,
    hash_contact_ids: true,
    knownNames: ['Alice', 'Bob'],
  });

  const rawMessage = {
    rowid: 1,
    text: 'Hey Alice, call me at 555-867-5309 or email bob@example.com. Meet at 123 Main St.',
    handle_id: '+15558675309',
    date: 0,
  };

  const redacted = redactor.redact(rawMessage);
  console.log('--- PII Redaction ---');
  console.log('Original:', rawMessage.text);
  console.log('Redacted:', redacted.text);
  console.log();

  // --- Step 2: Classify whether the proposed insight should be refused ---
  // The heuristic path works without an LLM key.
  const mockLlmClient = {
    async call() { throw new Error('no llm in this example — heuristic path used'); },
  };

  const classifier = new EthicalRefusalClassifier(mockLlmClient);

  const testCases = [
    {
      label: 'Normal insight (should pass)',
      input: {
        message_window: Array.from({ length: 15 }, (_, i) => ({
          rowid: i,
          text: `This is message ${i} with normal content.`,
          participant_id: 'p1',
          timestamp: new Date().toISOString(),
        })),
        proposed_insight: 'The conversation shows a pattern of supportive communication.',
        insight_type: 'bid_classification',
      },
    },
    {
      label: 'Blame-assigning insight (should be refused)',
      input: {
        message_window: Array.from({ length: 15 }, (_, i) => ({
          rowid: i,
          text: `Message ${i}`,
          participant_id: 'p1',
          timestamp: new Date().toISOString(),
        })),
        proposed_insight: 'You are always at fault for the problems in this relationship.',
        insight_type: 'emotion_label',
      },
    },
  ];

  for (const { label, input } of testCases) {
    const result = await classifier.classify(input);
    console.log(`--- ${label} ---`);
    console.log(`  Should refuse: ${result.should_refuse}`);
    console.log(`  Reason:        ${result.reason ?? 'none'}`);
    console.log(`  Confidence:    ${result.confidence}`);
    console.log(`  Explanation:   ${result.explanation}`);
    console.log();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
