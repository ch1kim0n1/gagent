import { describe, it, expect } from '@jest/globals';
import { SecureHealthServer } from '../src/core/public-health-server';

// Regression for #55: rate-limit window map must be bounded / evict stale entries.
describe('SecureHealthServer rate-limit eviction (#55)', () => {
  it('evicts windows older than the 60s window on access', () => {
    const server: any = new SecureHealthServer(
      async () => ({ status: 'healthy' }) as any,
      async () => ({ status: 'ready' }) as any,
    );

    // Insert an already-stale window directly.
    server.windows.set('stale-ip', { count: 5, startedAt: Date.now() - 120_000 });
    expect(server.windows.size).toBe(1);

    // Any checkRate call prunes stale entries first.
    server.checkRate('fresh-ip');
    expect(server.windows.has('stale-ip')).toBe(false);
    expect(server.windows.has('fresh-ip')).toBe(true);
  });

  it('caps the map size at the configured maximum', () => {
    const server: any = new SecureHealthServer(
      async () => ({ status: 'healthy' }) as any,
      async () => ({ status: 'ready' }) as any,
    );
    server.maxWindows = 50;
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      // Fresh (non-stale) windows so only the hard cap can evict them.
      server.windows.set(`ip-${i}`, { count: 0, startedAt: now });
    }
    server.checkRate('trigger');
    expect(server.windows.size).toBeLessThanOrEqual(51);
  });
});
