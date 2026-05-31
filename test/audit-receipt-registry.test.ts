import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ReceiptRegistry, canonicalJSON } from '../src/core/receipt-registry.js';

function baseReceipt(overrides: Record<string, any> = {}): any {
  return {
    receipt_id: crypto.randomUUID(),
    schema_version: 1,
    timestamp: new Date().toISOString(),
    project: 'gagent',
    rubric_name: 'gagent_v1',
    input_hash: 'abcdef1234567890abcdef1234567890',
    models_used: ['model-a'],
    config_hash: '1234567890abcdef',
    overall_score: 0.8,
    cost_usd: 0.01,
    metadata: { task: 'test task' },
    ...overrides,
  };
}

describe('ReceiptRegistry audit fixes', () => {
  let secretDir: string;
  const projectName = `gagent-audit-receipt-${Date.now()}`;
  const root = path.join(process.cwd(), projectName);

  beforeEach(async () => {
    secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gagent-secret-'));
    process.env.GAGENT_SECRET_DIR = secretDir;
    delete process.env.RECEIPT_SIGNATURE_KEY;
  });

  afterEach(async () => {
    delete process.env.GAGENT_SECRET_DIR;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(secretDir, { recursive: true, force: true }).catch(() => {});
  });

  // #49
  it('does not throw when appending a receipt missing input_hash; derives corpus_sha8', async () => {
    const registry = new ReceiptRegistry(projectName);
    const r = baseReceipt();
    delete r.input_hash;
    await expect(registry.append(r)).resolves.toBeUndefined();

    const latest = await registry.getLatest();
    expect(latest).not.toBeNull();
    const sha8 = (latest as any).metadata.corpus_sha8;
    expect(typeof sha8).toBe('string');
    expect(sha8).toHaveLength(8);
  });

  // #58: canonical serialization is order-independent
  it('canonicalJSON is stable regardless of key insertion order', () => {
    expect(canonicalJSON({ b: 1, a: 2, nested: { y: 1, x: 2 } })).toBe(
      canonicalJSON({ a: 2, nested: { x: 2, y: 1 }, b: 1 }),
    );
  });

  // #58: stripped signature is rejected when a signing key is configured
  it('rejects a receipt whose signature was stripped (tamper detection)', async () => {
    const registry = new ReceiptRegistry(projectName);
    await registry.append(baseReceipt());

    // Locate the JSONL receipt file and strip _signature from the last line.
    const baselines = path.join(root, 'test', 'baselines');
    const files = (await fs.readdir(baselines)).filter((f) => f.startsWith('receipts-') && f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const file = path.join(baselines, files[0]);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]);
    delete parsed._signature;
    lines[lines.length - 1] = JSON.stringify(parsed);
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const registry2 = new ReceiptRegistry(projectName);
    await expect(registry2.getLatest()).rejects.toThrow(/integrity failure/i);
  });
});
