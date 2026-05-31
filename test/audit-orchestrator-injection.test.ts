import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression for #43: no shell command-string interpolation in the orchestrator.
describe('orchestrator command injection (#43)', () => {
  const src = readFileSync(join(__dirname, '../src/pipeline/orchestrator.ts'), 'utf8');

  it('contains no promisify(exec) shell helper', () => {
    expect(src).not.toMatch(/promisify\s*\(\s*exec\s*\)/);
    expect(src).not.toContain('getExec()');
  });

  it('does not build shell strings from task or LLM output', () => {
    // No backtick template that pipes/echoes the task into a shell.
    expect(src).not.toMatch(/echo\s+"\$\{task\}"/);
    expect(src).not.toMatch(/gorchestrator dispatch --task "\$\{task\}"/);
    expect(src).not.toMatch(/gmirror test --input "\$\{[^}]*output\}"/);
    expect(src).not.toMatch(/gtom assess --decision "\$\{[^}]*output\}"/);
  });

  it('invokes external tools via execFile/spawn argv arrays', () => {
    expect(src).toMatch(/execFileAsync\(\s*'gorchestrator'/);
    expect(src).toMatch(/execFileAsync\(\s*'gmirror'/);
    expect(src).toMatch(/execFileAsync\(\s*'gtom'/);
    // gstack uses a no-shell spawn with stdin input.
    expect(src).toMatch(/execFileWithInput\(\s*'gstack'/);
    expect(src).toContain('shell: false');
  });
});
