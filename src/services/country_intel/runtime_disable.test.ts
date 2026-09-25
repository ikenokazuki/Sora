import { afterEach, expect, test } from 'bun:test';
import { createDefaultCountryIntelDependencies, disabledCountryIntelProviders } from './runtime.js';
const previous = process.env.SORA_INTEL_DISABLED;
afterEach(() => {
  if (previous === undefined) delete process.env.SORA_INTEL_DISABLED;
  else process.env.SORA_INTEL_DISABLED = previous;
});
test('disabledCountryIntelProviders parses env list', () => {
  process.env.SORA_INTEL_DISABLED = 'usgs, eonet,,bluesky';
  expect([...disabledCountryIntelProviders()].sort()).toEqual(['bluesky', 'eonet', 'usgs']);
});
test('env denylist removes providers from defaults', () => {
  process.env.SORA_INTEL_DISABLED = 'usgs,eonet';
  const ids = createDefaultCountryIntelDependencies().providers.map((p) => p.id);
  expect(ids).not.toContain('usgs');
  expect(ids).not.toContain('eonet');
  expect(ids).toContain('gdacs');
});
test('explicit option overrides env', () => {
  process.env.SORA_INTEL_DISABLED = 'usgs';
  const ids = createDefaultCountryIntelDependencies({}, { disabledProviders: ['gdacs'], scrapeArticle: undefined }).providers.map((p) => p.id);
  expect(ids).not.toContain('gdacs');
  expect(ids).toContain('usgs');
});
