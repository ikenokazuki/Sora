import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mergeYahooWebQueryBatches } from './yahoo.js';
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

  test('helper reranks the union by bindingQuery', () => {
    const source = readFileSync(new URL('./yahoo.ts', import.meta.url), 'utf8');
    expect(source).toContain('rerankSearchResults(merged, bindingQuery)');
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
});
