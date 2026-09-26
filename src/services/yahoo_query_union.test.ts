import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mergeYahooWebQueryBatches, assessRetrievalConfidence } from './yahoo.js';
import { scoreSearchCandidate, reciprocalRankFusion, rerankSearchResults } from '../enrichment.js';
import { buildSearchDiagnostics } from '../search_diagnostics.js';

describe('Phase 3 bounded Web query union', () => {
  test('merges and deduplicates fallback candidates', () => {
    const bindingQuery = '君と見るそら 山中湖 spark 出演時間';
    const result = mergeYahooWebQueryBatches(
      [
        {
          query: bindingQuery,
          queryIndex: 0,
          items: [
            {
              title: 'event overview',
              url: 'https://example.com/event',
              description: '山中湖 event overview',
            },
          ],
        },
        {
          query: '君と見るそら 山中湖 spark',
          queryIndex: 1,
          items: [
            {
              title: '君と見るそら SPARK 出演時間',
              url: 'https://example.com/spark-time',
              description: '君と見るそら 山中湖 SPARK 出演時間 18:20',
            },
            {
              title: 'duplicate event',
              url: 'https://example.com/event',
              description: 'duplicate',
            },
          ],
        },
      ],
      bindingQuery,
    );

    expect(result).toHaveLength(2);
    expect(result.filter((x: any) => x.url === 'https://example.com/event')).toHaveLength(1);
    expect(result.some((x: any) => x.retrievalQueryIndex === 1)).toBe(true);
  });

  test('helper fuses the union by provider rank (RRF) without BM25 reorder', () => {
    const source = readFileSync(new URL('./yahoo.ts', import.meta.url), 'utf8');
    expect(source).toContain('reciprocalRankFusion');
    expect(source).toContain('providerRank');
    expect(source).not.toContain('rerankSearchResults(merged, bindingQuery)');
  });

  test('merged items keep providerRank and RRF scores', () => {
    const bindingQuery = '君と見るそら SPARK 出演時間';
    const result: any[] = mergeYahooWebQueryBatches(
      [
        {
          query: bindingQuery,
          queryIndex: 0,
          items: [
            { title: 'A', url: 'https://example.com/a', description: '君と見るそら' },
            { title: 'B', url: 'https://example.com/b', description: '君と見るそら' },
          ],
        },
        {
          query: '君と見るそら SPARK',
          queryIndex: 1,
          items: [
            { title: 'B', url: 'https://example.com/b', description: '君と見るそら SPARK' },
            { title: 'C', url: 'https://example.com/c', description: 'SPARK' },
          ],
        },
      ],
      bindingQuery,
    );
    // dedup: A,B,C の3件ではなく重複Bは統合され2→3件ではなく3件
    expect(result).toHaveLength(3);
    for (const item of result) {
      expect(typeof item.providerRank).toBe('number');
      expect(Array.isArray(item.providerRanks)).toBe(true);
      expect(typeof item.rrfScore).toBe('number');
    }
    // 複数SERPに出現したBがRRFで最上位になる
    expect(result[0].url).toBe('https://example.com/b');
    expect(result[0].providerRanks).toHaveLength(2);
  });

  test('scoreSearchCandidate keeps order and returns diagnostics', () => {
    const items = [
      { title: 'bbb', url: 'https://example.com/1' },
      { title: 'aaa 君と見るそら', url: 'https://example.com/2' },
    ];
    const scored = scoreSearchCandidate(items as any, '君と見るそら');
    expect(scored).toHaveLength(2);
    // 順序変更なし
    expect(scored[0].item.title).toBe('bbb');
    expect(scored[1].item.title).toBe('aaa 君と見るそら');
    // 一致側のスコアが高い
    expect(scored[1].lexicalScore).toBeGreaterThan(scored[0].lexicalScore);
  });

  test('reciprocalRankFusion prefers multi-hit docs', () => {
    const single = reciprocalRankFusion([{ key: 'a', rank: 0 }]);
    const multi = reciprocalRankFusion([
      { key: 'a', rank: 1 },
      { key: 'a', rank: 1 },
    ]);
    expect(multi).toBeGreaterThan(single);
  });

  test('domain trust uses hostname, not path substring', () => {
    const items = [
      { title: '君と見るそら', snippet: '君と見るそら', url: 'https://example.com/path/.gov/foo' },
      { title: '君と見るそら', snippet: '君と見るそら', url: 'https://example.go.jp/info' },
    ];
    const ranked = rerankSearchResults(items as any, '君と見るそら');
    // hostname が .go.jp の方が上位になる。パスに .gov を含むだけでは加点されない
    expect(ranked[0].url).toBe('https://example.go.jp/info');
  });

  test('adaptive confidence detects weak retrieval', () => {
    const good = assessRetrievalConfidence(
      [
        { title: '君と見るそら SPARK 出演時間', snippet: '君と見るそら SPARK 18:20', url: 'https://a.example/' },
        { title: '君と見るそら SPARK', snippet: 'SPARK 出演', url: 'https://b.example/' },
        { title: 'SPARK タイムテーブル', snippet: '君と見るそら SPARK', url: 'https://c.example/' },
      ] as any,
      '君と見るそら SPARK 出演時間',
    );
    expect(good.good).toBe(true);

    const weakMissing = assessRetrievalConfidence(
      [
        { title: '君と見るそら', snippet: '君と見るそら', url: 'https://a.example/' },
        { title: '君と見るそら', snippet: '君と見るそら', url: 'https://b.example/' },
      ] as any,
      '君と見るそら SPARK 出演辞退',
    );
    expect(weakMissing.good).toBe(false);
    expect(weakMissing.reasons.join(' ')).toContain('missing-terms');

    const weakDomain = assessRetrievalConfidence(
      [
        { title: '君と見るそら SPARK', snippet: '君と見るそら SPARK', url: 'https://same.example/a' },
        { title: '君と見るそら SPARK', snippet: '君と見るそら SPARK', url: 'https://same.example/b' },
        { title: '君と見るそら SPARK', snippet: '君と見るそら SPARK', url: 'https://same.example/c' },
      ] as any,
      '君と見るそら SPARK',
    );
    expect(weakDomain.good).toBe(false);
  });

  test('query lineage keeps original binding query separate', () => {
    const original = '君と見るそら 山中湖 spark 出演時間';
    const diagnostics = buildSearchDiagnostics({
      originalQuery: original,
      effectiveQuery: original,
      webEffectiveQuery: original,
      webBindingQuery: original,
      webRetrievalQueries: [
        original,
        '君と見るそら 山中湖 spark',
      ],
      webIsFallback: true,
      webResultCount: 4,
      includeRealtime: false,
      results: [],
    });

    expect(diagnostics.web.bindingQuery).toBe(original);
    expect(diagnostics.web.retrievalQueries).toEqual([
      original,
      '君と見るそら 山中湖 spark',
    ]);
  });

  test('union is opt-in and bounded to original plus one fallback', () => {
    const source = readFileSync(new URL('./yahoo.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.env.SORA_WEB_QUERY_UNION === 'true'");
    expect(source).toContain('candidateQueries.slice(0, 2)');
  });

  test('realtime retrieval v1 uses wave union instead of first-nonempty-wins', () => {
    const source = readFileSync(new URL('./yahoo.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function searchYahooRealtime');
    const end = source.indexOf('/** X (Twitter)', start);
    const realtimeSource = source.slice(start, end);
    expect(realtimeSource).not.toContain('SORA_WEB_QUERY_UNION');
    expect(realtimeSource).toContain('MAX_REALTIME_RETRIEVAL_QUERIES');
    expect(realtimeSource).toContain('runRealtimeWave');
    expect(realtimeSource).toContain('retrievalQueries');
    expect(source).toContain('Promise.allSettled');
  });

  test('integrated cache separates union OFF and ON', () => {
    const source = readFileSync(new URL('../scraper.ts', import.meta.url), 'utf8');
    expect(source).toContain("${webQueryUnion ? 'wqu-on' : 'wqu-off'}");
  });

  test('duplicate URL keeps richest snippet', () => {
    const res: any[] = mergeYahooWebQueryBatches(
      [
        { query: 'q', queryIndex: 0, items: [{ title: 'timetable', snippet: '18:20', url: 'https://spark.example/time' }] },
        { query: 'q2', queryIndex: 1, items: [{ title: 'full title with terms', snippet: 'rich snippet terms', url: 'https://spark.example/time' }] },
      ],
      'q',
    );
    expect(res).toHaveLength(1);
    expect(res[0].snippet).toContain('rich');
    expect(res[0].providerRanks).toHaveLength(2);
  });

  test('rollback flags restore legacy behavior', async () => {
    const { mergeYahooWebQueryBatches: merge } = await import('./yahoo.js');
    const { rerankSearchResults } = await import('../enrichment.js');
    const batches = [
      { query: 'q', queryIndex: 0, items: [
        { title: 'aaa', url: 'https://a.example/', description: 'zzz' },
        { title: 'qqq matchme', url: 'https://b.example/', description: 'matchme' },
      ]},
      { query: 'q2', queryIndex: 1, items: [
        { title: 'qqq matchme', url: 'https://b.example/', description: 'matchme extra' },
      ]},
    ];
    const prevRrf = process.env.SORA_RRF_ENABLED;
    process.env.SORA_RRF_ENABLED = 'false';
    const off = merge(batches as any, 'matchme');
    expect(off.map((x: any) => x.url)).toEqual(['https://a.example/', 'https://b.example/']);
    process.env.SORA_RRF_ENABLED = 'true';
    const on = merge(batches as any, 'matchme');
    expect(on[0].url).toBe('https://b.example/');
    if (prevRrf !== undefined) process.env.SORA_RRF_ENABLED = prevRrf; else delete process.env.SORA_RRF_ENABLED;
    expect(process.env.SORA_WEB_NATIVE_RANKING ?? 'true').toBe('true');
    void rerankSearchResults;
  });
});
