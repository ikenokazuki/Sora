import { describe, expect, test } from 'bun:test';
import { mergeYahooWebQueryBatches, webQueryUnionWeight } from './yahoo.js';
import { reciprocalRankFusion } from '../enrichment.js';
function item(title: string, url: string) {
  return { title: title, url: url, description: title + ' description' };
}
describe('weighted RRF for web query union (hermetic)', () => {
  test('query weights follow original 1.0 and fallback 0.6', () => {
    expect(webQueryUnionWeight(0)).toBe(1.0);
    expect(webQueryUnionWeight(1)).toBe(0.6);
    expect(webQueryUnionWeight(2)).toBe(0.6);
  });
  test('unweighted default behavior is unchanged', () => {
    expect(reciprocalRankFusion([{ key: '0', rank: 0 }])).toBeCloseTo(1 / 61, 10);
  });
  test('overlapping hit outranks single-list hits', () => {
    const ranked = mergeYahooWebQueryBatches(
      [
        { query: 'Q0', queryIndex: 0, items: [item('A page', 'https://example.com/a'), item('B page', 'https://example.com/b')] },
        { query: 'Q1', queryIndex: 1, items: [item('B page', 'https://example.com/b'), item('C page', 'https://example.com/c')] },
      ],
      'Q0',
    );
    expect(ranked.map((r: any) => r.url)).toEqual([
      'https://example.com/b',
      'https://example.com/a',
      'https://example.com/c',
    ]);
  });
  test('fallback-only top does not overtake original mid-rank (no drift)', () => {
    const q0 = [
      item('P0', 'https://example.com/p0'),
      item('P1', 'https://example.com/p1'),
      item('P2', 'https://example.com/p2'),
      item('P3', 'https://example.com/p3'),
      item('P4', 'https://example.com/p4'),
      item('P target', 'https://example.com/target'),
    ];
    const ranked = mergeYahooWebQueryBatches(
      [
        { query: 'Q0', queryIndex: 0, items: q0 },
        { query: 'Q1', queryIndex: 1, items: [item('F page', 'https://example.com/f')] },
      ],
      'Q0',
    );
    const urls = ranked.map((r: any) => r.url);
    expect(urls.indexOf('https://example.com/target')).toBeLessThan(urls.indexOf('https://example.com/f'));
  });
  test('single batch keeps provider order', () => {
    const ranked = mergeYahooWebQueryBatches(
      [
        { query: 'Q0', queryIndex: 0, items: [item('A', 'https://example.com/a'), item('B', 'https://example.com/b'), item('C', 'https://example.com/c')] },
      ],
      'Q0',
    );
    expect(ranked.map((r: any) => r.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });
});
