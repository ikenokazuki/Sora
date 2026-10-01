import { describe, expect, test } from 'bun:test';
import { extractDatedState } from './probe-rakuten-travel';

const sample = () => ({
  isDated: true,
  conditions: { f_nen1: ['2026'], f_otona_su: ['2'] },
  displayedHotels: [123], totalResults: [1],
  hotels: {
    '123': { plans: { '456': { rooms: { room1: {
      sumTotalChargeTaxExclusive: 90, sumTotalChargeTaxInclusive: 100, taxType: 'inclusive',
    } } } }, rooms: {} },
  },
});
const html = (value: unknown) => '<script>var ds = ' + JSON.stringify(value) + ';</script>';

describe('Rakuten research capture', () => {
  test('retains public rate data while excluding session fields from the saved state', () => {
    const state = sample();
    const contaminated = {
      ...state,
      conditions: { ...state.conditions, f_session: ['secret-marker'] },
      hotels: {
        '123': { ...state.hotels['123'], sessionToken: 'secret-marker',
          plans: { '456': { rooms: { room1: {
            ...state.hotels['123'].plans['456'].rooms.room1, sessionToken: 'secret-marker',
          } } } },
        },
      },
    };
    const captured = extractDatedState(html(contaminated));
    expect(captured).toEqual(state);
    expect(JSON.stringify(captured)).not.toContain('secret-marker');
  });

  test('rejects arrays substituted for condition and hotel objects', () => {
    expect(() => extractDatedState(html({ ...sample(), conditions: [], hotels: [] }))).toThrow();
  });

  test('parses quoted braces without executing trailing JavaScript', () => {
    const state = { ...sample(), conditions: { ...sample().conditions, f_shou: ['braces } { and escaped " quotes'] } };
    const source = html(state).replace(';</script>', '; throw new Error("must not execute");</script>');
    expect(extractDatedState(source)).toEqual(state);
  });

  test('keeps absent state distinct from malformed state', () => {
    expect(extractDatedState('<html>No state</html>')).toBeNull();
    expect(() => extractDatedState('<script>var ds = {"isDated":true</script>')).toThrow();
  });
});
