import { expect, test } from 'bun:test';
import { researchCountryContext } from './report.js';
import { planCountryResearch, type ResearchPlan } from './query_planner.js';
import { runProviders, type CountryIntelProvider } from './provider_registry.js';
import { resolveRegion } from './region.js';

function stubProvider(id: string, areas: string[], items: any[]): CountryIntelProvider {
  return {
    id, areas, latencyClass: 'delayed', defaultTtlSeconds: 60,
    async run() { return { items }; },
  };
}

test('preserves provider provenance for every acquired item', async () => {
  const region = resolveRegion('South Korea');
  const plan: ResearchPlan = planCountryResearch(
    { region: 'South Korea' }, region,
    [{ id: 'provider-a', areas: ['politics'] }, { id: 'provider-b', areas: ['economy'] }],
    [],
  );
  const result = await runProviders(plan, [
    stubProvider('provider-a', ['politics'], [{ evidence: { id: 'a1' } }]),
    stubProvider('provider-b', ['economy'], [{ evidence: { id: 'b1' } }]),
  ], { cache: null });
  expect(result.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerId: 'provider-a' }),
    expect.objectContaining({ providerId: 'provider-b' }),
  ]));
});

test('does not credit provider A with provider B evidence', async () => {
  const politicsEvidence = {
    id: 'ev-politics-1', regionId: 'country:KR', url: 'https://example.kr/politics-1',
    sourceType: 'major_local_media' as const, primarySource: false,
    latencyClass: 'near_realtime' as const, retrievedAt: '2026-09-19T00:00:00Z',
  };
  const report = await researchCountryContext({ region: 'South Korea' }, {
    providers: [
      stubProvider('provider-a', ['politics'], [{ evidence: politicsEvidence }]),
      stubProvider('provider-b', ['economy'], [{ metric: { key: 'm', current: 1, window: 'yearly', direction: 'unknown' as const } }]),
    ],
    cache: null,
    now: () => new Date('2026-09-19T00:00:00Z'),
  });
  expect(report.coverage.byArea.politics).toBe('good');
  expect(report.coverage.byArea.economy).toBe('limited');
});
