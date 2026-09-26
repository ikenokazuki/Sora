import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SORA_VERSION } from './types.js';
describe('version contract', () => {
  test('runtime matches package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SORA_VERSION).toBe(pkg.version);
    expect(SORA_VERSION).toBe('2.30.4');
  });
  test('detailed health reports the same version', async () => {
    const { checkDetailedHealth } = await import('./services/health.js');
    const report = await checkDetailedHealth();
    expect(report.version).toBe(SORA_VERSION);
  });
});
