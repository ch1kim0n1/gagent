import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BudgetLedger } from '../src/core/budget-ledger';

describe('BudgetLedger', () => {
  function makeAuditDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-budget-'));
  }

  it('reserves, commits, and writes weekly cost rollups', async () => {
    const auditDir = makeAuditDir();
    const ledger = new BudgetLedger({ max_budget_usd: 1 }, 'gagent', auditDir);
    await ledger.init();

    const reservation = ledger.reserve('winner_judgment', 0.05, 60_000, {
      scope: 'pipeline',
      resolver: 'winner_judgment',
    });
    await ledger.commit(reservation.id, 0.0123, {
      model_id: 'claude-haiku-4-5-20251001',
      input_tokens: 100,
      output_tokens: 20,
      operation: 'winner_judgment',
      metadata: { scope: 'pipeline', resolver: 'winner_judgment' },
    });

    expect(ledger.getDailySpend()).toBeCloseTo(0.0123, 6);
    expect(ledger.getSpendByModel()['claude-haiku-4-5-20251001']).toBeCloseTo(0.0123, 6);
    expect(ledger.getSpendByOperation()['winner_judgment']).toBeCloseTo(0.0123, 6);
    expect(fs.readdirSync(auditDir).some(file => /^cost-\d{4}-W\d{2}\.jsonl$/.test(file))).toBe(true);
  });

  it('expires stale reservations and enforces scope caps', async () => {
    const auditDir = makeAuditDir();
    const ledger = new BudgetLedger({
      max_budget_usd: 1,
      scope_caps_usd: { pipeline: 0.01 },
    }, 'gagent', auditDir);
    await ledger.init();

    const stale = ledger.reserve('verification_decision', 0.005, -1, { scope: 'pipeline' });
    expect(ledger.cleanupExpired()).toBe(1);
    expect(ledger.getStats().expired_reservations).toBe(1);
    expect(() => ledger.release(stale.id)).toThrow('Reservation is not active');

    expect(() => ledger.reserve('too_expensive', 0.02, 60_000, { scope: 'pipeline' }))
      .toThrow('Scope budget exceeded');
  });
});
