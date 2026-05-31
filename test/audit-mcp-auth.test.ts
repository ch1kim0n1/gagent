import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import { createAuthMiddleware } from '../src/mcp/server';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Craft a token in the server's `gat_v1.<payload>.<sig>` format with a chosen exp.
function craftToken(secret: string, expEpoch: number, scopes: string[]): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ scopes, iat: Math.floor(Date.now() / 1000), exp: expEpoch, jti: 'test' }), 'utf8'),
  );
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `gat_v1.${payload}.${sig}`;
}

// Regression for #44: MCP auth must verify tokens, not accept all.
describe('MCP auth middleware (#44)', () => {
  const SECRET = 'a-strong-test-secret-value-1234567890';

  beforeEach(() => { delete process.env.GAGENT_ALLOW_DEV_SECRET; });
  afterEach(() => { delete process.env.GAGENT_ALLOW_DEV_SECRET; });

  function mw(secret = SECRET) {
    return createAuthMiddleware({ secret, tool: 'gagent', defaultRoles: ['read', 'write'] });
  }

  it('rejects arbitrary bearer tokens', () => {
    const auth = mw();
    expect(auth.authenticate('Bearer anything').success).toBe(false);
    expect(auth.authenticate('Bearer ').success).toBe(false);
    expect(auth.authenticate(undefined).success).toBe(false);
  });

  it('accepts a token it issued and returns its scopes', () => {
    const auth = mw();
    const issued = auth.issueToken(['read', 'write']);
    expect(issued.success).toBe(true);
    const verified = auth.authenticate(`Bearer ${issued.token}`);
    expect(verified.success).toBe(true);
    expect(verified.scopes).toEqual(['read', 'write']);
  });

  it('rejects a token signed with a different secret (forgery)', () => {
    const issued = mw('secret-A-aaaaaaaaaaaaaaaaaaaaaaaa').issueToken(['read']);
    const other = mw('secret-B-bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(other.authenticate(`Bearer ${issued.token}`).success).toBe(false);
  });

  it('rejects an expired token', () => {
    const auth = mw();
    const expired = craftToken(SECRET, Math.floor(Date.now() / 1000) - 60, ['read']);
    expect(auth.authenticate(`Bearer ${expired}`).success).toBe(false);
  });

  it('fails closed with the insecure default secret unless explicitly allowed', () => {
    const insecure = mw('dev-secret-key');
    expect(insecure.enabled).toBe(false);
    expect(insecure.issueToken(['read']).success).toBe(false);
    expect(insecure.authenticate('Bearer x').success).toBe(false);

    process.env.GAGENT_ALLOW_DEV_SECRET = 'true';
    const dev = mw('dev-secret-key');
    expect(dev.enabled).toBe(true);
    const issued = dev.issueToken(['read']);
    expect(issued.success).toBe(true);
    expect(dev.authenticate(`Bearer ${issued.token}`).success).toBe(true);
  });
});
