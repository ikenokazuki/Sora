/* eslint-disable no-console */
// Temporary Before/After benchmark for Token Optimization v1 reporting.
// Usage: bun run src/__compact_bench.ts
// Deletes after use; not part of the test suite.
import { searchYahooRealtime } from './services/yahoo.js';
import {
  measureSerializedResponseSize,
  formatCompactRealtimeResponse,
  formatCompactWebSearchResponse,
  formatCompactIntegratedSearchResponse,
} from './search_compact.js';

function realtimeMcpResponse(items: any[]) {
  return { content: [{ text: JSON.stringify({ items }) }] };
}

function post(id: string, text: string, handle = 'kimisora_JPN') {
  return {
    id,
    author_handle: handle,
    author_name: 'テスト投稿者',
    text,
    url: `https://x.com/${handle}/status/${id}`,
    created_at: 1758000000,
    like_count: 12,
    reply_count: 3,
    repost_count: 5,
  };
}

function mockMcp(handler: (query: string) => any[], calls: string[]) {
  return async (_tool: string, args: Record<string, any>) => {
    calls.push(args.query);
    return realtimeMcpResponse(handler(args.query));
  };
}

function report(label: string, before: unknown, after: unknown) {
  const b = measureSerializedResponseSize(before);
  const a = measureSerializedResponseSize(after);
  const red = (((b.bytes - a.bytes) / b.bytes) * 100).toFixed(1);
  console.log(`${label}\nBefore: ${b.bytes.toLocaleString()} bytes\nAfter: ${a.bytes.toLocaleString()} bytes\nReduction: ${red}%`);
}

const webFull = {
  items: [1, 2, 3, 4, 5].map((n) => ({
    source: 'web',
    title: `SPARK 出演辞退 正式発表 その${n}`,
    url: `https://example.com/news/${n}`,
    snippet: `SPARK 出演辞退に関する概要スニペット本文その${n}です。`,
    description: `ページ作成者による説明文その${n}です。`,
    highlights: [`SPARK **出演辞退**を発表 その${n}`],
    retrievalQuery: n % 2 === 0 ? 'SPARK 出演' : 'SPARK 出演 辞退',
    retrievalQueryIndex: n % 2 === 0 ? 1 : 0,
  })),
  count: 5,
  source: 'web',
  originalQuery: 'SPARK 出演 辞退',
  bindingQuery: 'SPARK 出演 辞退',
  retrievalQueries: ['SPARK 出演 辞退', 'SPARK 出演'],
  effectiveQuery: 'SPARK 出演 辞退',
  isFallback: true,
  queryUnion: true,
};

const calls: string[] = [];
const target = post('999', 'SPARK 出演辞退のお知らせが正式に発表されました。詳細は公式サイトをご確認ください。');
const partial = post('111', 'SPARK出演のお知らせです。');
const provider = mockMcp(
  (q) => (q.includes('辞退') && q !== 'SPARK 出演 辞退 id:kimisora_JPN' ? [target, partial] : [partial]),
  calls,
);
const realtimeFull: any = await searchYahooRealtime({
  query: 'SPARK 出演 辞退 id:kimisora_JPN',
  limit: 10,
  detailEnrichment: false,
  _callMcp: provider,
} as any);

const integratedFull = {
  query: 'SPARK 出演 辞退',
  source: 'integrated',
  results: webFull.items.slice(0, 3).map(({ retrievalQuery, retrievalQueryIndex, ...rest }: any) => rest),
  count: 3,
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

report('Yahoo Web Search', webFull, formatCompactWebSearchResponse(webFull));
report('Yahoo Realtime', realtimeFull, formatCompactRealtimeResponse(realtimeFull));
report('Integrated Search', integratedFull, formatCompactIntegratedSearchResponse(integratedFull));
console.log(`Retrieval provider calls: ${calls.length} (compact adds 0)`);
console.log(`Unique realtime candidates: ${realtimeFull.items.length}`);
console.log(`Top target retained: ${String(realtimeFull.items[0]?.id) === '999' ? 'check-order' : 'present-check'} / target present: ${realtimeFull.items.some((it: any) => String(it.id) === '999')}`);
