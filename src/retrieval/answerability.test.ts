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
import { extractQueryHighlightDetails } from '../enrichment.js';
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
  test('highlights rank answered entity evidence above stuffed and wrong-entity blocks', () => {
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
    const res = extractQueryHighlightDetails(markdown, 'Astra Phone X 価格', { maxHighlights: 3 });
    expect(res.highlights[0]).toContain('159,800');
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
  test('highlights rank table evidence above mention-only', () => {
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
    const res = extractQueryHighlightDetails(markdown, 'Astra Phone X 重量', { maxHighlights: 3 });
    expect(res.highlights[0]).toContain('199g');
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
  test('highlights prefer current-year evidence for latest-price queries', () => {
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
    const res = extractQueryHighlightDetails(markdown, '最新価格', { maxHighlights: 3 });
    expect(res.highlights[0]).toContain('159,800');
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
  test('coverage over the selected highlights exposes answered and missing requirements', () => {
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
    const query = 'Astra Phone X 価格 重量 Wi-Fi';
    const res = extractQueryHighlightDetails(markdown, query, { maxHighlights: 3 });
    const cov = computeEvidenceCoverage(res.highlights, entityTermsForQuery(query), ['価格', '重量', 'Wi-Fi']);
    expect(cov.answerCoverage).toBeCloseTo(2 / 3, 10);
    expect(cov.answeredRequirements).toEqual(['価格', '重量']);
    expect(cov.missingRequirements).toEqual(['Wi-Fi']);
  });
});
describe('buried answers (hermetic)', () => {
  test('finds the answer in the 21st of 22 sections', () => {
    const parts: string[] = [];
    for (let i = 0; i < 22; i++) {
      parts.push('# S' + i, '', i === 20 ? 'Astra Phone Xの価格は159,800円です。' : '価格について解説します。参考情報その' + i + '。', '');
    }
    const res = extractQueryHighlightDetails(parts.join(chrN()), 'Astra Phone X 価格', { maxHighlights: 3 });
    expect(res.highlights[0]).toContain('159,800');
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
  test('highlights prefer the implied-year evidence', () => {
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
    const res = extractQueryHighlightDetails(markdown, '君と見るそら ' + m + '月' + d + '日 ライブ', { maxHighlights: 3 });
    expect(res.highlights[0]).toContain(y + '年');
  });
});
describe('relative day resolution (hermetic)', () => {
  test('resolves relative days against the reference date', () => {
    const ref = new Date(2026, 8, 30);
    expect(extractDateRequirements('明日のライブ', ref)).toEqual([{ month: 10, day: 1, year: 2026 }]);
    expect(extractDateRequirements('明後日', ref)).toEqual([{ month: 10, day: 2, year: 2026 }]);
    expect(extractDateRequirements('価格', ref)).toEqual([]);
  });
});

describe('analyzeFacetEvidence lookahead (label followed by value)', () => {
  const sentences = ['■チケット料金', '全席指定 8,800円(税込)', '■開場時間', '17:30〜予定'];
  test('lookahead 0 needs the value in the same sentence (previous behavior)', () => {
    expect(analyzeFacetEvidence(sentences, [], '料金', 0).answered).toBe(false);
  });
  test('by default a value that follows the label sentence is credited', () => {
    expect(analyzeFacetEvidence(sentences, [], '料金').answered).toBe(true);
    expect(analyzeFacetEvidence(sentences, [], '開場時間').answered).toBe(true);
  });
  test('lookahead stays within the window and requires the matching kind', () => {
    const far = ['■チケット料金', '注意事項があります', '会場の案内です', '全席指定 8,800円(税込)'];
    expect(analyzeFacetEvidence(far, [], '料金').answered).toBe(false);
    expect(analyzeFacetEvidence(['■チケット料金', '17:30〜予定'], [], '料金').answered).toBe(false);
  });
  test('computeEvidenceCoverage uses the lookahead and honors an explicit 0', () => {
    const blocks = ['■チケット料金\n\n全席指定 8,800円(税込)'];
    expect(computeEvidenceCoverage(blocks, [], ['料金']).answerCoverage).toBe(1);
    expect(computeEvidenceCoverage(blocks, [], ['料金'], 0).answerCoverage).toBe(0);
  });
});
