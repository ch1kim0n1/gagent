import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DaemonRunner } from '../src/core/daemon-runner';
import { GAgentPersistenceManager } from '../src/core/gagent-persistence';

describe('DaemonRunner', () => {
  it('persists checkpoints and exits cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-daemon-'));
    const persistence = new GAgentPersistenceManager(path.join(dir, 'gagent.db'));
    let handled = 0;
    let polls = 0;
    const daemon = new DaemonRunner({
      mode: 'daemon',
      source: 'imessage',
      poll_interval_ms: 1,
      checkpoint_key: 'imessage',
      poll: async () => {
        polls++;
        return polls === 1
          ? [{ rowid: 10, text: 'hello', handle_id: '+13125550100', date: 0 }]
          : [];
      },
      on_message: async () => {
        handled++;
      },
    }, persistence);

    await daemon.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    await daemon.stop();

    expect(handled).toBe(1);
    expect(daemon.getCheckpoint()).toBe(10);
    expect(persistence.getCheckpoint('imessage')).toBe(10);
    persistence.close();
  });
});
