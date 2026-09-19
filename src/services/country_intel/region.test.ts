import { expect, test } from 'bun:test';
import { CountryContextRequestSchema } from './types.js';
import { resolveRegion } from './region.js';

test('request defaults to comprehensive 30d collection without social', () => {
  expect(CountryContextRequestSchema.parse({ region: 'KR' })).toEqual({
    region: 'KR', period: '30d', includeSocial: false, noCache: false, verbose: false,
  });
});

test('resolves deterministic country identities and preserves ambiguity', () => {
  expect(resolveRegion('South Korea')).toMatchObject({ countryCode: 'KR', confidence: 'high' });
  expect(resolveRegion('대한민국')).toMatchObject({ countryCode: 'KR', confidence: 'high' });
  expect(resolveRegion('Georgia')).toMatchObject({ name: 'Georgia', confidence: 'low' });
});
