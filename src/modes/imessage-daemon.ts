import * as os from 'os';
import * as path from 'path';
import { DaemonRunner } from '../core/daemon-runner.js';
import { GAgentPersistenceManager } from '../core/gagent-persistence.js';
import { defaultDyadRedactor } from '../core/pii-redactor.js';
import { RawMessage, RedactedMessage } from '../types/index.js';

export interface IMessageDaemonOptions {
  intervalMs: number;
  dryRun?: boolean;
  chatDbPath?: string;
  onMessage?: (msg: RedactedMessage) => Promise<void>;
}

export function createIMessageDaemon(
  persistenceManager: GAgentPersistenceManager,
  options: IMessageDaemonOptions,
): DaemonRunner {
  const redactor = defaultDyadRedactor();
  const dbPath = options.chatDbPath || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

  return new DaemonRunner({
    mode: 'daemon',
    source: 'imessage',
    poll_interval_ms: options.intervalMs,
    checkpoint_key: 'imessage',
    dry_run: options.dryRun,
    poll: async (lastRowid) => pollMessages(dbPath, lastRowid),
    on_message: async (message) => {
      const redacted = redactor.redact(message);
      await options.onMessage?.(redacted);
    },
  }, persistenceManager);
}

function pollMessages(dbPath: string, lastRowid: number): RawMessage[] {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT message.ROWID AS rowid, message.text AS text, handle.id AS handle_id, message.date AS date
      FROM message
      LEFT JOIN handle ON handle.ROWID = message.handle_id
      WHERE message.ROWID > ?
      ORDER BY message.ROWID ASC
    `).all(lastRowid).map((row: any) => ({
      rowid: Number(row.rowid),
      text: String(row.text || ''),
      handle_id: String(row.handle_id || ''),
      date: Number(row.date || 0),
    }));
  } finally {
    db.close();
  }
}
