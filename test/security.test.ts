import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FileSecretManager,
  PermissionModel,
  sanitizeCliFloat,
  sanitizeCliInteger,
  sanitizeCliString,
} from '../src/core/security';

describe('security controls', () => {
  it('rotates secrets and never exposes values from list output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gagent-secrets-'));
    try {
      const manager = new FileSecretManager(dir);
      const first = manager.rotate('openai_api_key', 'first-value');
      const second = manager.rotate('openai_api_key', 'second-value');
      const listed = manager.list();

      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      expect(manager.get('openai_api_key')).toBe('second-value');
      expect(JSON.stringify(listed)).not.toContain('second-value');
      expect(listed[0]).toMatchObject({ name: 'openai_api_key', version: 2, source: 'file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('narrows token scopes through hashed permission grants', () => {
    const token = 'local-token';
    const hash = createHash('sha256').update(token).digest('hex');
    const permissions = new PermissionModel(new Map([[hash, ['read']]]));

    expect(permissions.scopesForToken(token, ['read', 'write'])).toEqual(['read']);
    expect(permissions.scopesForToken('unknown', ['read', 'write'])).toEqual(['read', 'write']);
  });

  it('sanitizes user-facing CLI inputs', () => {
    expect(sanitizeCliString('task', 'task')).toBe('task');
    expect(() => sanitizeCliString('bad\0task', 'task')).toThrow('NUL');
    expect(sanitizeCliInteger('4', 'parallel', 1, 8)).toBe(4);
    expect(() => sanitizeCliInteger('100', 'parallel', 1, 8)).toThrow('between 1 and 8');
    expect(sanitizeCliFloat('2.5', 'budget', 0.01, 10)).toBe(2.5);
    expect(() => sanitizeCliFloat('0', 'budget', 0.01, 10)).toThrow('between 0.01 and 10');
  });

  it('pins generic tool detection to absolute dot-directory binaries', () => {
    const source = readFileSync(join(__dirname, '../src/tools/registry.ts'), 'utf8');
    const detectGeneric = source.slice(
      source.indexOf('private async detectGeneric'),
      source.indexOf('async healthCheck'),
    );

    expect(detectGeneric).toContain('join(homedir(), `.${name}`)');
    expect(detectGeneric).toContain("const binaryName = process.platform === 'win32' ? `${name}.exe` : name");
    expect(detectGeneric).toContain('const binaryPath = join(toolPath, binaryName)');
    expect(detectGeneric).toContain("this.execSafe(binaryPath, ['--version'])");
    expect(detectGeneric).not.toContain('process.env.HOME || process.env.USERPROFILE');
  });

  it('uses rate-limited health endpoints with token-protected shutdown', () => {
    const source = readFileSync(join(__dirname, '../src/core/public-health-server.ts'), 'utf8');

    expect(source).toContain('GAGENT_HEALTH_RATE_LIMIT_RPM');
    expect(source).toContain("get('health_shutdown_token')");
    expect(source).toContain("error: 'rate_limited'");
    expect(source).toContain('/health/shutdown');
  });

  it('documents permission file shape without writing live tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gagent-permissions-'));
    const previous = process.env.GAGENT_PERMISSIONS_FILE;
    try {
      const token = 'scoped-token';
      const file = join(dir, 'permissions.json');
      writeFileSync(file, JSON.stringify({
        tokens: {
          [createHash('sha256').update(token).digest('hex')]: ['read'],
        },
      }));
      process.env.GAGENT_PERMISSIONS_FILE = file;

      const permissions = PermissionModel.loadDefault();
      expect(permissions.scopesForToken(token, ['read', 'write'])).toEqual(['read']);
    } finally {
      if (previous === undefined) {
        delete process.env.GAGENT_PERMISSIONS_FILE;
      } else {
        process.env.GAGENT_PERMISSIONS_FILE = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
