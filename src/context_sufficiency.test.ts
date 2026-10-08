import { describe, expect, test } from 'bun:test';
import { summarizeContextSufficiency } from './scraper.js';

const page = (markdown: string, extra: Record<string, any> = {}) => ({ title: 't', url: 'https://example.com/', markdown, ...extra });
const body = (s: string) => `# ${s}\n\n${s} の詳細です。`.repeat(8);

describe('summarizeContextSufficiency', () => {
  test('no usable content at all is insufficient', () => {
    expect(summarizeContextSufficiency([], [], '君と見るそら 出演時間')).toEqual({ level: 'insufficient', reasons: ['no-usable-content'] });
    const failed = [page('snippet only', { isSnippetFallback: true }), page('', { scrapeError: 'x' }), page('late', { deadlineExceeded: true, scrapeError: 'scrape_deadline_exceeded' })];
    expect(summarizeContextSufficiency(failed, [], 'abc def').level).toBe('insufficient');
  });

  test('enough pages covering every query term and the asked value has no detected gap', () => {
    const answered = (s: string) => page(`${body(s)}\n\n君と見るそら の出演時間は 14:10 からです。`);
    const pages = [answered('君と見るそら 出演時間'), answered('君と見るそら 出演時間 一覧'), answered('君と見るそら 出演時間 まとめ')];
    expect(summarizeContextSufficiency(pages, [], '君と見るそら 出演時間')).toEqual({ level: 'no_gap_detected', reasons: [] });
  });

  test('a value-seeking query whose pages mention it but never state a value is partial', () => {
    const pages = [page(body('君と見るそら 出演時間')), page(body('君と見るそら 出演時間 一覧')), page(body('君と見るそら 出演時間 まとめ'))];
    const out = summarizeContextSufficiency(pages, [], '君と見るそら 出演時間');
    expect(out.level).toBe('partial');
    expect(out.reasons.some((r) => r.startsWith('missing-answer:'))).toBe(true);
  });

  test('a query term found nowhere makes it partial and names the term', () => {
    const pages = [page(body('君と見るそら 出演時間')), page(body('君と見るそら 情報')), page(body('君と見るそら 一覧'))];
    const out = summarizeContextSufficiency(pages, [], '君と見るそら 駐車場');
    expect(out.level).toBe('partial');
    expect(out.reasons).toContain('missing-evidence:駐車場');
  });

  test('X posts count as evidence for term coverage', () => {
    const pages = [page(body('君と見るそら 情報')), page(body('君と見るそら 一覧')), page(body('君と見るそら まとめ'))];
    const posts = [{ text: '君と見るそら 駐車場 は会場裏です' }];
    expect(summarizeContextSufficiency(pages, posts, '君と見るそら 駐車場').level).toBe('no_gap_detected');
  });

  test('fewer than three usable pages is partial', () => {
    const pages = [page(body('君と見るそら 出演時間')), page('', { scrapeError: 'x' }), page('', { scrapeError: 'y' })];
    expect(summarizeContextSufficiency(pages, [], '君と見るそら 出演時間').reasons).toContain('few-success');
  });
});
