import { describe, expect, test } from 'bun:test';
import {
  searchYahooRealtime,
  extractRealtimeIntentRequirements,
  buildRealtimeExactQueryVariants,
  buildRealtimeRelaxationCandidates,
  evaluateRealtimeRetrievalCoverage,
  getRealtimeCanonicalIdentity,
  mergeRealtimeQueryBatches,
  MAX_REALTIME_RETRIEVAL_QUERIES,
  MAX_REALTIME_QUERIES_PER_WAVE,
} from './yahoo.js';

function realtimeMcpResponse(items: any[]) {
  return { content: [{ text: JSON.stringify({ items }) }] };
}

function post(id: string, text: string, handle = 'kimisora_JPN') {
  return {
    id,
    author_handle: handle,
    author_name: 'test',
    text,
    url: `https://x.com/${handle}/status/${id}`,
    created_at: 1758000000,
  };
}

function mockMcp(handler: (query: string) => any[], calls: string[]) {
  return async (_tool: string, args: Record<string, any>) => {
    calls.push(args.query);
    const items = handler(args.query);
    if (items instanceof Error) throw items;
    return realtimeMcpResponse(items);
  };
}

const OPT = { detailEnrichment: false } as const;

describe('Realtime Retrieval v1', () => {
  test('bounds constants', () => {
    expect(MAX_REALTIME_RETRIEVAL_QUERIES).toBe(5);
    expect(MAX_REALTIME_QUERIES_PER_WAVE).toBe(2);
  });

  test('Test1: first-nonempty regression rescues missing-term post', async () => {
    const calls: string[] = [];
    const target = post('999', 'SPARK 出演辞退のお知らせ');
    const partial = post('111', 'SPARK出演のお知らせ');
    const provider = mockMcp((q) => (q.includes('辞退') && q !== 'SPARK 出演 辞退 id:kimisora_JPN' && q !== 'id:kimisora_JPN SPARK 出演 辞退' ? [target] : [partial]), calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(calls.length).toBeGreaterThan(1);
    expect(res.items.some((it: any) => String(it.id) === '999')).toBe(true);
  });

  test('Test2: exact success stops early without relaxation', async () => {
    const calls: string[] = [];
    const full = post('200', 'SPARK 出演 辞退のお知らせ');
    const provider = mockMcp(() => [full], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.stopReason).toBe('full_coverage');
    expect(calls.some((q) => q === 'id:kimisora_JPN SPARK 辞退')).toBe(false);
    expect(calls.some((q) => q === 'id:kimisora_JPN 出演 辞退')).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  test('Test3: canonical exact variant is not fallback', async () => {
    const calls: string[] = [];
    const full = post('300', 'SPARK 出演 辞退 決定');
    const provider = mockMcp(() => [full], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.isFallback).toBe(false);
  });

  test('Test4: relaxed candidates preserve protected id:', async () => {
    const calls: string[] = [];
    const partial = post('111', 'SPARK出演のお知らせ');
    const provider = mockMcp(() => [partial], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.retrievalQueries.length).toBeGreaterThan(0);
    for (const q of res.retrievalQueries) {
      expect(q).toContain('id:kimisora_JPN');
    }
  });

  test('Test5: bounded query count in worst case', async () => {
    const calls: string[] = [];
    const provider = mockMcp(() => [], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.retrievalQueries.length).toBeLessThanOrEqual(5);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  test('Test6: disableFallback issues exactly one provider call', async () => {
    const calls: string[] = [];
    const provider = mockMcp(() => [post('1', 'SPARK 出演')], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      disableFallback: true,
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(calls).toHaveLength(1);
    expect(res.retrievalQueries).toHaveLength(1);
    expect(res.resultsMerged).toBe(false);
  });

  test('Test7: failure isolation within a wave', async () => {
    const calls: string[] = [];
    const good = post('500', 'SPARK 出演 辞退 速報');
    const provider = async (_tool: string, args: Record<string, any>) => {
      calls.push(args.query);
      if (args.query.startsWith('id:kimisora_JPN SPARK')) throw new Error('boom');
      return realtimeMcpResponse([good]);
    };
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.items.length).toBeGreaterThan(0);
  });

  test('Test8: same status from multiple queries dedups to one', async () => {
    const calls: string[] = [];
    const same = post('1234567890', 'SPARK 出演 辞退 決定');
    const provider = mockMcp(() => [same], calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.items.filter((it: any) => String(it.id) === '1234567890')).toHaveLength(1);
  });

  test('Test9: same text with different status IDs keeps both', async () => {
    const calls: string[] = [];
    let n = 0;
    const provider = mockMcp(() => {
      n++;
      return [post(n === 1 ? '1111111111' : '2222222222', 'SPARK 出演 辞退 決定')];
    }, calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(res.items.length).toBe(2);
  });

  test('Test10: final rerank uses original query', async () => {
    const calls: string[] = [];
    const weak = post('111', 'SPARK 辞退');
    const strong = post('222', 'SPARK 出演 辞退 決定');
    const provider = mockMcp((q) => (q.includes('出演') && q.includes('辞退') ? [weak, strong] : [weak]), calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(String(res.items[0].id)).toBe('222');
  });

  test('Test11: provenance contract', async () => {
    const calls: string[] = [];
    const partial = post('111', 'SPARK出演のお知らせ');
    const target = post('999', 'SPARK 出演辞退 正式発表');
    const provider = mockMcp((q) => {
      if (q === 'SPARK 出演 辞退 id:kimisora_JPN' || q === 'id:kimisora_JPN SPARK 出演 辞退') return [partial];
      return [target];
    }, calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      limit: 10,
      ...OPT,
      _callMcp: provider,
    } as any);
    expect(Array.isArray(res.retrievalQueries)).toBe(true);
    expect(res.retrievalQueries.length).toBeGreaterThanOrEqual(2);
    expect(res.contributingQueries.length).toBeGreaterThanOrEqual(2);
    expect(res.resultsMerged).toBe(true);
    expect(res.isFallback).toBe(true);
    expect(res.effectiveQuery).toBe('SPARK 出演 辞退 id:kimisora_JPN');
  });

  test('Test12: detail enrichment runs once after final merge', async () => {
    const calls: string[] = [];
    const mk = (id: string, text: string) => ({
      id: `post-${id}`,
      author_handle: 'kimisora_JPN',
      author_name: 't',
      text,
      url: `https://x.com/kimisora_JPN`,
      created_at: 1758000000,
    });
    const provider = mockMcp((q) => {
      if (q === 'SPARK 出演 辞退 id:kimisora_JPN' || q === 'id:kimisora_JPN SPARK 出演 辞退') {
        return [mk('a', 'SPARK出演のお知らせ')];
      }
      return [mk('b', 'SPARK 出演辞退のお知らせ')];
    }, calls);
    const res: any = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      _callMcp: provider,
    } as any);
    expect(res.items.length).toBeGreaterThan(0);
    expect(calls.length).toBe(res.retrievalQueries.length);
    for (const it of res.items) {
      expect(it.snippet).toBeUndefined();
      expect(it.markdown).toBeUndefined();
    }
  });

  test('helpers: intent requirements keep whitespace terms atomic', () => {
    const req = extractRealtimeIntentRequirements('SPARK 出演 辞退 id:kimisora_JPN');
    expect(req.semanticRequirements).toEqual(['SPARK', '出演', '辞退']);
    expect(req.protectedModifiers).toEqual(['id:kimisora_JPN']);
  });

  test('helpers: exact variants are syntax-only', () => {
    const variants = buildRealtimeExactQueryVariants('SPARK 出演 辞退 id:kimisora_JPN');
    expect(variants).toEqual(['SPARK 出演 辞退 id:kimisora_JPN', 'id:kimisora_JPN SPARK 出演 辞退']);
    expect(buildRealtimeExactQueryVariants('SPARK 出演')).toEqual(['SPARK 出演']);
  });

  test('helpers: relaxation prefers missing-term candidates', () => {
    const cands = buildRealtimeRelaxationCandidates(
      ['SPARK', '出演', '辞退'],
      ['id:kimisora_JPN'],
      ['辞退'],
      new Set(['SPARK 出演 辞退 id:kimisora_JPN', 'id:kimisora_JPN SPARK 出演 辞退']),
    );
    expect(cands.slice(0, 2)).toEqual(['id:kimisora_JPN 出演 辞退', 'id:kimisora_JPN SPARK 辞退']);
    expect(cands).not.toContain('id:kimisora_JPN');
  });

  test('helpers: per-item coverage, not corpus-wide', () => {
    const req = extractRealtimeIntentRequirements('SPARK 出演 辞退 id:kimisora_JPN');
    const cov = evaluateRealtimeRetrievalCoverage(
      [{ text: 'SPARK出演のお知らせ', author_handle: 'kimisora_JPN' }],
      req,
    );
    expect(cov.bestCoveredTerms).toEqual(['SPARK', '出演']);
    expect(cov.missingTerms).toEqual(['辞退']);
    expect(cov.hasFullCoverage).toBe(false);
  });

  test('helpers: canonical identity prefers status id over text', () => {
    expect(getRealtimeCanonicalIdentity({ id: '123', text: 'same', url: 'https://x.com/a/status/123' })).toBe('status:123');
    expect(
      getRealtimeCanonicalIdentity({ id: '', text: 'same', url: 'https://x.com/a/status/999' }),
    ).toBe('status:999');
    const merged = mergeRealtimeQueryBatches([
      { query: 'q1', queryIndex: 0, items: [{ id: '1', text: 't' }] },
      { query: 'q2', queryIndex: 1, items: [{ id: '1', text: 't' }, { id: '2', text: 't' }] },
    ]);
    expect(merged.items).toHaveLength(2);
    expect(merged.contributingQueries).toEqual(['q1', 'q2']);
  });
});
