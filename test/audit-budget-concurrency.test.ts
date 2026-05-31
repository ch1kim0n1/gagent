import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BudgetLedger } from '../src/core/budget-ledger';

// Regression for #53: concurrent reserves (separate ledger instances sharing the
// same audit dir, simulating separate processes) cannot exceed the global cap,
// and reservations survive a "restart" (new instance loading from disk).
describe('BudgetLedger cross-instance accounting (#53)', () => {
  function makeAuditDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-budget-conc-'));
  }

  it('two instances sharing a dir cannot jointly exceed the cap', async () => {
    const dir = makeAuditDir();
    const a = new BudgetLedger({ max_budget_usd: 1 }, 'gagent', dir);
    const b = new BudgetLedger({ max_budget_usd: 1 }, 'gagent', dir);
    await a.init();
    await b.init();

    a.reserve('op-a', 0.7);
    // b must see a's reservation (loaded/locked from disk) and refuse to overspend.
    expect(() => b.reserve('op-b', 0.7)).toThrow(/Budget exceeded/);

    // A smaller reservation that fits is allowed.
    expect(() => b.reserve('op-b2', 0.2)).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reservations survive a restart (new instance reloads from disk)', async () => {
    const dir = makeAuditDir();
    const first = new BudgetLedger({ max_budget_usd: 1 }, 'gagent', dir);
    await first.init();
    first.reserve('op', 0.8);

    const restarted = new BudgetLedger({ max_budget_usd: 1 }, 'gagent', dir);
    await restarted.init();
    const status = restarted.getStatus();
    expect(status.total_reserved).toBeGreaterThanOrEqual(0.8);
    expect(status.remaining_budget).toBeLessThanOrEqual(0.2 + 1e-9);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
