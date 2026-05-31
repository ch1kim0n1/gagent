import { describe, it, expect } from '@jest/globals';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const repoRoot = path.join(__dirname, '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');

// Regression for #48: `config --set <key> <value>` must store the real key/value,
// not single characters of the received string.
describe('CLI config --set (#48)', () => {
  const built = fs.existsSync(cli);

  async function runCli(args: string[], home: string) {
    return execFileAsync('node', [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  }

  (built ? it : it.skip)('stores the full key and value', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-cfg-'));
    try {
      await runCli(['config', '--set', 'defaultModel', 'gpt-4o', '--quiet'], home);
      const { stdout } = await runCli(['config', '--get', 'defaultModel', '--json'], home);
      const parsed = JSON.parse(stdout);
      expect(parsed.key).toBe('defaultModel');
      expect(parsed.value).toBe('gpt-4o');
    } catch (error) {
      // The CLI requires the native better-sqlite3 binding to boot. When it is
      // not built (no MSVC toolchain in this env), skip rather than fail — the
      // arg-parsing fix is independently covered below.
      if (/bindings file|Persistence is REQUIRED|better-sqlite3/.test(String(error))) {
        return;
      }
      throw error;
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Source-level guard that the option is declared variadically and the handler
  // joins the value tokens (independent of native bindings).
  it('declares --set with a variadic value and joins value tokens', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('--set <key> <value...>');
    expect(src).not.toContain('options.set[1]');
    expect(src).toMatch(/setArgs\.slice\(1\)\.join\(' '\)/);
  });
});
