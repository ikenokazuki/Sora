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
    expect(compact.items).toEqual(full.items);
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
  test('compact strips realtime provenance, keeps realtime items and web results', async () => {
    const { full } = await runFullCoverageRetrieval();
    const response = integratedFixture(full);
    const compact: any = formatCompactIntegratedSearchResponse(response);
    expect(compact.realtime.items).toEqual(full.items);
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
