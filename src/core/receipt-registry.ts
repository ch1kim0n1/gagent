import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { ExecutionReceipt } from '../types/quality-rubric.js';
import { coreLogger } from './observability.js';
import { getDefaultSecretManager } from './security.js';
import { defaultDyadRedactor } from './pii-redactor.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ReceiptSchemaMetadata {
  version: number;
  supported_versions: number[];
  created_at: string;
  migration_path: Record<string, string>;
  retention_days: number;
}

// Reuse a single redactor across receipts (hot path). Rebuild only if the
// known-names env input changes, to avoid per-receipt construction / env parsing.
let cachedDyadRedactor: ReturnType<typeof defaultDyadRedactor> | null = null;
let cachedDyadRedactorEnvKey: string | null = null;

function getDyadRedactor(): ReturnType<typeof defaultDyadRedactor> {
  const envKey = process.env.DYAD_KNOWN_NAMES || '';
  if (!cachedDyadRedactor || cachedDyadRedactorEnvKey !== envKey) {
    cachedDyadRedactor = defaultDyadRedactor();
    cachedDyadRedactorEnvKey = envKey;
  }
  return cachedDyadRedactor;
}

/**
 * Simple PII redaction for receipts
 */
function redactPII(receipt: any): any {
  if (!receipt || typeof receipt !== 'object') {
    return receipt;
  }

  if (Array.isArray(receipt)) {
    return receipt.map(item => redactPII(item));
  }

  const redacted = { ...receipt };
  const hashFields = new Set(['receipt_id', 'rubric_sha8', 'input_hash', 'config_hash', 'corpus_sha8']);
  const dyadRedactionEnabled = process.env.DYAD_PII_REDACTION !== 'false';
  const dyadRedactor = getDyadRedactor();

  if (!dyadRedactionEnabled) {
    coreLogger.warn('DYAD PII redaction is disabled for development use');
  }
  
  // Redact email addresses
  if (redacted.user_email) {
    redacted.user_email = '[REDACTED]';
  }
  
  // Redact API keys
  if (redacted.api_key) {
    redacted.api_key = '[REDACTED]';
  }
  
  // Redact sensitive fields recursively
  for (const key in redacted) {
    if (hashFields.has(key)) {
      continue;
    }

    if (typeof redacted[key] === 'string') {
      // Redact potential API keys (32+ char alphanumeric strings)
      if (redacted[key].length >= 32 && /^[a-zA-Z0-9]+$/.test(redacted[key])) {
        redacted[key] = '[REDACTED]';
      } else if (dyadRedactionEnabled) {
        redacted[key] = dyadRedactor.redactText(redacted[key]);
      }
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactPII(redacted[key]);
    }
  }
  
  return redacted;
}

/**
 * Canonical JSON serialization: recursively sorts object keys so the signed
 * content is stable across processes/versions regardless of insertion order.
 * (Number formatting follows JSON.stringify, which is deterministic for the
 * finite numbers used in receipts.)
 */
export function canonicalJSON(value: any): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Sign a receipt with HMAC-SHA256 (over canonical JSON) for tamper detection.
 */
function signReceipt(receipt: any, key: string): string {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(canonicalJSON(receipt));
  return hmac.digest('hex');
}

/**
 * Verify a receipt signature against canonical JSON.
 */
function verifyReceipt(receipt: any, signature: string, key: string): boolean {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(canonicalJSON(receipt));
  const expected = hmac.digest('hex');
  if (typeof signature !== 'string' || expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export class ReceiptRegistry {
  private basePath: string;
  private baseDir: string;
  private archiveDir: string;
  private signatureKeyPath: string;
  private schemaPath: string;
  private week: string;  // ISO week YYYY-Www
  private signatureKey: string;
  private readonly SCHEMA_VERSION = 1;
  private readonly RETENTION_DAYS = parseInt(process.env.RECEIPT_RETENTION_DAYS || '28', 10);
  private readonly ready: Promise<void>;

  constructor(projectName: string) {
    const now = new Date();
    const year = now.getFullYear();
    const weekNum = getISOWeek(now);
    this.week = `${year}-W${String(weekNum).padStart(2, '0')}`;
    this.baseDir = path.join(process.cwd(), projectName, 'test', 'baselines');
    this.archiveDir = path.join(this.baseDir, 'archive');
    this.basePath = path.join(this.baseDir, `receipts-${this.week}.jsonl`);
    this.schemaPath = path.join(this.baseDir, `schema.json`);
    this.signatureKeyPath = path.join(os.homedir(), `.${projectName}`, 'receipt-signing.key');
    
    // Load signature key through the secret manager, or create a local HMAC key during initialization.
    this.signatureKey = getDefaultSecretManager().get('receipt_signature_key') || '';
    
    // Initialize persistence - fail loudly if cannot create directory
    this.ready = this.initializePersistence();
  }

  private async initializePersistence(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.mkdir(this.archiveDir, { recursive: true });
      await this.ensureReceiptFile();
      await this.ensureSignatureKey();
      
      // Initialize schema metadata
      await this.initializeSchema();
    } catch (error) {
      throw new Error(`Persistence initialization failed: ${error}. Persistence is REQUIRED for GAgent.`);
    }
  }

  private async initializeSchema(): Promise<void> {
    try {
      const existingSchema = await this.readSchema();
      if (existingSchema && existingSchema.version !== this.SCHEMA_VERSION) {
        coreLogger.warn('Receipt schema version mismatch. Migration may be required.', {
          expected: this.SCHEMA_VERSION,
          actual: existingSchema.version,
        });
      }
      
      if (!existingSchema) {
        await this.writeSchema();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.writeSchema();
      } else {
        throw error;
      }
    }
  }

  private async readSchema(): Promise<ReceiptSchemaMetadata | null> {
    try {
      const content = await fs.readFile(this.schemaPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeSchema(): Promise<void> {
    const schema = {
      version: this.SCHEMA_VERSION,
      supported_versions: [this.SCHEMA_VERSION],
      created_at: new Date().toISOString(),
      migration_path: {
        'missing->1': 'Receipts without schema_version are treated as v1 and annotated during read.',
      },
      retention_days: this.RETENTION_DAYS,
    };
    await fs.writeFile(this.schemaPath, JSON.stringify(schema, null, 2), 'utf8');
  }

  async append(receipt: ExecutionReceipt): Promise<void> {
    await this.ready;

    // Apply PII redaction before writing
    const redactedReceipt = this.prepareReceipt(redactPII(receipt));
    
    // Add signature if key is available
    let outputReceipt: any = redactedReceipt;
    outputReceipt = {
      ...redactedReceipt,
      _signature: signReceipt(redactedReceipt, this.signatureKey),
      _signed_at: new Date().toISOString(),
    };
    
    const line = JSON.stringify(outputReceipt) + '\n';
    await this.withReceiptLock(async () => {
      await fs.appendFile(this.basePath, line, 'utf8');
    });
    await this.pushDurable(outputReceipt);
    await this.archiveExpiredReceipts();
  }

  async getLatest(): Promise<ExecutionReceipt | null> {
    await this.ready;

    try {
      const files = await this.getReceiptFiles(true);
      if (files.length === 0) return null;
      const content = await fs.readFile(files[files.length - 1], 'utf8');
      const lines = content.trim().split('\n').filter((l: string) => l);
      if (lines.length === 0) return null;
      const lastLine = lines[lines.length - 1];
      const receipt = this.migrateReceipt(JSON.parse(lastLine));
      
      this.assertSignatureValid(receipt);

      return receipt as ExecutionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getAllBetween(start: Date, end: Date): Promise<ExecutionReceipt[]> {
    await this.ready;

    const receipts: ExecutionReceipt[] = [];
    try {
      const files = await this.getReceiptFiles(true);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf8');
        const lines = content.trim().split('\n').filter((l: string) => l);
        for (const line of lines) {
          const receipt = this.migrateReceipt(JSON.parse(line));
          const timestamp = new Date(receipt.timestamp);
          if (timestamp < start || timestamp > end) {
            continue;
          }

          this.assertSignatureValid(receipt);
          receipts.push(receipt);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return receipts.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async getByIdOrPath(identifier: string): Promise<ExecutionReceipt | null> {
    await this.ready;

    try {
      const stat = await fs.stat(identifier);
      if (stat.isFile()) {
        const content = await fs.readFile(identifier, 'utf8');
        const line = content.trim().split('\n').filter(Boolean).pop();
        return line ? this.migrateReceipt(JSON.parse(line)) : null;
      }
    } catch {
      // Identifier is not a readable path; search registry files below.
    }

    const receipts = await this.getAllBetween(new Date(0), new Date('9999-12-31T23:59:59.999Z'));
    return receipts.find((receipt: any) =>
      receipt.receipt_id === identifier ||
      receipt.id === identifier ||
      receipt.request_id === identifier
    ) || null;
  }

  async getByCorpusSha8(corpusSha8: string): Promise<ExecutionReceipt[]> {
    await this.ready;

    const normalized = corpusSha8.toLowerCase();
    const receipts = await this.getAllBetween(new Date(0), new Date('9999-12-31T23:59:59.999Z'));
    return receipts.filter((receipt: any) =>
      String(receipt.metadata?.corpus_sha8 || '').toLowerCase() === normalized ||
      String(receipt.input_hash || '').toLowerCase().startsWith(normalized)
    );
  }

  diff(a: ExecutionReceipt, b: ExecutionReceipt): Record<string, any> {
    return {
      receipt_a: a.receipt_id,
      receipt_b: b.receipt_id,
      timestamp_delta_ms: new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      verdict: { from: a.verdict, to: b.verdict, changed: a.verdict !== b.verdict },
      overall_score: {
        from: a.overall_score,
        to: b.overall_score,
        delta: b.overall_score - a.overall_score,
      },
      cost_usd: {
        from: a.cost_usd,
        to: b.cost_usd,
        delta: b.cost_usd - a.cost_usd,
      },
      hard_gates_passed: {
        from: a.hard_gates_passed,
        to: b.hard_gates_passed,
        changed: a.hard_gates_passed !== b.hard_gates_passed,
      },
      models_used: {
        from: a.models_used,
        to: b.models_used,
      },
      score_deltas: this.diffScores(a, b),
    };
  }

  async archiveExpiredReceipts(now = new Date()): Promise<void> {
    await fs.mkdir(this.archiveDir, { recursive: true });
    const cutoff = now.getTime() - this.RETENTION_DAYS * DAY_MS;
    const files = await this.getReceiptFiles(false);

    for (const file of files) {
      if (path.basename(file) === path.basename(this.basePath)) {
        continue;
      }

      const maxTimestamp = await this.getFileMaxTimestamp(file);
      if (maxTimestamp !== null && maxTimestamp < cutoff) {
        await fs.rename(file, path.join(this.archiveDir, path.basename(file))).catch(async error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
          await fs.unlink(file);
        });
      }
    }
  }

  /**
   * When a signature key is configured, every receipt MUST carry a valid
   * `_signature`. A missing or invalid signature is treated as a hard integrity
   * failure (tamper / stripped signature), not a warning. Without a key, no
   * verification is performed.
   */
  private assertSignatureValid(receipt: any): void {
    if (!this.signatureKey) {
      return;
    }
    const signature = receipt?._signature;
    if (!signature) {
      throw new Error(
        `Receipt integrity failure: missing _signature while signing key is configured (receipt_id=${receipt?.receipt_id ?? 'unknown'})`,
      );
    }
    const { _signature, _signed_at, ...data } = receipt;
    void _signed_at;
    if (!verifyReceipt(data, _signature, this.signatureKey)) {
      throw new Error(
        `Receipt integrity failure: invalid _signature (receipt_id=${receipt?.receipt_id ?? 'unknown'})`,
      );
    }
  }

  private prepareReceipt(receipt: any): any {
    const migrated = this.migrateReceipt(receipt);
    const timestampMs = new Date(migrated.timestamp).getTime();
    const expiresAt = new Date(timestampMs + this.RETENTION_DAYS * DAY_MS).toISOString();
    return {
      ...migrated,
      metadata: {
        ...(migrated.metadata || {}),
        corpus_sha8:
          migrated.metadata?.corpus_sha8 || this.deriveCorpusSha8(migrated),
        expires_at: migrated.metadata?.expires_at || expiresAt,
        retention_days: this.RETENTION_DAYS,
      },
    };
  }

  /**
   * Deterministically derive an 8-char corpus hash for a receipt. Prefers an
   * existing string `input_hash`; otherwise computes a SHA-256 over the receipt
   * content so a missing/invalid `input_hash` can never throw.
   */
  private deriveCorpusSha8(receipt: any): string {
    if (typeof receipt?.input_hash === 'string' && receipt.input_hash.length > 0) {
      return receipt.input_hash.substring(0, 8);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(receipt);
    } catch {
      serialized = String(receipt?.receipt_id ?? '');
    }
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 8);
  }

  private migrateReceipt(receipt: any): any {
    const fromVersion = receipt.schema_version ?? 'missing';
    const migrated = {
      ...receipt,
      schema_version: this.SCHEMA_VERSION,
      metadata: {
        ...(receipt.metadata || {}),
      },
    };

    if (fromVersion !== this.SCHEMA_VERSION) {
      migrated.metadata.schema_migration = {
        from: fromVersion,
        to: this.SCHEMA_VERSION,
        migrated_at: new Date().toISOString(),
      };
    }

    if (migrated.input_hash && !migrated.metadata.corpus_sha8) {
      migrated.metadata.corpus_sha8 = String(migrated.input_hash).substring(0, 8);
    }

    if (migrated.timestamp && !migrated.metadata.expires_at) {
      const expiresAt = new Date(new Date(migrated.timestamp).getTime() + this.RETENTION_DAYS * DAY_MS);
      migrated.metadata.expires_at = expiresAt.toISOString();
      migrated.metadata.retention_days = this.RETENTION_DAYS;
    }

    return migrated;
  }

  private async getReceiptFiles(includeArchive: boolean): Promise<string[]> {
    const files = await this.listReceiptFiles(this.baseDir);
    if (includeArchive) {
      files.push(...await this.listReceiptFiles(this.archiveDir));
    }
    return files.sort();
  }

  private async listReceiptFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isFile() && /^receipts-.+\.jsonl$/.test(entry.name))
        .map(entry => path.join(dir, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async getFileMaxTimestamp(file: string): Promise<number | null> {
    const content = await fs.readFile(file, 'utf8');
    const timestamps = content.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return new Date(JSON.parse(line).timestamp).getTime();
        } catch {
          return Number.NaN;
        }
      })
      .filter(Number.isFinite);
    return timestamps.length > 0 ? Math.max(...timestamps) : null;
  }

  private async ensureReceiptFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.basePath), { recursive: true });
    await fs.appendFile(this.basePath, '', 'utf8');
  }

  private async ensureSignatureKey(): Promise<void> {
    if (this.signatureKey) {
      return;
    }

    await fs.mkdir(path.dirname(this.signatureKeyPath), { recursive: true });
    try {
      this.signatureKey = (await fs.readFile(this.signatureKeyPath, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.signatureKey = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(this.signatureKeyPath, this.signatureKey, { encoding: 'utf8', mode: 0o600 });
    }
  }

  // A lock older than this is considered stale (writer crashed) and reclaimed.
  private readonly LOCK_STALE_MS = parseInt(process.env.GAGENT_RECEIPT_LOCK_STALE_MS || '10000', 10);

  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age >= this.LOCK_STALE_MS) {
        coreLogger.warn('Reclaiming stale receipt lock', { lockPath, ageMs: age });
        await fs.rm(lockPath, { recursive: true, force: true });
        return true;
      }
    } catch (error) {
      // Lock vanished between checks — treat as reclaimable.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    return false;
  }

  private async withReceiptLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.basePath}.lock`;
    const deadline = Date.now() + 5000;

    while (true) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        // Stale-lock recovery: a crashed writer leaves the lock dir behind.
        // Reclaim it instead of failing forever once it is older than the TTL.
        const reclaimed = await this.reclaimStaleLock(lockPath);
        if (reclaimed) {
          continue;
        }
        if (Date.now() > deadline) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    try {
      return await operation();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  private async pushDurable(receipt: any): Promise<void> {
    const storeUrl =
      process.env.GAGENT_RECEIPT_S3_URL ||
      process.env.GAGENT_RECEIPT_STORE_URL ||
      process.env.RECEIPT_STORE_URL;
    const storePath = process.env.GAGENT_RECEIPT_STORE_PATH || process.env.RECEIPT_STORE_PATH;

    if (storeUrl) {
      const response = await fetch(storeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(receipt),
      });
      if (!response.ok) {
        throw new Error(`Durable receipt store rejected receipt: HTTP ${response.status}`);
      }
    }

    if (storePath) {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.appendFile(storePath, JSON.stringify(receipt) + '\n', 'utf8');
    }
  }

  private diffScores(a: ExecutionReceipt, b: ExecutionReceipt): Record<string, any> {
    const dimensions = new Set([...Object.keys(a.scores || {}), ...Object.keys(b.scores || {})]);
    const result: Record<string, any> = {};
    for (const dimension of dimensions) {
      result[dimension] = {
        from: a.scores?.[dimension]?.score,
        to: b.scores?.[dimension]?.score,
        delta: (b.scores?.[dimension]?.score ?? 0) - (a.scores?.[dimension]?.score ?? 0),
      };
    }
    return result;
  }
}

// Helper: Get ISO week number
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
