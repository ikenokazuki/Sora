import { expect, test } from 'bun:test';
import { planCountryResearch } from './query_planner.js';
import { runProviderPass, type CountryIntelProvider } from './provider_registry.js';
import { resolveRegion } from './region.js';

test('pass2 runs only providers that have pass2 queries', async () => {
  const region = resolveRegion('South Korea');
  const ran: string[] = [];
  const provider = (id: string): CountryIntelProvider => ({
    id, areas: ['calendar'], latencyClass: 'delayed', defaultTtlSeconds: 60,
    async run() { ran.push(id); return { items: [] }; },
  });
  const plan = planCountryResearch({ region: 'South Korea' }, region, [{ id: 'nager', areas: ['calendar'] }], []);
  expect(plan.pass2).toEqual([]);
  const result = await runProviderPass(plan, 2, [provider('nager')], { cache: null });
  expect(ran).toEqual([]);
  expect(result.items).toEqual([]);
  expect(result.runs).toEqual([]);
});
