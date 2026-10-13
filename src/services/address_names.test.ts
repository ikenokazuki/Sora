import { describe, expect, test } from 'bun:test';
import { cityNameOf, lgCode6 } from './address_names.js';

describe('address names', () => {
  test('lgCode6 は 6 桁に 0 埋めする', () => {
    expect(lgCode6(11011)).toBe('011011');
    expect(lgCode6('131016')).toBe('131016');
    expect(lgCode6(130001)).toBe('130001');
  });

  test('cityNameOf は郡・市・区を連結する', () => {
    expect(cityNameOf({ city: '千代田区' })).toBe('千代田区');
    expect(cityNameOf({ city: '札幌市', ward: '中央区' })).toBe('札幌市中央区');
    expect(cityNameOf({ county: '足柄上郡', city: '中井町' })).toBe('足柄上郡中井町');
  });
});
