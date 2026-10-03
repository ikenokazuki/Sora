import { describe, expect, test } from 'bun:test';
import { searchYahooRealtime } from './services/yahoo.js';
import {
  measureSerializedResponseSize,
  formatCompactRealtimeResponse,
  formatCompactWebSearchResponse,
  formatCompactIntegratedSearchResponse,
} from './search_compact.js';

// ---------------------------------------------------------------------------
// Fixtures (mirrors production shapes; retrieval behavior untouched)
// ---------------------------------------------------------------------------

function realtimeMcpResponse(items: any[]) {
  return { content: [{ text: JSON.stringify({ items }) }] };
}

function post(id: string, text: string, handle = 'kimisora_JPN') {
  return {
    id,
    author_handle: handle,
    author_name: 'test author',
    text,
    url: `https://x.com/${handle}/status/${id}`,
    created_at: 1758000000,
  };
}

function mockMcp(handler: (query: string) => any[], calls: string[]) {
  return async (_tool: string, args: Record<string, any>) => {
    calls.push(args.query);
    return realtimeMcpResponse(handler(args.query));
  };
}

/** Full-coverage regression scenario: target post carries every required term. */
async function runFullCoverageRetrieval() {
  const calls: string[] = [];
  const target = post('999', 'SPARK 出演辞退のお知らせ');
  const partial = post('111', 'SPARK出演のお知らせ');
  const provider = mockMcp(
    (q) => (q.includes('辞退') && q !== 'SPARK 出演 辞退 id:kimisora_JPN' ? [target] : [partial]),
    calls,
  );
  const full: any = await searchYahooRealtime({
    query: 'SPARK 出演 辞退 id:kimisora_JPN',
    detailEnrichment: false,
    _callMcp: provider,
  } as any);
  return { full, calls };
}

function webUnionFixture() {
  const items = [
    {
      source: 'web',
      title: 'SPARK 出演辞退 正式発表',
      url: 'https://example.com/news/1',
      snippet: 'SPARK 出演辞退の概要スニペット',
      description: 'ページ作成者による説明文',
      highlights: ['SPARK **出演辞退**を発表'],
      retrievalQuery: 'SPARK 出演 辞退',
      retrievalQueryIndex: 0,
    },
    {
      source: 'web',
      title: 'SPARK 出演のお知らせ',
      url: 'https://example.com/news/2',
      snippet: 'SPARK 出演の概要スニペット',
      description: 'ページ作成者による説明文2',
      highlights: ['SPARK 出演を発表'],
      retrievalQuery: 'SPARK 出演',
      retrievalQueryIndex: 1,
    },
  ];
  return {
    items,
    count: items.length,
    source: 'web',
    originalQuery: 'SPARK 出演 辞退',
    bindingQuery: 'SPARK 出演 辞退',
    retrievalQueries: ['SPARK 出演 辞退', 'SPARK 出演'],
    effectiveQuery: 'SPARK 出演 辞退',
    isFallback: true,
    queryUnion: true,
  };
}

function integratedFixture(realtimeFull: any) {
  return {
    query: 'SPARK 出演 辞退',
    source: 'integrated',
    results: [
      {
        source: 'web',
        title: 'SPARK 出演辞退 正式発表',
        url: 'https://example.com/news/1',
        snippet: 'SPARK 出演辞退の概要スニペット',
        highlights: ['SPARK **出演辞退**を発表'],
      },
    ],
    count: 1,
    realtime: {
      source: 'x',
      sort: 'recent',
      count: realtimeFull.items.length,
      effectiveQuery: realtimeFull.effectiveQuery,
      isFallback: realtimeFull.isFallback,
      retrievalQueries: realtimeFull.retrievalQueries,
      contributingQueries: realtimeFull.contributingQueries,
      resultsMerged: realtimeFull.resultsMerged,
      items: realtimeFull.items,
    },
  };
}

// ---------------------------------------------------------------------------
// measureSerializedResponseSize
// ---------------------------------------------------------------------------

describe('measureSerializedResponseSize', () => {
  test('returns deterministic chars and bytes', () => {
    const value = { items: [{ text: 'SPARK 出演辞退' }] };
    const a = measureSerializedResponseSize(value);
    const b = measureSerializedResponseSize(value);
    expect(a).toEqual(b);
    expect(a.chars).toBe(JSON.stringify(value).length);
    expect(a.bytes).toBeGreaterThanOrEqual(a.chars);
  });

  test('multibyte text makes bytes exceed chars', () => {
    const ascii = measureSerializedResponseSize({ t: 'abc' });
    const japanese = measureSerializedResponseSize({ t: 'あいう' });
    expect(ascii.bytes).toBe(ascii.chars);
    expect(japanese.bytes).toBeGreaterThan(japanese.chars);
  });
});

// ---------------------------------------------------------------------------
// Realtime compact
// ---------------------------------------------------------------------------

describe('formatCompactRealtimeResponse', () => {
  test('compact drops verbose-only provenance, keeps answer fields', async () => {
    const { full } = await runFullCoverageRetrieval();
    expect(full.retrievalQueries.length).toBeGreaterThan(1);
    const compact: any = formatCompactRealtimeResponse(full);
    for (const key of [
      'retrievalQueries',
      'contributingQueries',
      'resultsMerged',
      'executedWaves',
      'stopReason',
      'requiredTerms',
      'coveredTerms',
      'missingTerms',
    ]) {
      expect(key in compact).toBe(false);
    }
    expect(compact.source).toBe('x');
    expect(compact.originalQuery).toBe(full.originalQuery);
    expect(compact.effectiveQuery).toBe(full.effectiveQuery);
    expect(compact.isFallback).toBe(full.isFallback);
    expect(compact.count).toBe(full.items.length);
    expect(compact.items.map((it: any) => it.id)).toEqual(full.items.map((it: any) => it.id));
    for (const item of compact.items) {
      for (const k of ['providerRank', 'providerRanks', 'rrfScore', 'lexicalScore', 'selectionReason']) {
        expect(k in item).toBe(false);
      }
    }
  });

  test('verbose keeps full provenance', async () => {
    const { full } = await runFullCoverageRetrieval();
    const verbose: any = formatCompactRealtimeResponse(full, { verbose: true });
    expect(verbose).toEqual(full);
    expect(verbose.retrievalQueries).toEqual(full.retrievalQueries);
    expect(verbose.stopReason).toBe(full.stopReason);
  });

  test('full-coverage target survives compaction with identity intact', async () => {
    const { full } = await runFullCoverageRetrieval();
    const compact: any = formatCompactRealtimeResponse(full);
    const target = compact.items.find((it: any) => String(it.id) === '999');
    expect(target).toBeDefined();
    expect(target.text).toContain('出演辞退');
    expect(target.author_handle).toBe('kimisora_JPN');
    expect(target.url).toBe('https://x.com/kimisora_JPN/status/999');
  });

  test('ranking order is preserved byte-for-byte', async () => {
    const { full } = await runFullCoverageRetrieval();
    const compact: any = formatCompactRealtimeResponse(full);
    expect(compact.items.map((it: any) => String(it.id))).toEqual(
      full.items.map((it: any) => String(it.id)),
    );
  });

  test('compaction issues zero provider calls', async () => {
    const { full, calls } = await runFullCoverageRetrieval();
    const before = calls.length;
    formatCompactRealtimeResponse(full);
    formatCompactRealtimeResponse(full, { verbose: true });
    expect(calls).toHaveLength(before);
  });

  test('same status dedups, different status same text kept (via internal merge)', async () => {
    const calls: string[] = [];
    const same = post('1234567890', 'SPARK 出演 辞退 決定');
    const provider = mockMcp(() => [same], calls);
    const full: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      detailEnrichment: false,
      _callMcp: provider,
    } as any);
    const compact: any = formatCompactRealtimeResponse(full);
    expect(compact.items.filter((it: any) => String(it.id) === '1234567890')).toHaveLength(1);
  });

  test('empty response stays minimal without invented fields', () => {
    const compact: any = formatCompactRealtimeResponse({
      source: 'x',
      originalQuery: 'q',
      effectiveQuery: 'q',
      isFallback: false,
      count: 0,
      items: [],
      retrievalQueries: ['q'],
      contributingQueries: [],
      resultsMerged: false,
      executedWaves: 1,
      stopReason: 'waves_complete',
      requiredTerms: ['q'],
      coveredTerms: [],
      missingTerms: ['q'],
    });
    expect(compact.count).toBe(0);
    expect(compact.items).toEqual([]);
    expect('retrievalQueries' in compact).toBe(false);
    expect('missingTerms' in compact).toBe(false);
  });

  test('high item counts pass through unbounded (no magic truncation)', () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      post(String(1000 + i), `本文 ${i} SPARK 出演 辞退`),
    );
    const compact: any = formatCompactRealtimeResponse({
      source: 'x',
      originalQuery: 'q',
      effectiveQuery: 'q',
      isFallback: false,
      count: items.length,
      items,
      retrievalQueries: ['q'],
      contributingQueries: ['q'],
      resultsMerged: false,
      executedWaves: 1,
      stopReason: 'full_coverage',
      requiredTerms: [],
      coveredTerms: [],
      missingTerms: [],
    });
    expect(compact.items).toHaveLength(25);
    expect(compact.count).toBe(25);
  });

  test('compact response is smaller than full response', async () => {
    const { full } = await runFullCoverageRetrieval();
    const compact = formatCompactRealtimeResponse(full);
    const before = measureSerializedResponseSize(full);
    const after = measureSerializedResponseSize(compact);
    expect(after.chars).toBeLessThan(before.chars);
    expect(after.bytes).toBeLessThan(before.bytes);
  });
});

// ---------------------------------------------------------------------------
// Web compact
// ---------------------------------------------------------------------------

describe('INTERNAL routing keys (RFC compatibility)', () => {
  test('compact strips scores and selection reasons, verbose keeps them', async () => {
    const mod = await import('./search_compact.js');
    const item = {
      title: 't', url: 'https://example.com', snippet: 's',
      providerRank: 1, providerRanks: [{ queryIndex: 0, rank: 1 }],
      retrievalQuery: 'q', retrievalQueryIndex: 0, retrievalWave: 1,
      rrfScore: 0.01, lexicalScore: 3, selectionReason: 'missing_requirement',
    };
    const web: any = mod.formatCompactWebSearchResponse({ items: [item], count: 1, source: 'web' });
    for (const k of ['providerRank', 'providerRanks', 'retrievalQuery', 'retrievalQueryIndex', 'retrievalWave', 'rrfScore', 'lexicalScore', 'selectionReason']) {
      expect(k in web.items[0]).toBe(false);
    }
    expect(web.items[0].title).toBe('t');
    const webV: any = mod.formatCompactWebSearchResponse({ items: [item], count: 1, source: 'web' }, { verbose: true });
    expect(webV.items[0].rrfScore).toBe(0.01);
    const rt: any = mod.formatCompactRealtimeResponse({ source: 'x', items: [{ ...item, id: '1', text: 'hi' }] });
    expect('rrfScore' in rt.items[0]).toBe(false);
    expect(rt.items[0].text).toBe('hi');
    const integ: any = mod.formatCompactIntegratedSearchResponse({ results: [item], realtime: { source: 'x', items: [{ ...item, id: '1' }] } });
    expect('selectionReason' in integ.results[0]).toBe(false);
    expect('providerRank' in integ.realtime.items[0]).toBe(false);
  });
});
describe('formatCompactWebSearchResponse', () => {
  test('compact strips per-item retrieval provenance, keeps evidence fields', () => {
    const full = webUnionFixture();
    const compact: any = formatCompactWebSearchResponse(full);
    expect('retrievalQueries' in compact).toBe(false);
    expect('bindingQuery' in compact).toBe(false);
    for (const item of compact.items) {
      expect('retrievalQuery' in item).toBe(false);
      expect('retrievalQueryIndex' in item).toBe(false);
    }
    expect(compact.items[0].title).toBe(full.items[0].title);
    expect(compact.items[0].url).toBe(full.items[0].url);
    expect(compact.items[0].highlights).toEqual(full.items[0].highlights);
    expect(compact.items[0].snippet).toBe(full.items[0].snippet);
    expect(compact.items[0].description).toBe(full.items[0].description);
    expect(compact.originalQuery).toBe(full.originalQuery);
    expect(compact.count).toBe(full.items.length);
  });

  test('web item order is preserved', () => {
    const full = webUnionFixture();
    const compact: any = formatCompactWebSearchResponse(full);
    expect(compact.items.map((it: any) => it.url)).toEqual(full.items.map((it: any) => it.url));
  });

  test('verbose keeps union provenance', () => {
    const full = webUnionFixture();
    const verbose: any = formatCompactWebSearchResponse(full, { verbose: true });
    expect(verbose).toEqual(full);
    expect(verbose.retrievalQueries).toHaveLength(2);
    expect(verbose.items[0].retrievalQuery).toBe('SPARK 出演 辞退');
  });

  test('non-union provider passthrough keeps working', () => {
    const plain = { items: [{ title: 't', url: 'https://example.com' }], count: 1, source: 'web' };
    const compact: any = formatCompactWebSearchResponse(plain);
    expect(compact.items).toEqual(plain.items);
    expect(compact.count).toBe(1);
  });

  test('compact web response is smaller than full union response', () => {
    const full = webUnionFixture();
    const before = measureSerializedResponseSize(full);
    const after = measureSerializedResponseSize(formatCompactWebSearchResponse(full));
    expect(after.chars).toBeLessThan(before.chars);
  });
});

// ---------------------------------------------------------------------------
// Integrated compact
// ---------------------------------------------------------------------------

describe('formatCompactIntegratedSearchResponse', () => {
  test.each([false, true])('same X status is returned once across web and realtime (verbose=%s)', (verbose) => {
    const response = {
      query: 'Festival', source: 'integrated', count: 2,
      results: [
        { source: 'web', url: 'https://twitter.com/artist/status/123?s=20', title: 'Official post', markdown: '# Official post\n\nLive starts at 15:20.', highlights: ['Live starts at 15:20.'] },
        { source: 'web', url: 'https://example.com/festival', markdown: '# Independent source\n\nLive starts at 15:20.' },
      ],
      realtime: { source: 'x', count: 1, items: [{ source: 'x', id: '123', url: 'https://x.com/artist/status/123', text: 'Live starts at 15:20.', isOfficial: true }] },
    };
    const before = structuredClone(response);
    const output: any = formatCompactIntegratedSearchResponse(response, { verbose });
    expect(output.results).toHaveLength(1);
    expect(output.count).toBe(1);
    expect(output.realtime.items).toHaveLength(1);
    expect(output.realtime.items[0]).toMatchObject({ id: '123', isOfficial: true, retrievalSources: ['web', 'realtime'] });
    expect(output.realtime.items[0].markdown).toContain('15:20');
    expect(output.results[0].url).toBe('https://example.com/festival');
    expect(response).toEqual(before);
  });

  test('same URL merges tracking variants but preserves case-sensitive paths and meaningful query parameters', () => {
    const response = { count: 4, results: [
      { url: 'https://example.com/Event?utm_source=yahoo', snippet: 'short' },
      { url: 'https://example.com/Event', markdown: '# Event\n\nComplete official event description.', isOfficial: true },
      { url: 'https://example.com/event', snippet: 'different path' },
      { url: 'https://example.com/Event?date=2026-04-20', snippet: 'different event date' },
    ] };
    const output: any = formatCompactIntegratedSearchResponse(response);
    expect(output.count).toBe(3);
    expect(output.results).toHaveLength(3);
    expect(output.results[0].markdown).toContain('Complete official');
    expect(output.results[0].isOfficial).toBe(true);
  });

  test('similar posts with different IDs survive unconditional identity merging', () => {
    const response = { count: 0, results: [], realtime: { count: 2, items: [
      { source: 'x', id: '123', url: 'https://x.com/a/status/123', text: 'Same event announcement' },
      { source: 'x', id: '456', url: 'https://x.com/b/status/456', text: 'Same event announcement' },
    ] } };
    const output: any = formatCompactIntegratedSearchResponse(response);
    expect(output.realtime.items).toHaveLength(2);
  });
  test('compact strips realtime provenance, keeps realtime items and web results', async () => {
    const { full } = await runFullCoverageRetrieval();
    const response = integratedFixture(full);
    const compact: any = formatCompactIntegratedSearchResponse(response);
    expect(compact.realtime.items.map((it: any) => it.id)).toEqual(full.items.map((it: any) => it.id));
    expect(compact.realtime.count).toBe(full.items.length);
    expect(compact.realtime.effectiveQuery).toBe(full.effectiveQuery);
    expect(compact.realtime.isFallback).toBe(full.isFallback);
    for (const key of ['retrievalQueries', 'contributingQueries', 'resultsMerged']) {
      expect(key in compact.realtime).toBe(false);
    }
    expect(compact.results).toEqual(response.results);
    expect(compact.count).toBe(response.count);
  });

  test('verbose keeps integrated realtime provenance', async () => {
    const { full } = await runFullCoverageRetrieval();
    const response = integratedFixture(full);
    const verbose: any = formatCompactIntegratedSearchResponse(response, { verbose: true });
    expect(verbose).toEqual(response);
  });

  test('compact integrated response is smaller than full', async () => {
    const { full } = await runFullCoverageRetrieval();
    const response = integratedFixture(full);
    const before = measureSerializedResponseSize(response);
    const after = measureSerializedResponseSize(formatCompactIntegratedSearchResponse(response));
    expect(after.chars).toBeLessThan(before.chars);
  });
});
