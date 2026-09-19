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

test('resolves country codes only to country identities', () => {
  expect(resolveRegion('US')).toMatchObject({
    id: 'country:US',
    countryCode: 'US',
    confidence: 'high',
  });
  expect(resolveRegion('US-GA')).toMatchObject({
    id: 'subdivision:US-GA',
    subdivisionCode: 'US-GA',
    confidence: 'high',
  });
});

test('returns identity arrays that cannot mutate stored geographic data', () => {
  const first = resolveRegion('South Korea');
  first.languages.push('en');
  first.aliases.push('mutated alias');

  expect(resolveRegion('South Korea')).toMatchObject({
    languages: ['ko'],
    aliases: ['Korea, Republic of', 'Republic of Korea', 'Korea (South)'],
  });
});
