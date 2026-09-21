import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SORA_VERSION } from './types.js';
describe('version contract', () => {
  test('runtime matches package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SORA_VERSION).toBe(pkg.version);
    expect(SORA_VERSION).toBe('2.27.0');
  });
});
