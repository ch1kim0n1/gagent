import { describe, it, expect } from '@jest/globals';
import { DaemonRunner } from '../src/core/daemon-runner';
import type { GAgentPersistenceManager } from '../src/core/gagent-persistence';

// Minimal in-memory persistence stub so these tests need no native SQLite.
function fakePersistence(): GAgentPersistenceManager {
  const checkpoints = new Map<string, number>();
  return {
    getCheckpoint: (k: string) => checkpoints.get(k) ?? null,
    saveCheckpoint: (k: string, v: number) => { checkpoints.set(k, v); },
  } as unknown as GAgentPersistenceManager;
}

function msg(rowid: number) {
  return { rowid, text: `m${rowid}`, handle_id: '+13125550100', date: 0 };
}

describe('DaemonRunner checkpoint advancement (#46)', () => {
  it('does NOT advance the checkpoint past a message whose handler keeps failing', async () => {
    const persistence = fakePersistence();
    let attempts = 0;
    const runner = new DaemonRunner(
      {
        mode: 'daemon',
        source: 'imessage',
        poll_interval_ms: 1,
        checkpoint_key: 'cp',
        max_attempts: 2,
        // Always returns the failing message first.
        poll: async () => [msg(5), msg(6)],
        on_message: async (m) => {
          if (m.rowid === 5) { attempts++; throw new Error('boom'); }
        },
      },
      persistence,
    );

    await runner.start();
    await new Promise((r) => setTimeout(r, 30));
    await runner.stop();

    // Checkpoint must stay below the failing rowid (no silent skip).
    expect(runner.getCheckpoint()).toBeLessThan(5);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('advances past a failed message only when a dead-letter handler accepts it', async () => {
    const persistence = fakePersistence();
    const deadLettered: number[] = [];
    const runner = new DaemonRunner(
      {
        mode: 'daemon',
        source: 'imessage',
        poll_interval_ms: 1,
        checkpoint_key: 'cp',
        max_attempts: 1,
        poll: async (last) => (last < 7 ? [msg(7)] : []),
        on_message: async () => { throw new Error('boom'); },
        on_dead_letter: async (m) => { deadLettered.push(m.rowid); },
      },
      persistence,
    );

    await runner.start();
    await new Promise((r) => setTimeout(r, 30));
    await runner.stop();

    expect(deadLettered).toContain(7);
    expect(runner.getCheckpoint()).toBe(7);
  });

  it('survives a poll() error and keeps running', async () => {
    const persistence = fakePersistence();
    let polls = 0;
    let handled = 0;
    const runner = new DaemonRunner(
      {
        mode: 'daemon',
        source: 'imessage',
        poll_interval_ms: 1,
        checkpoint_key: 'cp',
        poll: async () => {
          polls++;
          if (polls === 1) throw new Error('transient poll failure');
          return polls === 2 ? [msg(3)] : [];
        },
        on_message: async () => { handled++; },
      },
      persistence,
    );

    await runner.start();
    await new Promise((r) => setTimeout(r, 40));
    await runner.stop();

    expect(handled).toBe(1);
    expect(runner.getCheckpoint()).toBe(3);
  });
});
