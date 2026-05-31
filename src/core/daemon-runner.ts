import { GAgentPersistenceManager } from './gagent-persistence.js';
import { RawMessage } from '../types/index.js';

export interface DaemonExecutionConfig {
  mode: 'daemon';
  source: 'imessage' | 'file_watch' | 'webhook';
  poll_interval_ms: number;
  checkpoint_key: string;
  on_message: (msg: RawMessage) => Promise<void>;
  poll?: (lastRowid: number) => Promise<RawMessage[]>;
  dry_run?: boolean;
  /** Max attempts per message before it is dead-lettered (default 3). */
  max_attempts?: number;
  /**
   * Invoked when a message exhausts all retry attempts. If provided, the
   * checkpoint advances past the dead-lettered message (it has been handed
   * off, not dropped). If absent, the checkpoint does NOT advance and the
   * message is retried on the next poll, guaranteeing no silent data loss.
   */
  on_dead_letter?: (msg: RawMessage, error: unknown) => Promise<void>;
}

export class DaemonRunner {
  private stopped = true;
  private checkpoint = 0;
  private loop?: Promise<void>;

  constructor(
    private readonly config: DaemonExecutionConfig,
    private readonly persistenceManager: GAgentPersistenceManager,
  ) {
    this.checkpoint = persistenceManager.getCheckpoint(config.checkpoint_key) || 0;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.runLoop();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  getCheckpoint(): number {
    return this.checkpoint;
  }

  private get maxAttempts(): number {
    const v = this.config.max_attempts;
    return Number.isInteger(v) && (v as number) > 0 ? (v as number) : 3;
  }

  private advanceCheckpoint(rowid: number): void {
    this.checkpoint = Math.max(this.checkpoint, rowid);
    this.persistenceManager.saveCheckpoint(this.config.checkpoint_key, this.checkpoint);
  }

  /**
   * Process a single message with bounded retries.
   * @returns true if the checkpoint may advance past this message
   *          (succeeded or dead-lettered); false if it must be retried later.
   */
  private async processMessage(message: RawMessage): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.config.on_message(message);
        return true;
      } catch (error) {
        lastError = error;
        console.error(
          `Message handler failed for rowid ${message.rowid} (attempt ${attempt}/${this.maxAttempts})`,
          error,
        );
        if (attempt < this.maxAttempts && !this.stopped) {
          await delay(backoffMs(attempt));
        }
      }
    }

    // Retries exhausted.
    if (this.config.on_dead_letter) {
      try {
        await this.config.on_dead_letter(message, lastError);
        // Successfully handed off — safe to advance.
        return true;
      } catch (dlqError) {
        console.error('Dead-letter handler failed for rowid', message.rowid, dlqError);
      }
    }

    // No dead-letter (or it failed): do NOT advance. The message stays unprocessed
    // and will be retried on the next poll. This prevents silent data loss.
    console.error(
      `Halting checkpoint advance at rowid ${message.rowid}; message will be retried on next poll`,
    );
    return false;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let messages: RawMessage[] = [];
      try {
        messages = this.config.poll ? await this.config.poll(this.checkpoint) : [];
      } catch (error) {
        // A poll failure must not kill the loop; back off and retry.
        console.error('Daemon poll failed; will retry after interval', error);
        await delay(this.config.poll_interval_ms);
        continue;
      }

      for (const message of messages) {
        if (this.stopped) break;

        if (this.config.dry_run) {
          console.log(JSON.stringify({ source: this.config.source, rowid: message.rowid, dry_run: true }));
          this.advanceCheckpoint(message.rowid);
          continue;
        }

        const canAdvance = await this.processMessage(message);
        if (canAdvance) {
          this.advanceCheckpoint(message.rowid);
        } else {
          // Stop advancing past the failed message; break and retry next poll.
          break;
        }
      }

      await delay(this.config.poll_interval_ms);
    }
  }
}

function backoffMs(attempt: number): number {
  // Exponential backoff capped at 5s: 100ms, 200ms, 400ms, ...
  return Math.min(100 * 2 ** (attempt - 1), 5000);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
