import { expect, test } from 'bun:test';
import { planCountryResearchPass1, planCountryResearchPass2 } from './query_planner.js';
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
