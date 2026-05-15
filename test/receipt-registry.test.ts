import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { ReceiptRegistry } from '../src/core/receipt-registry.js';
import { ExecutionReceipt } from '../src/types/quality-rubric.js';

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  const inputHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  return {
    receipt_id: crypto.randomUUID(),
    schema_version: 1,
    timestamp: new Date().toISOString(),
    project: 'gagent',
    rubric_name: 'gagent_v1',
    rubric_sha8: inputHash.substring(0, 8),
    input_hash: inputHash,
    models_used: ['model-a'],
    config_hash: '1234567890abcdef',
    verdict: 'pass',
    scores: {
      overall_score: { score: 0.8, confidence: 0.9, weight: 1 },
    },
    overall_score: 0.8,
    hard_gates_passed: true,
    cost_usd: 0.01,
    metadata: { task: 'test task' },
    ...overrides,
  };
}

describe('ReceiptRegistry audit features', () => {
  const projectName = `gagent-receipt-test-${Date.now()}`;
  const root = path.join(process.cwd(), projectName);
  const baselines = path.join(root, 'test', 'baselines');

  afterEach(async () => {
    delete process.env.GAGENT_RECEIPT_STORE_PATH;
    delete process.env.RECEIPT_RETENTION_DAYS;
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(os.homedir(), `.${projectName}`), { recursive: true, force: true });
  });

  it('locks appends, annotates retention, mirrors to durable store, and retrieves by corpus_sha8', async () => {
    const durablePath = path.join(root, 'durable', 'receipts.jsonl');
    process.env.GAGENT_RECEIPT_STORE_PATH = durablePath;
    const registry = new ReceiptRegistry(projectName);
    const receipts = [receipt(), receipt({ overall_score: 0.9 })];

    await Promise.all(receipts.map(item => registry.append(item)));

    const byCorpus = await registry.getByCorpusSha8('abcdef12');
    expect(byCorpus).toHaveLength(2);
    expect(byCorpus[0].metadata?.corpus_sha8).toBe('abcdef12');
    expect(byCorpus[0].metadata?.expires_at).toBeDefined();

    const durableContent = await fs.readFile(durablePath, 'utf8');
    const durableLines = durableContent.trim().split('\n');
    expect(durableLines).toHaveLength(2);
    expect(JSON.parse(durableLines[0])._signature).toBeDefined();
  });

  it('diffs receipts and migrates missing schema_version during read', async () => {
    const registry = new ReceiptRegistry(projectName);
    const baseline = receipt({ overall_score: 0.7, cost_usd: 0.02 });
    const current = receipt({ overall_score: 0.9, cost_usd: 0.03 });

    await registry.append({ ...baseline, schema_version: undefined as any });
    await registry.append(current);

    const migrated = await registry.getByIdOrPath(baseline.receipt_id);
    expect(migrated?.schema_version).toBe(1);
    expect(migrated?.metadata?.schema_migration).toBeDefined();

    const diff = registry.diff(migrated!, current);
    expect(diff.overall_score.delta).toBeCloseTo(0.2);
    expect(diff.cost_usd.delta).toBeCloseTo(0.01);
  });

  it('archives receipt files older than retention policy', async () => {
    process.env.RECEIPT_RETENTION_DAYS = '28';
    const registry = new ReceiptRegistry(projectName);
    await fs.mkdir(baselines, { recursive: true });
    const oldFile = path.join(baselines, 'receipts-2000-W01.jsonl');
    const oldReceipt = receipt({ timestamp: '2000-01-01T00:00:00.000Z' });
    await fs.writeFile(oldFile, `${JSON.stringify(oldReceipt)}\n`, 'utf8');

    await registry.archiveExpiredReceipts(new Date('2000-02-15T00:00:00.000Z'));

    await expect(fs.stat(oldFile)).rejects.toHaveProperty('code', 'ENOENT');
    await expect(fs.stat(path.join(baselines, 'archive', 'receipts-2000-W01.jsonl'))).resolves.toBeDefined();
  });
});
