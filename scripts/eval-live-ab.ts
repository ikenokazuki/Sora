// Live retrieval A/B (RFC section 49, retrieval level, no scraping).
// Arms: A = legacy BM25 reorder, B = provider order, C = union + RRF,
// D = union + adaptive rescue observation.
// Discipline: sequential queries with inter-query delay; bounded count.
// Default runs offline selftest only. Pass --live to hit the provider.
// Usage: bun scripts/eval-live-ab.ts [--live] [--limit 3] [--delay-ms 3000]
//        [--out eval/results/live-ab-<ts>.json]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchYahooWeb } from '../src/services/yahoo.js';
import { rerankSearchResults } from '../src/enrichment.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const live = args.includes('--live');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Math.max(1, parseInt(args[limitIdx + 1], 10) || 3) : 3;
const delayIdx = args.indexOf('--delay-ms');
const delayMs = delayIdx >= 0 ? Math.max(1000, parseInt(args[delayIdx + 1], 10) || 3000) : 3000;
const outIdx = args.indexOf('--out');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const top = (arr: any[]) => arr[0]?.url || arr[0]?.link || null;

if (!live) {
  // Offline selftest: arm mechanics on a synthetic batch.
  const { mergeYahooWebQueryBatches } = await import('../src/services/yahoo.js');
  const batches = [
    { query: 'q', queryIndex: 0, items: [
      { title: 'official thin', snippet: 'buy', url: 'https://maker.example/o' },
      { title: 'q stuffed review', snippet: 'q q q', url: 'https://blog.example/1' },
    ]},
  ];
  const merged: any[] = mergeYahooWebQueryBatches(batches as any, 'q stuffed');
  if (merged[0].url !== 'https://maker.example/o') throw new Error('union should keep provider top first');
  const legacy = rerankSearchResults(merged.map((x: any) => ({ ...x })), 'q stuffed');
  if (legacy[0].url === merged[0].url) throw new Error('expected legacy reorder on this fixture');
  console.log('live-ab selftest ok (offline mechanics)');
  process.exit(0);
}
const queries = JSON.parse(readFileSync(join(here, '../eval/live_queries.json'), 'utf8')).queries.slice(0, limit);
const rows: any[] = [];
for (const q of queries) {
  const row: any = { id: q.id, category: q.category, query: q.query };
  const t0 = Date.now();
  let base: any = null;
  try {
    base = await searchYahooWeb({ query: q.query });
  } catch (e: any) {
    row.error = String(e?.message || e).slice(0, 200);
  }
  row.ms = Date.now() - t0;
  const items = Array.isArray(base?.items) ? base.items : [];
  row.count = items.length;
  row.isFallback = base?.isFallback ?? null;
  await sleep(delayMs);
  const prevUnion = process.env.SORA_WEB_QUERY_UNION;
  process.env.SORA_WEB_QUERY_UNION = 'true';
  let union: any = null;
  try {
    union = await searchYahooWeb({ query: q.query });
  } catch (e: any) {
    row.unionError = String(e?.message || e).slice(0, 200);
  } finally {
    if (prevUnion === undefined) delete process.env.SORA_WEB_QUERY_UNION;
    else process.env.SORA_WEB_QUERY_UNION = prevUnion;
  }
  await sleep(delayMs);
  const unionItems = Array.isArray(union?.items) ? union.items : [];
  const legacy = items.length > 1 ? rerankSearchResults(items.map((it: any) => ({ ...it })), q.query) : items;
  row.arms = {
    A_top: top(legacy),
    B_top: top(items),
    C_top: top(unionItems),
    agreeAB: top(legacy) === top(items),
    unionCount: unionItems.length,
    adaptiveFired: union?.adaptiveUnion === true,
  };
  rows.push(row);
  console.log(JSON.stringify({ id: q.id, ms: row.ms, count: row.count, agreeAB: row.arms.agreeAB }));
}
if (outIdx >= 0 && args[outIdx + 1]) {
  mkdirSync(dirname(args[outIdx + 1]), { recursive: true });
  writeFileSync(args[outIdx + 1], JSON.stringify({ startedAt: new Date().toISOString(), delayMs, rows }, null, 2));
  console.log('wrote ' + args[outIdx + 1]);
}
