import { expect, test } from 'bun:test';
import { CountryContextRequestSchema } from './types.js';
import { resolveRegion } from './region.js';
import { textMentionsRegion } from './region_link.js';

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

test('resolves common countries to ISO alpha-2', () => {
  expect(resolveRegion('Japan').countryCode).toBe('JP');
  expect(resolveRegion('France').countryCode).toBe('FR');
  expect(resolveRegion('Indonesia').countryCode).toBe('ID');
  expect(resolveRegion('South Korea').countryCode).toBe('KR');
  expect(resolveRegion('Taiwan').countryCode).toBe('TW');
});

test('accepts ISO2 and ISO3 identifiers', () => {
  expect(resolveRegion('JP').countryCode).toBe('JP');
  expect(resolveRegion('JPN').countryCode).toBe('JP');
  expect(resolveRegion('KOR').countryCode).toBe('KR');
});

test('does not silently substitute Korea for unresolved region', () => {
  const region = resolveRegion('Unknown Example Region');
  expect(region.countryCode).toBeUndefined();
});

test('recognizes country-code headlines without matching ordinary words', () => {
  const us = resolveRegion('US');
  expect(textMentionsRegion('U.S. inflation increases', us)).toBe(true);
  expect(textMentionsRegion('US tourism rebounds', us)).toBe(true);
  expect(textMentionsRegion('business outlook improves', us)).toBe(false);
  expect(textMentionsRegion('日本の観光動向', resolveRegion('JP'))).toBe(true);
});

test('resolves Japanese country names built from the ISO codes', () => {
  expect(resolveRegion('台湾')).toMatchObject({ id: 'country:TW', countryCode: 'TW', name: 'Taiwan', confidence: 'high' });
  expect(resolveRegion('日本').countryCode).toBe('JP');
  expect(resolveRegion('韓国').countryCode).toBe('KR');
  expect(resolveRegion('アメリカ合衆国').countryCode).toBe('US');
  expect(resolveRegion('ジョージア').countryCode).toBe('GE');
  expect(resolveRegion(' 日本 ').countryCode).toBe('JP');
});

test('accepts the start of a Japanese name only when it picks exactly one country', () => {
  expect(resolveRegion('アメリカ')).toMatchObject({ countryCode: 'US', confidence: 'medium' });
  expect(resolveRegion('ミャンマー').countryCode).toBe('MM');
  // a full name wins over being the start of a longer one
  expect(resolveRegion('インド').countryCode).toBe('IN');
  expect(resolveRegion('ギニア').countryCode).toBe('GN');
  expect(resolveRegion('インドネシア').countryCode).toBe('ID');
  // the start of several names, or too short, stays unresolved
  for (const input of ['コンゴ', 'ドミニカ', '中華人民共和国', '東', '西', '北朝', 'ア']) {
    expect(resolveRegion(input)).toMatchObject({ id: 'unresolved:' + input, confidence: 'low' });
  }
});
