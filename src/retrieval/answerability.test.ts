import { describe, expect, test } from 'bun:test';
import {
  analyzeFacetEvidence,
  associationMultiplier,
  detectValueKinds,
  computeEvidenceCoverage,
  dateYearMultiplier,
  detectCurrentIntent,
  extractDateRequirements,
  impliedYear,
  entityTermsForQuery,
  splitSentences,
  structuralMultiplier,
  temporalMultiplier,
} from './answerability.js';
import { extractQueryHighlightsRhoV2 } from '../rho_select_v2_adapter.js';
function chrN(): string { return String.fromCharCode(10); }
describe('answerability signals (hermetic)', () => {
  test('splits sentences on Japanese periods', () => {
    expect(splitSentences('A。B。C')).toEqual(['A。', 'B。', 'C']);
    expect(splitSentences('')).toEqual([]);
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
describe('structural evidence signals (hermetic)', () => {
  test('same table row key and value is very strong', () => {
    expect(structuralMultiplier('| 重量 | 199g |', '重量')).toBe(1.8);
    expect(structuralMultiplier('| 項目 | 値 |' + chrN() + '| --- | --- |' + chrN() + '| 重量 | 199g |', '重量')).toBe(1.8);
  });
  test('separator rows and key-only rows do not fire', () => {
    expect(structuralMultiplier('| --- | --- |', '重量')).toBe(1.0);
    expect(structuralMultiplier('| 重量 | 未定 |', '重量')).toBe(1.0);
    expect(structuralMultiplier('plain text', '重量')).toBe(1.0);
  });
  test('definition key value pairs score above prose', () => {
    expect(structuralMultiplier('重量' + chrN() + '199g', '重量')).toBe(1.4);
  });
  test('adapter ranks table evidence above mention-only', () => {
    const markdown = [
      '# 仕様表',
      '',
      '| 項目 | 値 |',
      '| --- | --- |',
      '| 重量 | 199g |',
      '',
      '# 解説',
      '',
      '重量について解説します。',
      '',
    ].join(chrN());
    const res = extractQueryHighlightsRhoV2(markdown, 'Astra Phone X 重量', { requirements: ['重量'] });
    const scores = new Map<string, number>();
    for (const h of res.highlightItems) {
      const ev = h.evidenceScores[0] || 0;
      if (h.text.includes('199g')) scores.set('table', ev);
      if (h.text.includes('解説します')) scores.set('mention', ev);
    }
    expect(scores.has('table')).toBe(true);
    expect(scores.get('table') as number).toBeGreaterThan((scores.get('mention') as number) || 0);
  });
});
describe('temporal relevance signals (hermetic)', () => {
  test('detects current intent queries', () => {
    expect(detectCurrentIntent('最新の価格')).toBe(true);
    expect(detectCurrentIntent('現在の営業時間')).toBe(true);
    expect(detectCurrentIntent('価格')).toBe(false);
  });
  test('penalizes old years and old markers under current intent', () => {
    const y = new Date().getFullYear();
    const oldYear = temporalMultiplier([(y - 2) + '年価格 139,800円'], '価格', true);
    expect(oldYear).toBeLessThan(1.0);
    const oldWord = temporalMultiplier(['旧価格 139,800円'], '価格', true);
    expect(oldWord).toBeLessThan(1.0);
    const current = temporalMultiplier(['現行価格 ' + y + '年 159,800円'], '価格', true);
    expect(current).toBeGreaterThan(1.0);
  });
  test('no temporal adjustment without current intent', () => {
    const y = new Date().getFullYear();
    expect(temporalMultiplier([(y - 2) + '年価格 139,800円'], '価格', false)).toBe(1.0);
  });
  test('adapter prefers current-year evidence for latest-price queries', () => {
    const y = new Date().getFullYear();
    const markdown = [
      '# 旧価格',
      '',
      (y - 2) + '年価格 139,800円 重量199g',
      '',
      '# 現行価格',
      '',
      '現行価格 ' + y + '年 159,800円',
      '',
    ].join(chrN());
    const res = extractQueryHighlightsRhoV2(markdown, '最新価格', { requirements: ['価格', '重量'] });
    const scores = new Map<string, number[]>();
    for (const h of res.highlightItems) {
      if (h.text.includes('159,800')) scores.set('current', h.evidenceScores);
      if (h.text.includes('139,800')) scores.set('old', h.evidenceScores);
    }
    expect(scores.has('current')).toBe(true);
    expect(scores.has('old')).toBe(true);
    const cur = scores.get('current') as number[];
    const oldScores = scores.get('old') as number[];
    expect(cur[0]).toBeGreaterThan(oldScores[0]);
  });
});
describe('evidence coverage diagnostics (hermetic)', () => {
  test('computes mention and answer coverage per requirement', () => {
    const cov = computeEvidenceCoverage(
      ['Astra Phone Xの価格は159,800円です。', '重量は199gです。', 'Wi-Fiについて解説します。'],
      ['astra', 'phone', 'x'],
      ['価格', '重量', 'Wi-Fi'],
    );
    expect(cov.mentionCoverage).toBe(1.0);
    expect(cov.answerCoverage).toBeCloseTo(2 / 3, 10);
    expect(cov.answeredRequirements).toEqual(['価格', '重量']);
    expect(cov.missingRequirements).toEqual(['Wi-Fi']);
  });
  test('adapter diagnostics expose answer coverage and missing requirements', () => {
    const markdown = [
      '# 価格',
      '',
      'Astra Phone Xの価格は159,800円です。',
      '',
      '# 重量',
      '',
      '重量は199gです。',
      '',
      '# 無線',
      '',
      'Wi-Fiについて解説します。',
      '',
    ].join(chrN());
    const res = extractQueryHighlightsRhoV2(markdown, 'Astra Phone X 価格 重量 Wi-Fi', { requirements: ['価格', '重量', 'Wi-Fi'] });
    expect(res.diagnostics.answerCoverage).toBeCloseTo(2 / 3, 10);
    expect(res.diagnostics.answeredRequirements).toEqual(['価格', '重量']);
    expect(res.diagnostics.missingRequirements).toEqual(['Wi-Fi']);
  });
});
describe('adaptive candidate expansion (hermetic)', () => {
  function longDoc(answerAt: number, total: number): string {
    const parts: string[] = [];
    for (let i = 0; i < total; i++) {
      parts.push('# S' + i);
      parts.push('');
      if (i === answerAt) {
        parts.push('Astra Phone Xの価格は159,800円です。');
      } else {
        parts.push('価格について解説します。参考情報その' + i + '。');
      }
      parts.push('');
    }
    return parts.join(chrN());
  }
  test('expands beyond 12 when answer is buried', () => {
    const res = extractQueryHighlightsRhoV2(longDoc(20, 22), 'Astra Phone X 価格', { requirements: ['価格'] });
    expect(res.diagnostics.candidateExpansion as object).toBeDefined();
    const exp = res.diagnostics.candidateExpansion as { initial: number; final: number; stages: number };
    expect(exp.stages).toBeGreaterThan(1);
    expect(exp.final).toBeGreaterThan(12);
    const hasAnswer = res.highlightItems.some((h) => h.text.includes('159,800'));
    expect(hasAnswer).toBe(true);
  });
  test('stops at 12 when answer is up front', () => {
    const res = extractQueryHighlightsRhoV2(longDoc(2, 22), 'Astra Phone X 価格', { requirements: ['価格'] });
    const exp = res.diagnostics.candidateExpansion as { initial: number; final: number; stages: number };
    expect(exp.stages).toBe(1);
    expect(exp.final).toBe(12);
  });
  test('opt-out runs a single full stage', () => {
    const res = extractQueryHighlightsRhoV2(longDoc(20, 22), 'Astra Phone X 価格', { requirements: ['価格'], adaptiveCandidate: false });
    const exp = res.diagnostics.candidateExpansion as { initial: number; final: number; stages: number };
    expect(exp.stages).toBe(1);
    expect(exp.final).toBe(22);
  });
});
describe('date requirement matching (hermetic)', () => {
  test('extracts month-day with optional year', () => {
    expect(extractDateRequirements('10月11日ライブ')).toEqual([{ month: 10, day: 11, year: null }]);
    expect(extractDateRequirements('2026年10月11日')).toEqual([{ month: 10, day: 11, year: 2026 }]);
    expect(extractDateRequirements('10/11')).toEqual([{ month: 10, day: 11, year: null }]);
    expect(extractDateRequirements('13月40日')).toEqual([]);
    expect(extractDateRequirements('価格')).toEqual([]);
  });
  test('implies the next upcoming occurrence', () => {
    const ref = new Date(2026, 8, 30);
    expect(impliedYear({ month: 10, day: 11, year: null }, ref)).toBe(2026);
    expect(impliedYear({ month: 1, day: 5, year: null }, ref)).toBe(2027);
    expect(impliedYear({ month: 10, day: 11, year: 2025 }, ref)).toBe(2025);
  });
  test('matches and mismatches evidence years', () => {
    const ref = new Date(2026, 8, 30);
    const req = [{ month: 10, day: 11, year: null }];
    expect(dateYearMultiplier(['2026年10月11日のライブ'], req, ref)).toBe(1.1);
    expect(dateYearMultiplier(['2025年10月11日のライブ'], req, ref)).toBe(0.8);
    expect(dateYearMultiplier(['10月11日のライブ'], req, ref)).toBe(1.0);
    expect(dateYearMultiplier(['2026年10月11日のライブ'], [], ref)).toBe(1.0);
  });
  test('adapter prefers the implied-year evidence', () => {
    const ref = new Date();
    const future = new Date(ref.getTime() + 20 * 24 * 60 * 60 * 1000);
    const m = future.getMonth() + 1;
    const d = future.getDate();
    const y = impliedYear({ month: m, day: d, year: null }, ref);
    const markdown = [
      '# 旧年',
      '',
      y - 1 + '年' + m + '月' + d + '日 ライブ 重量199g',
      '',
      '# 該当年',
      '',
      y + '年' + m + '月' + d + '日 ライブ',
      '',
    ].join(chrN());
    const res = extractQueryHighlightsRhoV2(markdown, '君と見るそら ' + m + '月' + d + '日 ライブ', { requirements: ['ライブ', '重量'] });
    const scores = new Map<string, number>();
    for (const h of res.highlightItems) {
      const ev = h.evidenceScores[0] || 0;
      if (h.text.includes(y + '年')) scores.set('current', ev);
      if (h.text.includes((y - 1) + '年')) scores.set('old', ev);
    }
    expect(scores.has('current')).toBe(true);
    expect(scores.has('old')).toBe(true);
    expect(scores.get('current') as number).toBeGreaterThan(scores.get('old') as number);
  });
});
