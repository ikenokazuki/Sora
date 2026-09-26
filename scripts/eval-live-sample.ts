// Live retrieval sample (RFC evaluation dataset bootstrap).
// Executes a bounded subset of eval/live_queries.json against the
// real Yahoo provider and records latency, counts, provider ranks,
// native-vs-legacy top-1 agreement and adaptive-trigger reasons.
// Usage: bun scripts/eval-live-sample.ts [--limit 3] [--out eval/results/live-sample-<ts>.json]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchYahooWeb, assessRetrievalConfidence } from '../src/services/yahoo.js';
import { rerankSearchResults } from '../src/enrichment.js';

const here = dirname(fileURLToPath(import.meta.url));
const list = JSON.parse(readFileSync(join(here, '../eval/live_queries.json'), 'utf8')).queries as Array<{ id: string; category: string; query: string }>;
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Math.max(1, parseInt(args[limitIdx + 1], 10) || 3) : 3;
const outIdx = args.indexOf('--out');

const rows: any[] = [];
for (const q of list.slice(0, limit)) {
  const t0 = Date.now();
  let res: any = null;
  let err: string | null = null;
  try {
    res = await searchYahooWeb({ query: q.query });
  } catch (e: any) {
    err = String(e?.message || e).slice(0, 200);
  }
  const ms = Date.now() - t0;
  const items = Array.isArray(res?.items) ? res.items : [];
  const legacy = items.length > 1 ? rerankSearchResults(items.map((it: any) => ({ ...it })), q.query) : items;
  const topNative = items[0]?.url || items[0]?.link || null;
  const topLegacy = (legacy[0] as any)?.url || (legacy[0] as any)?.link || null;
  const conf = assessRetrievalConfidence(items, q.query);
  rows.push({
    id: q.id, category: q.category, query: q.query,
    ms, count: items.length, error: err,
    effectiveQuery: res?.effectiveQuery ?? null, isFallback: res?.isFallback ?? null,
    providerRankPresent: items.every((it: any) => typeof it.providerRank === 'number'),
    top1AgreementNativeVsLegacy: topNative === topLegacy,
    topNative, topLegacy,
    adaptiveWouldFire: !conf.good, adaptiveReasons: conf.reasons,
  });
  console.log(JSON.stringify({ id: q.id, ms, count: items.length, agree: topNative === topLegacy, adapt: !conf.good }));
}
if (outIdx >= 0 && args[outIdx + 1]) {
  mkdirSync(dirname(args[outIdx + 1]), { recursive: true });
  writeFileSync(args[outIdx + 1], JSON.stringify({ startedAt: new Date().toISOString(), rows }, null, 2));
  console.log('wrote ' + args[outIdx + 1]);
}
