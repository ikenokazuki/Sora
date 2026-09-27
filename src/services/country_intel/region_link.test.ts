import { describe, expect, test } from 'bun:test';
import { regionMentionNeedles, textMentionsRegion, upgradeCandidateWithBody } from './region_link.js';
import type { RegionIdentity } from './types.js';
const CN: RegionIdentity = { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' };
describe('multilingual mention detection (generic ICU, no country tables)', () => {
  test('needles include display names in evidence language', () => {
    expect(regionMentionNeedles(CN, ['zh'])).toContain('中国');
    expect(regionMentionNeedles(CN, [])).toContain('China');
    expect(regionMentionNeedles(CN, ['xx-invalid'])).toContain('China');
  });
  test('latin matching is case-insensitive, CJK is substring', () => {
    expect(textMentionsRegion('CHINA economy grows', CN, [])).toBe(true);
    expect(textMentionsRegion('中国经济形势', CN, ['zh'])).toBe(true);
    expect(textMentionsRegion('今日の出来事', CN, ['zh'])).toBe(false);
    expect(textMentionsRegion(undefined, CN, [])).toBe(false);
  });
  test('body confirmation upgrades candidates only', () => {
    expect(upgradeCandidateWithBody('candidate', '中国经济形势', CN, ['zh'])?.link).toBe('related');
    expect(upgradeCandidateWithBody('candidate', '今日の出来事', CN, ['zh'])).toBeUndefined();
    expect(upgradeCandidateWithBody('unknown', '中国经济形势', CN, ['zh'])).toBeUndefined();
    expect(upgradeCandidateWithBody('direct', '中国经济形势', CN, ['zh'])).toBeUndefined();
  });
});
