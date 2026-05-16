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

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const messages = this.config.poll ? await this.config.poll(this.checkpoint) : [];
      for (const message of messages) {
        if (this.config.dry_run) {
          console.log(JSON.stringify({ source: this.config.source, rowid: message.rowid, dry_run: true }));
        } else {
          await this.config.on_message(message);
        }
        this.checkpoint = Math.max(this.checkpoint, message.rowid);
      }
      if (messages.length > 0) {
        this.persistenceManager.saveCheckpoint(this.config.checkpoint_key, this.checkpoint);
      }
      await delay(this.config.poll_interval_ms);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
