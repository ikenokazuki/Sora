import { describe, expect, test } from 'bun:test';
import { inferCountryCodesFromText } from './place_country.js';

describe('inferCountryCodesFromText', () => {
  test('New Mexico is not the country Mexico', () => {
    expect(inferCountryCodesFromText('55 km SSE of Whites City, New Mexico')).not.toContain('MX');
  });
  test('Mexico and Mexico City still resolve to MX', () => {
    expect(inferCountryCodesFromText('Maneadero, B.C., Mexico')).toContain('MX');
    expect(inferCountryCodesFromText('Mexico City earthquake drill')).toContain('MX');
  });
  test('other countries unaffected', () => {
    expect(inferCountryCodesFromText('223 km WNW of Abepura, Indonesia')).toEqual(['ID']);
  });
});
