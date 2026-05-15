import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BudgetReservation {
  id: string;
  operation: string;
  reserved_usd: number;
  committed_usd: number;
  created_at: string;
  expires_at: string;
  status: 'reserved' | 'committed' | 'expired' | 'released';
  metadata?: Record<string, any>;
}

export interface SpendEntry {
  timestamp: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  operation: string;
  reservation_id?: string;
  metadata?: Record<string, any>;
}

export interface BudgetLedgerConfig {
  max_budget_usd: number;
  alert_threshold_usd?: number;
  default_ttl_ms?: number;
  scope_caps_usd?: Record<string, number>;
}

export class BudgetLedger {
  private reservations = new Map<string, BudgetReservation>();
  private spend: SpendEntry[] = [];
  private auditDir: string;

  constructor(
    private config: BudgetLedgerConfig,
    private toolName = 'gagent',
    auditDir?: string,
  ) {
    this.config = {
      default_ttl_ms: 30 * 60 * 1000,
      ...config,
    };
    this.auditDir = auditDir || path.join(os.homedir(), `.${toolName}`, 'audit');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.auditDir, { recursive: true });
    await this.loadSpendFile(this.spendLedgerPath());
  }

  reserve(
    operation: string,
    amountUsd: number,
    ttlMs?: number,
    metadata?: Record<string, any>,
  ): BudgetReservation {
    this.cleanupExpired();
    const scope = typeof metadata?.scope === 'string' ? metadata.scope : 'default';
    const scopeCap = this.config.scope_caps_usd?.[scope];
    if (scopeCap !== undefined && this.getScopeSpend(scope) + amountUsd > scopeCap) {
      throw new Error(`Scope budget exceeded for ${scope}: requested $${amountUsd.toFixed(4)}, cap $${scopeCap.toFixed(4)}`);
    }

    const status = this.getStatus();
    if (amountUsd > status.remaining_budget) {
      throw new Error(`Budget exceeded: requested $${amountUsd.toFixed(4)}, remaining $${status.remaining_budget.toFixed(4)}`);
    }

    const now = new Date();
    const reservation: BudgetReservation = {
      id: `res_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      operation,
      reserved_usd: amountUsd,
      committed_usd: 0,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (ttlMs ?? this.config.default_ttl_ms!)).toISOString(),
      status: 'reserved',
      metadata,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  async commit(
    reservationId: string,
    actualCostUsd: number,
    spend?: Omit<SpendEntry, 'timestamp' | 'cost_usd' | 'reservation_id'>,
  ): Promise<BudgetReservation> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'reserved') {
      throw new Error(`Reservation is not active: ${reservationId}`);
    }
    reservation.status = 'committed';
    reservation.committed_usd = actualCostUsd;
    this.reservations.set(reservationId, reservation);

    if (spend) {
      await this.recordSpend({
        ...spend,
        timestamp: new Date().toISOString(),
        cost_usd: actualCostUsd,
        reservation_id: reservationId,
      });
    }
    return reservation;
  }

  release(reservationId: string): BudgetReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'reserved') {
      throw new Error(`Reservation is not active: ${reservationId}`);
    }
    reservation.status = 'released';
    this.reservations.set(reservationId, reservation);
    return reservation;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'reserved' && new Date(reservation.expires_at).getTime() <= now) {
        reservation.status = 'expired';
        this.reservations.set(reservation.id, reservation);
        count++;
      }
    }
    return count;
  }

  async recordSpend(entry: SpendEntry): Promise<void> {
    this.spend.push(entry);
    await fs.promises.mkdir(this.auditDir, { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await fs.promises.appendFile(this.spendLedgerPath(), line, 'utf8');
    await fs.promises.appendFile(this.rollupPath(entry.timestamp), line, 'utf8');
  }

  getDailySpend(): number {
    return this.getSpendSince(1);
  }

  getWeeklySpend(): number {
    return this.getSpendSince(7);
  }

  getMonthlySpend(): number {
    return this.getSpendSince(30);
  }

  getSpendByModel(): Record<string, number> {
    return this.groupSpendBy('model_id');
  }

  getSpendByOperation(): Record<string, number> {
    return this.groupSpendBy('operation');
  }

  getStatus() {
    this.cleanupExpired();
    const reserved = Array.from(this.reservations.values())
      .filter(r => r.status === 'reserved')
      .reduce((sum, r) => sum + r.reserved_usd, 0);
    const committed = this.spend.reduce((sum, entry) => sum + entry.cost_usd, 0);
    return {
      max_budget_usd: this.config.max_budget_usd,
      total_reserved: reserved,
      total_committed: committed,
      remaining_budget: this.config.max_budget_usd - reserved - committed,
      utilization_rate: this.config.max_budget_usd > 0 ? (reserved + committed) / this.config.max_budget_usd : 1,
    };
  }

  getStats() {
    const reservations = Array.from(this.reservations.values());
    return {
      ...this.getStatus(),
      total_reservations: reservations.length,
      active_reservations: reservations.filter(r => r.status === 'reserved').length,
      committed_reservations: reservations.filter(r => r.status === 'committed').length,
      expired_reservations: reservations.filter(r => r.status === 'expired').length,
      released_reservations: reservations.filter(r => r.status === 'released').length,
      daily_spend_usd: this.getDailySpend(),
      weekly_spend_usd: this.getWeeklySpend(),
      monthly_spend_usd: this.getMonthlySpend(),
      by_model: this.getSpendByModel(),
      by_operation: this.getSpendByOperation(),
    };
  }

  private getSpendSince(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.spend
      .filter(entry => new Date(entry.timestamp).getTime() >= cutoff)
      .reduce((sum, entry) => sum + entry.cost_usd, 0);
  }

  private getScopeSpend(scope: string): number {
    return this.spend
      .filter(entry => entry.metadata?.scope === scope)
      .reduce((sum, entry) => sum + entry.cost_usd, 0);
  }

  private groupSpendBy(key: 'model_id' | 'operation'): Record<string, number> {
    const grouped: Record<string, number> = {};
    for (const entry of this.spend) {
      grouped[entry[key]] = (grouped[entry[key]] || 0) + entry.cost_usd;
    }
    return grouped;
  }

  private spendLedgerPath(): string {
    return path.join(this.auditDir, 'spend-ledger.jsonl');
  }

  private rollupPath(timestamp: string): string {
    return path.join(this.auditDir, `cost-${this.weekKey(new Date(timestamp))}.jsonl`);
  }

  private weekKey(date: Date): string {
    const start = new Date(date.getFullYear(), 0, 1);
    const week = Math.ceil(((date.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
    return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  private async loadSpendFile(filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        const entry = parsed.type === 'spend' && parsed.data ? parsed.data : parsed;
        if (typeof entry.cost_usd === 'number' && typeof entry.timestamp === 'string') {
          this.spend.push(entry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
