import { describe, expect, test } from 'bun:test';
import { summarizeContextSufficiency } from './context_sufficiency.js';

const filler = (s: string) => `# ${s}\n\n${s} の詳細です。`.repeat(6);
const page = (title: string, highlights: string[] = [], extra: Record<string, any> = {}) => ({
  title,
  url: 'https://example.com/',
  markdown: `${filler(title)}\n\n${highlights.join('\n\n')}`,
  highlights,
  ...extra,
});
const answered = (t: string) => page(t, [`${t} の出演時間は 14:10 からです。`]);

describe('summarizeContextSufficiency', () => {
  test('no usable content at all is insufficient', () => {
    expect(summarizeContextSufficiency([], [], '君と見るそら 出演時間')).toEqual({ level: 'insufficient', reasons: ['no-usable-content'] });
    const failed = [
      page('a', [], { isSnippetFallback: true }),
      page('b', [], { markdown: '', scrapeError: 'x' }),
      page('c', [], { markdown: '', scrapeError: 'scrape_deadline_exceeded', deadlineExceeded: true }),
    ];
    expect(summarizeContextSufficiency(failed, [], 'abc def').level).toBe('insufficient');
  });

  test('requirements mentioned and the asked value stated is no_gap_detected', () => {
    const pages = [answered('君と見るそら'), answered('君と見るそら ライブ'), answered('君と見るそら 情報')];
    expect(summarizeContextSufficiency(pages, [], '君と見るそら 出演時間')).toEqual({ level: 'no_gap_detected', reasons: [] });
  });

  test('a value-seeking requirement that is mentioned but never given a value is unanswered', () => {
    const stated = (t: string) => page(t, [`${t} の出演時間について詳細は後日発表です。`]);
    const out = summarizeContextSufficiency([stated('君と見るそら'), stated('君と見るそら ライブ'), stated('君と見るそら 情報')], [], '君と見るそら 出演時間');
    expect(out.level).toBe('partial');
    expect(out.reasons.some((r) => r.startsWith('unanswered:') && r.includes('出演時間'))).toBe(true);
  });

  test('a query term that no evidence mentions is reported as unmentioned', () => {
    const pages = [answered('君と見るそら'), answered('君と見るそら ライブ'), answered('君と見るそら 情報')];
    const out = summarizeContextSufficiency(pages, [], '君と見るそら 駐車場 出演時間');
    expect(out.level).toBe('partial');
    expect(out.reasons.some((r) => r.startsWith('unmentioned:') && r.includes('駐車場'))).toBe(true);
  });

  test('X posts count as evidence', () => {
    const pages = [page('君と見るそら', ['君と見るそら のライブ情報です。']), page('君と見るそら ライブ', ['君と見るそら のライブ情報です。']), page('君と見るそら 情報', ['君と見るそら のライブ情報です。'])];
    const posts = [{ text: '君と見るそら の駐車場は会場裏です。出演時間は 14:10 から。' }];
    expect(summarizeContextSufficiency(pages, posts, '君と見るそら 駐車場').level).toBe('no_gap_detected');
  });

  test('fewer than three usable pages is reported as few-success', () => {
    const pages = [answered('君と見るそら'), page('b', [], { markdown: '', scrapeError: 'x' }), page('c', [], { markdown: '', scrapeError: 'y' })];
    expect(summarizeContextSufficiency(pages, [], '君と見るそら 出演時間').reasons).toContain('few-success');
  });

  test('pages without extracted highlights fall back to their markdown as evidence', () => {
    const plain = (t: string) => ({ title: t, markdown: `${filler(t)}\n\n${t} の出演時間は 14:10 からです。` });
    const out = summarizeContextSufficiency([plain('君と見るそら'), plain('君と見るそら ライブ'), plain('君と見るそら 情報')], [], '君と見るそら 出演時間');
    expect(out.level).toBe('no_gap_detected');
  });
});
