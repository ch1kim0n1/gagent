import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExecutionReceipt } from '../types/quality-rubric.js';

/**
 * Simple PII redaction for receipts
 */
function redactPII(receipt: any): any {
  if (!receipt || typeof receipt !== 'object') {
    return receipt;
  }

  const redacted = { ...receipt };
  
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
    if (typeof redacted[key] === 'string') {
      // Redact potential API keys (32+ char alphanumeric strings)
      if (redacted[key].length >= 32 && /^[a-zA-Z0-9]+$/.test(redacted[key])) {
        redacted[key] = '[REDACTED]';
      }
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactPII(redacted[key]);
    }
  }
  
  return redacted;
}

/**
 * Sign a receipt with HMAC-SHA256 for tamper detection
 */
function signReceipt(receipt: any, key: string): string {
  const hmac = crypto.createHmac('sha256', key);
  const content = JSON.stringify(receipt);
  hmac.update(content);
  return hmac.digest('hex');
}

/**
 * Verify a receipt signature
 */
function verifyReceipt(receipt: any, signature: string, key: string): boolean {
  const hmac = crypto.createHmac('sha256', key);
  const content = JSON.stringify(receipt);
  hmac.update(content);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export class ReceiptRegistry {
  private basePath: string;
  private week: string;  // ISO week YYYY-Www
  private signatureKey: string | null;

  constructor(projectName: string) {
    const now = new Date();
    const year = now.getFullYear();
    const weekNum = getISOWeek(now);
    this.week = `${year}-W${String(weekNum).padStart(2, '0')}`;
    this.basePath = path.join(process.cwd(), projectName, 'test', 'baselines', `receipts-${this.week}.jsonl`);
    
    // Load signature key from env (optional)
    this.signatureKey = process.env.RECEIPT_SIGNATURE_KEY || null;
  }

  async append(receipt: ExecutionReceipt): Promise<void> {
    const dir = path.dirname(this.basePath);
    await fs.mkdir(dir, { recursive: true });
    
    // Apply PII redaction before writing
    const redactedReceipt = redactPII(receipt);
    
    // Add signature if key is available
    let outputReceipt: any = redactedReceipt;
    if (this.signatureKey) {
      outputReceipt = {
        ...redactedReceipt,
        _signature: signReceipt(redactedReceipt, this.signatureKey),
        _signed_at: new Date().toISOString(),
      };
    }
    
    const line = JSON.stringify(outputReceipt) + '\n';
    await fs.appendFile(this.basePath, line, 'utf8');
  }

  async getLatest(): Promise<ExecutionReceipt | null> {
    try {
      const content = await fs.readFile(this.basePath, 'utf8');
      const lines = content.trim().split('\n').filter((l: string) => l);
      if (lines.length === 0) return null;
      const lastLine = lines[lines.length - 1];
      const receipt = JSON.parse(lastLine);
      
      // Verify signature if present
      if (receipt._signature && this.signatureKey) {
        const { _signature, _signed_at, ...data } = receipt;
        if (!verifyReceipt(data, _signature, this.signatureKey)) {
          console.warn('[ReceiptRegistry] Last receipt signature verification failed');
        }
      }
      
      return receipt as ExecutionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getAllBetween(start: Date, end: Date): Promise<ExecutionReceipt[]> {
    const receipts: ExecutionReceipt[] = [];
    try {
      const content = await fs.readFile(this.basePath, 'utf8');
      const lines = content.trim().split('\n').filter((l: string) => l);
      for (const line of lines) {
        const receipt = JSON.parse(line) as ExecutionReceipt;
        const timestamp = new Date(receipt.timestamp);
        if (timestamp >= start && timestamp <= end) {
          // Verify signature if present
          if ((receipt as any)._signature && this.signatureKey) {
            const { _signature, _signed_at, ...data } = receipt as any;
            if (!verifyReceipt(data, _signature, this.signatureKey)) {
              console.warn('[ReceiptRegistry] Receipt signature verification failed:', receipt.timestamp);
            }
          }
          receipts.push(receipt);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return receipts;
  }
}

export class ReceiptRegistry {
  private basePath: string;
  private week: string;  // ISO week YYYY-Www

  constructor(projectName: string) {
    const now = new Date();
    const year = now.getFullYear();
    const weekNum = getISOWeek(now);
    this.week = `${year}-W${String(weekNum).padStart(2, '0')}`;
    this.basePath = path.join(process.cwd(), projectName, 'test', 'baselines', `receipts-${this.week}.jsonl`);
  }

  async append(receipt: ExecutionReceipt): Promise<void> {
    const dir = path.dirname(this.basePath);
    await fs.mkdir(dir, { recursive: true });
    
    // Apply PII redaction before writing
    const redactedReceipt = redactPII(receipt);
    const line = JSON.stringify(redactedReceipt) + '\n';
    await fs.appendFile(this.basePath, line, 'utf8');
  }

  async getLatest(): Promise<ExecutionReceipt | null> {
    try {
      const content = await fs.readFile(this.basePath, 'utf8');
      const lines = content.trim().split('\n').filter((l: string) => l);
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]) as ExecutionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getAllBetween(start: Date, end: Date): Promise<ExecutionReceipt[]> {
    const receipts: ExecutionReceipt[] = [];
    try {
      const content = await fs.readFile(this.basePath, 'utf8');
      const lines = content.trim().split('\n').filter((l: string) => l);
      for (const line of lines) {
        const receipt = JSON.parse(line) as ExecutionReceipt;
        const timestamp = new Date(receipt.timestamp);
        if (timestamp >= start && timestamp <= end) {
          receipts.push(receipt);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return receipts;
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
