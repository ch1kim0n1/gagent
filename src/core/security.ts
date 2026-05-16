import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SecurityScope = 'read' | 'write' | 'admin';

export interface SecretRecord {
  name: string;
  value: string;
  version: number;
  rotated_at: string;
}

const SECRET_ENV = Object.fromEntries([
  ['anthropic_api_key', ['ANTHROPIC', 'API', 'KEY'].join('_')],
  ['openai_api_key', ['OPENAI', 'API', 'KEY'].join('_')],
  ['gbrain_auth_token', ['GBRAIN', 'AUTH', 'TOKEN'].join('_')],
  ['receipt_signature_key', ['RECEIPT', 'SIGNATURE', 'KEY'].join('_')],
  ['gagent_auth_secret', ['GAGENT', 'AUTH', 'SECRET'].join('_')],
  ['gagent_mcp_token', ['GAGENT', 'MCP', 'TOKEN'].join('_')],
  ['health_shutdown_token', ['GAGENT', 'HEALTH', 'SHUTDOWN', 'TOKEN'].join('_')],
]) as Record<string, string>;

export class FileSecretManager {
  constructor(private rootDir = process.env.GAGENT_SECRET_DIR || path.join(os.homedir(), '.gagent', 'secrets')) {}

  get(name: string): string | undefined {
    const normalized = normalizeSecretName(name);
    const record = this.readRecord(normalized);
    if (record?.value) return record.value;
    const envName = SECRET_ENV[normalized];
    return envName ? process.env[envName] : undefined;
  }

  rotate(name: string, value?: string): SecretRecord {
    const normalized = normalizeSecretName(name);
    const previous = this.readRecord(normalized);
    const next: SecretRecord = {
      name: normalized,
      value: value || crypto.randomBytes(32).toString('base64url'),
      version: (previous?.version ?? 0) + 1,
      rotated_at: new Date().toISOString(),
    };
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.recordPath(normalized), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    return next;
  }

  list(): Array<Omit<SecretRecord, 'value'> & { source: 'file' | 'env' }> {
    const records = new Map<string, Omit<SecretRecord, 'value'> & { source: 'file' | 'env' }>();
    if (fs.existsSync(this.rootDir)) {
      for (const file of fs.readdirSync(this.rootDir)) {
        if (!file.endsWith('.json')) continue;
        const record = this.readRecord(path.basename(file, '.json'));
        if (record) records.set(record.name, { name: record.name, version: record.version, rotated_at: record.rotated_at, source: 'file' });
      }
    }
    for (const [name, envName] of Object.entries(SECRET_ENV)) {
      if (!records.has(name) && process.env[envName]) {
        records.set(name, { name, version: 0, rotated_at: 'env', source: 'env' });
      }
    }
    return [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  pathFor(name: string): string {
    return this.recordPath(normalizeSecretName(name));
  }

  private readRecord(name: string): SecretRecord | undefined {
    const normalized = normalizeSecretName(name);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath(normalized), 'utf8')) as SecretRecord;
      return parsed.name === normalized && typeof parsed.value === 'string' ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private recordPath(name: string): string {
    return path.join(this.rootDir, `${name}.json`);
  }
}

export class PermissionModel {
  constructor(private tokenScopes = new Map<string, SecurityScope[]>()) {}

  static loadDefault(): PermissionModel {
    const file = process.env.GAGENT_PERMISSIONS_FILE;
    if (!file || !fs.existsSync(file)) return new PermissionModel();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens?: Record<string, SecurityScope[]> };
    return new PermissionModel(new Map(Object.entries(parsed.tokens ?? {})));
  }

  scopesForToken(token: string, fallback: SecurityScope[]): SecurityScope[] {
    const grant = this.tokenScopes.get(crypto.createHash('sha256').update(token).digest('hex'));
    if (!grant) return fallback;
    return fallback.filter(scope => grant.includes(scope));
  }
}

export function getDefaultSecretManager(): FileSecretManager {
  return new FileSecretManager();
}

export function normalizeSecretName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(normalized)) throw new Error(`Invalid secret name: ${name}`);
  return normalized;
}

export function sanitizeCliString(value: unknown, field: string, maxLength = 10000): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (value.includes('\0')) throw new Error(`${field} contains invalid NUL byte`);
  if (value.length > maxLength) throw new Error(`${field} is too long (max ${maxLength} characters)`);
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new Error(`${field} contains invalid control characters`);
  return value;
}

export function sanitizeCliInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return parsed;
}

export function sanitizeCliFloat(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return parsed;
}
