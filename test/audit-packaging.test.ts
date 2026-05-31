import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Regression for #41 (package ships code) and #42 (export paths resolve).
describe('packaging contract', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('has build hooks that build dist before publishing/packing', () => {
    expect(pkg.scripts.prepack).toContain('build');
    expect(pkg.scripts.prepublishOnly).toContain('build');
  });

  it('declares main and types', () => {
    expect(pkg.main).toBe('./dist/sdk.js');
    expect(pkg.types).toBe('./dist/sdk.d.ts');
  });

  it('points every export/types/main/bin at a flat dist path (never dist/gagent/src)', () => {
    const collected: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') collected.push(v);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(pkg.main);
    walk(pkg.types);
    walk(pkg.bin);
    walk(pkg.exports);
    expect(collected.length).toBeGreaterThan(0);
    for (const target of collected) {
      expect(target).toMatch(/^\.\/dist\//);
      expect(target).not.toContain('dist/gagent/src');
    }
  });

  it('resolves every declared target to a built file when dist is present', () => {
    if (!existsSync(join(root, 'dist'))) {
      // dist is only present after `npm run build`; skip in source-only checkouts.
      return;
    }
    const collected: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') collected.push(v);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(pkg.main);
    walk(pkg.types);
    walk(pkg.bin);
    walk(pkg.exports);
    for (const target of collected) {
      expect(existsSync(join(root, target))).toBe(true);
    }
  });
});
