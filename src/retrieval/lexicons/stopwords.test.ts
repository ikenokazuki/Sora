import { describe, expect, test } from 'bun:test';
import { STOPWORDS_LIST } from './stopwords.js';
describe('stopwords lexicon (hermetic)', () => {
  test('covers particles and english fillers without duplicates', () => {
    for (const t of ['の', 'について', '最新', 'the', 'and']) {
      expect(STOPWORDS_LIST.includes(t)).toBe(true);
    }
    expect(new Set(STOPWORDS_LIST).size).toBe(STOPWORDS_LIST.length);
  });
});
