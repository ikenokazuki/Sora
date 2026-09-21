import { expect, test } from 'bun:test';
import {
  cameoCountryToIso2,
  fipsToIso2,
  iso3ToIso2,
  normalizeProviderCountryCode,
} from './geo_codes.js';

test('converts ISO3 to ISO2 without fallback guessing', () => {
  expect(iso3ToIso2('KOR')).toBe('KR');
  expect(iso3ToIso2('JPN')).toBe('JP');
  expect(iso3ToIso2('kor')).toBe('KR');
  expect(iso3ToIso2('XXX')).toBeUndefined();
});

test('converts FIPS 10-4 to ISO2 and keeps KS distinct from KR', () => {
  expect(fipsToIso2('KS')).toBe('KR');
  expect(fipsToIso2('JA')).toBe('JP');
  expect(fipsToIso2('FR')).toBe('FR');
  expect(fipsToIso2('XX')).toBeUndefined();
});

test('converts CAMEO country codes to ISO2', () => {
  expect(cameoCountryToIso2('KOR')).toBe('KR');
  expect(cameoCountryToIso2('JPN')).toBe('JP');
});

test('normalizes provider country codes at provider boundaries', () => {
  expect(normalizeProviderCountryCode('gdelt_geo', 'KS')).toBe('KR');
  expect(normalizeProviderCountryCode('iso3', 'KOR')).toBe('KR');
  expect(normalizeProviderCountryCode('gdelt_geo', 'KOR')).toBe('KR');
  expect(normalizeProviderCountryCode('gdacs', 'KOR')).toBe('KR');
  expect(normalizeProviderCountryCode('iso3', 'XXX')).toBeUndefined();
});
