import { describe, expect, test } from 'bun:test';
import {
  analyzeFacetEvidence,
  associationMultiplier,
  detectValueKinds,
  entityTermsForQuery,
  splitSentences,
} from './answerability.js';
import { extractQueryHighlightsRhoV2 } from '../rho_select_v2_adapter.js';
function chrN(): string { return String.fromCharCode(10); }
describe('answerability signals (hermetic)', () => {
  test('splits sentences on Japanese periods', () => {
    expect(splitSentences('A。B。C')).toEqual(['A', 'B', 'C']);
  });
  test('detects price, weight, date, and wifi values', () => {
    expect(detectValueKinds('価格は159,800円です')).toContain('price');
    expect(detectValueKinds('重量は199gです')).toContain('weight');
    expect(detectValueKinds('発売日は2026年9月20日です')).toContain('date');
    expect(detectValueKinds('Wi-Fi 7に対応')).toContain('wifi');
    expect(detectValueKinds('価格について解説します')).toEqual([]);
  });
  test('extracts entity terms minus intent terms', () => {
    const terms = entityTermsForQuery('Astra Phone X 価格');
    expect(terms).toContain('astra');
    expect(terms).toContain('phone');
    expect(terms).toContain('x');
    expect(terms.includes('価格')).toBe(false);
  });
  test('distinguishes answered evidence from mention-only', () => {
    const correct = analyzeFacetEvidence(splitSentences('Astra Phone Xの価格は159,800円です。'), ['astra', 'phone', 'x'], '価格');
    expect(correct.mentioned).toBe(true);
    expect(correct.answered).toBe(true);
    expect(correct.answeredWithEntity).toBe(true);
    const mention = analyzeFacetEvidence(splitSentences('Astra Phone Xの価格について解説します。'), ['astra', 'phone', 'x'], '価格');
    expect(mention.mentioned).toBe(true);
    expect(mention.answered).toBe(false);
    expect(associationMultiplier(correct)).toBeGreaterThan(associationMultiplier(mention));
  });
  test('wrong-entity block is not entity-associated', () => {
    const wrong = analyzeFacetEvidence(splitSentences('Astra Phone Wの価格は99,800円。'), ['astra', 'phone', 'x'], '価格');
    expect(wrong.answered).toBe(true);
    expect(wrong.answeredWithEntity).toBe(false);
    const right = analyzeFacetEvidence(splitSentences('Astra Phone Xの価格は159,800円です。'), ['astra', 'phone', 'x'], '価格');
    expect(associationMultiplier(right)).toBeGreaterThan(associationMultiplier(wrong));
  });
  test('adapter ranks answered entity evidence above stuffed and wrong-entity blocks', () => {
    const markdown = [
      '# Wモデル',
      '',
      'Astra Phone Wの価格は99,800円。',
      '',
      '# 一般論',
      '',
      '価格 重量 発売日 Wi-Fi 価格 重量 発売日 Wi-Fi 価格 重量 発売日 Wi-Fi。',
      '',
      '# Xモデル',
      '',
      'Astra Phone Xの価格は159,800円です。',
      '',
    ].join(chrN());
    const res = extractQueryHighlightsRhoV2(markdown, 'Astra Phone X 価格', { requirements: ['価格'] });
    const scores = new Map<string, number>();
    for (const h of res.highlightItems) {
      const ev = h.evidenceScores[0] || 0;
      if (h.text.includes('159,800')) scores.set('correct', ev);
      if (h.text.includes('99,800')) scores.set('wrong', ev);
      if (h.text.includes('重量 発売日')) scores.set('stuffed', ev);
    }
    expect(scores.has('correct')).toBe(true);
    expect(scores.get('correct') as number).toBeGreaterThan((scores.get('wrong') as number) || 0);
    expect(scores.get('correct') as number).toBeGreaterThan((scores.get('stuffed') as number) || 0);
  });
});
