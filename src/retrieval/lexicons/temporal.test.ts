import { describe, expect, test } from 'bun:test';
import { CURRENT_INTENT_TERMS, INTENT_ATTRIBUTE_TERMS_LIST } from './temporal.js';
import { INTENT_ATTRIBUTE_TERMS as REQ_INTENT } from '../requirements.js';
import { detectCurrentIntent } from '../answerability.js';
describe('temporal lexicon (hermetic)', () => {
  test('both former sites share one union set', () => {
    for (const t of ['出演時間', '出演辞退', '執筆者', '監修', '価格', '作詞']) {
      expect(INTENT_ATTRIBUTE_TERMS_LIST.includes(t)).toBe(true);
    }
    expect(new Set(INTENT_ATTRIBUTE_TERMS_LIST).size).toBe(INTENT_ATTRIBUTE_TERMS_LIST.length);
    for (const t of INTENT_ATTRIBUTE_TERMS_LIST) {
      expect(REQ_INTENT.has(t)).toBe(true);
    }
  });
  test('every current-intent term fires', () => {
    for (const t of CURRENT_INTENT_TERMS) {
      expect(detectCurrentIntent('X' + t + 'Y')).toBe(true);
    }
    expect(detectCurrentIntent('価格')).toBe(false);
  });
});
