import { expect, test } from 'bun:test';
import { applicableCapabilities, cappedProviderIds, inapplicableProviderIds, planCountryResearchPass1, planCountryResearchPass2 } from './query_planner.js';
import { resolveRegion } from './region.js';
import type { CountrySource } from './types.js';

const region = resolveRegion('South Korea');
const caps = [{ id: 'official_web', areas: ['official'] as const as readonly string[] }];
const verified: CountrySource = {
  id: 'src-agency', regionId: 'country:KR', domain: 'agency.example',
  sourceType: 'official', discoveredAt: '2026-09-19T00:00:00Z',
  verifiedAt: '2026-09-19T01:00:00Z', verificationStatus: 'verified', discoveryMethod: 'search',
};
const candidate: CountrySource = {
  ...verified, id: 'src-rumor', domain: 'rumor.example',
  verifiedAt: undefined, verificationStatus: 'candidate',
};

test('uses newly verified pass1 sources in pass2', () => {
  const pass1 = planCountryResearchPass1({ region: 'South Korea' }, region, caps);
  expect(pass1.length).toBeGreaterThan(0);
  const pass2 = planCountryResearchPass2({ region: 'South Korea' }, region, caps, {
    verifiedSources: [verified],
  });
  expect(pass2.some((q) => q.query.includes('agency.example'))).toBe(true);
});

test('never uses an unverified candidate in pass2', () => {
  const pass2 = planCountryResearchPass2({ region: 'South Korea' }, region, caps, {
    verifiedSources: [],
    candidates: [candidate],
  });
  expect(pass2.some((q) => q.query.includes('rumor.example'))).toBe(false);
  expect(pass2).toEqual([]);
});

test('keeps region-scoped providers out of other regions without dropping them silently', () => {
  const mixed = [
    ...caps,
    { id: 'weibo_hot', areas: ['media_activity'] as const as readonly string[], regions: ['CN'] as readonly string[] },
  ];
  const krQueries = planCountryResearchPass1({ region: 'South Korea' }, region, mixed);
  expect(krQueries.some((q) => q.providerId === 'weibo_hot')).toBe(false);
  expect(krQueries.some((q) => q.providerId === 'official_web')).toBe(true);
  expect(inapplicableProviderIds(region, mixed)).toEqual(['weibo_hot']);
  expect(applicableCapabilities(region, mixed).map((cap) => cap.id)).toEqual(['official_web']);
  const cn = resolveRegion('China');
  expect(planCountryResearchPass1({ region: 'China' }, cn, mixed).some((q) => q.providerId === 'weibo_hot')).toBe(true);
  expect(inapplicableProviderIds(cn, mixed)).toEqual([]);
});

test('names applicable providers cut by the pass1 cap', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + String(i), areas: ['media_activity'] as const as readonly string[] }));
  expect(planCountryResearchPass1({ region: 'South Korea' }, region, many)).toHaveLength(24);
  expect(cappedProviderIds(region, many)).toEqual(['p24', 'p25', 'p26', 'p27', 'p28', 'p29']);
  expect(cappedProviderIds(region, caps)).toEqual([]);
});
