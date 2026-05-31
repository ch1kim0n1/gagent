import { describe, it, expect } from '@jest/globals';
import { ToolRegistry } from '../src/tools/registry';
import { GAgentConfig } from '../src/config/manager';

// Regression for #51: execSafe must treat a non-zero exit as failure (reject),
// not resolve as if the tool were healthy.
describe('ToolRegistry.execSafe exit-code handling (#51)', () => {
  function makeRegistry(): any {
    return new ToolRegistry(new GAgentConfig());
  }

  it('rejects when the process exits non-zero', async () => {
    const registry = makeRegistry();
    await expect(
      registry.execSafe(process.execPath, ['-e', 'process.exit(3)']),
    ).rejects.toThrow(/exited with code 3/);
  });

  it('resolves with stdout when the process exits zero', async () => {
    const registry = makeRegistry();
    const { stdout } = await registry.execSafe(process.execPath, ['-e', 'process.stdout.write("v1.2.3")']);
    expect(stdout).toContain('v1.2.3');
  });
});
