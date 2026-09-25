import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { planCountryResearch } from './query_planner.js';
import { defaultProviderCache, runProviderPass, type CountryIntelProvider } from './provider_registry.js';
import { resolveRegion } from './region.js';
let directory = '';
let previousDatabasePath: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'intel-cache-'));
  previousDatabasePath = process.env.SORA_DB_PATH;
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  if (previousDatabasePath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousDatabasePath;
});
test('default cache serves second call and noCache refetches', async () => {
  const region = resolveRegion('South Korea');
  let calls = 0;
  const stub: CountryIntelProvider = {
    id: 'stub-cache', areas: ['calendar'], latencyClass: 'delayed', defaultTtlSeconds: 3600,
    async run() { calls += 1; return { items: [] }; },
  };
  const plan = planCountryResearch({ region: 'South Korea' }, region, [{ id: 'stub-cache', areas: ['calendar'] }], []);
  const first = await runProviderPass(plan, 1, [stub], { cache: defaultProviderCache });
  expect(calls).toBe(1);
  const second = await runProviderPass(plan, 1, [stub], { cache: defaultProviderCache });
  expect(calls).toBe(1);
  expect(second.items).toEqual(first.items);
  await runProviderPass(plan, 1, [stub], { cache: defaultProviderCache, noCache: true });
  expect(calls).toBe(2);
});
