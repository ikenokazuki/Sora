// Minimal offline retrieval eval (proposal section 29-30, starter set).
// Usage:
//   bun scripts/eval-search-retrieval.ts --selftest
//   bun scripts/eval-search-retrieval.ts [--json-out eval/results/retrieval-<ts>.json]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rerankSearchResults, computeAnswerability } from '../src/enrichment.js';
import { mergeYahooWebQueryBatches, assessRetrievalConfidence } from '../src/services/yahoo.js';
import { selectScrapeTargets, assessEvidenceSufficiency } from '../src/scraper.js';
import { rankRealtimeItems } from '../src/services/x_detail.js';

type EvalItem = { title?: string; snippet?: string; description?: string; url?: string; link?: string };
type Batch = { query: string; queryIndex: number; items: EvalItem[] };
type EvalCase = { id: string; category: string; query: string; requirements: string[]; officialHosts?: string[]; batches: Batch[] };

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = join(here, '../eval/search_retrieval_cases.json');
const raw = JSON.parse(readFileSync(casesPath, 'utf8'));
const cases: EvalCase[] = raw.cases;

function flatDedup(batches: Batch[]): EvalItem[] {
  const seen = new Set<string>();
  const out: EvalItem[] = [];
  for (const b of batches) for (const it of b.items) {
    const key = (it.url || (it as any).link || '') ? `url:${it.url || (it as any).link}` : `text:${it.title} ${it.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it });
  }
  return out;
}
function reqCoverage(items: EvalItem[], requirements: string[]): number {
  if (requirements.length === 0) return 1;
  const corpus = items.map((it) => `${it.title || ''} ${it.snippet || (it as any).description || ''}`.toLowerCase()).join('\n');
  const hit = requirements.filter((r) => corpus.includes(r.toLowerCase())).length;
  return hit / requirements.length;
}
function uniqueDomains(items: EvalItem[]): number {
  const s = new Set<string>();
  for (const it of items) { try { s.add(new URL((it.url || (it as any).link) as string).hostname); } catch {} }
  return s.size;
}
function officialRecall(items: EvalItem[], hosts: string[] = []): number {
  if (!hosts || hosts.length === 0) return 1;
  return items.some((it) => { try { const h = new URL((it.url || (it as any).link) as string).hostname; return hosts.some((o) => h === o || h.endsWith('.' + o)); } catch { return false; } }) ? 1 : 0;
}
function answerTotal(items: EvalItem[], query: string): number {
  return items.reduce((a, it) => a + computeAnswerability(it as any, query).score, 0);
}
function armA(c: EvalCase): EvalItem[] { return rerankSearchResults(flatDedup(c.batches) as any, c.query).slice(0, 5) as EvalItem[]; }
function armB(c: EvalCase): EvalItem[] { return flatDedup(c.batches).slice(0, 5); }
function armC(c: EvalCase): EvalItem[] {
  const pool = flatDedup(c.batches);
  return selectScrapeTargets(pool as any, Math.min(5, Math.max(pool.length, 1)), c.query).targets as EvalItem[];
}
function armD(c: EvalCase): EvalItem[] { return (mergeYahooWebQueryBatches(c.batches as any, c.query) as EvalItem[]).slice(0, 5); }
function armE(c: EvalCase): EvalItem[] {
  const merged = mergeYahooWebQueryBatches(c.batches as any, c.query) as EvalItem[];
  const sel = selectScrapeTargets(merged as any, Math.min(5, merged.length), c.query);
  return sel.targets as EvalItem[];
}
function scoreCase(c: EvalCase) {
  const arms = { A: armA(c), B: armB(c), C: armC(c), D: armD(c), E: armE(c) } as Record<string, EvalItem[]>;
  const out: Record<string, any> = {};
  for (const [k, items] of Object.entries(arms)) {
    out[k] = {
      topUrls: items.map((it) => it.url || (it as any).link),
      reqCoverage: Number(reqCoverage(items, c.requirements).toFixed(3)),
      uniqueDomains: uniqueDomains(items),
      officialRecall: officialRecall(items, c.officialHosts || []),
      answerScore: Number(answerTotal(items, c.query).toFixed(2)),
    };
  }
  const firstBatch = c.batches[0]?.items || [];
  const conf = assessRetrievalConfidence(firstBatch as any, c.query);
  const ev = assessEvidenceSufficiency(armE(c).map((it) => ({ ...it, markdown: `${it.title} ${it.snippet}` })) as any, c.query);
  return { id: c.id, category: c.category, query: c.query, confidence: conf, evidence: ev, arms: out };
}
const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  // Invariants: B preserves provider order; D boosts multi-hit; C keeps top3.
  const multi = cases.find((c) => c.id === 'multifacet-01')!;
  const d = armD(multi).map((x) => x.url);
  if (d[0] !== 'https://maker.example/product') throw new Error('RRF should boost multi-hit maker product, got ' + d[0]);
  const b = armB(multi).map((x) => x.url);
  if (b[0] !== 'https://maker.example/product') throw new Error('B should preserve provider order');
  const c = armC(multi).map((x) => x.url);
  if (c[0] !== b[0] || c[1] !== b[1] || c[2] !== b[2]) throw new Error('C must guarantee top3');
  const weak = assessRetrievalConfidence([{ title: 'a', snippet: 'a', url: 'https://a.example/' }, { title: 'a', snippet: 'a', url: 'https://b.example/' }] as any, 'a b c');
  if (weak.good) throw new Error('confidence should flag missing terms');
  // X native ranking invariants (section 50).
  const posts = [
    { id: '1', author_handle: 'fan', text: 'SPARK legend live best ever', publishedTime: new Date(Date.now() - 30 * 86400000).toISOString() },
    { id: '2', author_handle: 'official', text: 'SPARK announcement', publishedTime: new Date().toISOString() },
  ];
  const recent = rankRealtimeItems(posts as any, { query: 'SPARK', mode: 'recent' });
  if (recent[0].id !== '1') throw new Error('recent must preserve provider order');
  const ev = rankRealtimeItems(posts as any, { query: 'SPARK announcement', mode: 'evidence', officialHandles: ['official'] });
  if (ev[0].id !== '2') throw new Error('evidence must prefer official full-coverage post');
  console.log('selftest ok: ' + cases.length + ' cases + xrank');
  process.exit(0);
}
type XEvalCase = { id: string; query: string; requirements: string[]; officialHandles: string[]; posts: any[] };
const xCases: XEvalCase[] = [
  { id: 'x-fact-01', query: 'SPARK announcement', requirements: ['spark', 'announcement'], officialHandles: ['official'], posts: [
    { id: '1', author_handle: 'fan', text: 'SPARK legend live best ever', publishedTime: new Date(Date.now() - 30 * 86400000).toISOString() },
    { id: '2', author_handle: 'official', text: 'SPARK announcement venue changed', publishedTime: new Date().toISOString() },
    { id: '3', author_handle: 'fan2', text: 'random daily post', publishedTime: new Date().toISOString() },
  ] },
  { id: 'x-popular-01', query: 'SPARK announcement', requirements: ['spark', 'announcement'], officialHandles: [], posts: [
    { id: '1', author_handle: 'viral', text: 'SPARK lol', publishedTime: new Date(Date.now() - 1 * 3600000).toISOString() },
    { id: '2', author_handle: 'fan', text: 'SPARK detailed announcement analysis', publishedTime: new Date(Date.now() - 2 * 3600000).toISOString() },
  ] },
  { id: 'x-rrf-01', query: 'SPARK ticket', requirements: ['spark'], officialHandles: [], posts: [
    { id: '1', author_handle: 'a', text: 'SPARK ticket', publishedTime: new Date().toISOString() },
    { id: '2', author_handle: 'b', text: 'SPARK ticket', publishedTime: new Date().toISOString(), rrfScore: 0.05 },
  ] },
  { id: 'x-fresh-01', query: 'SPARK news', requirements: ['spark'], officialHandles: [], posts: [
    { id: '1', author_handle: 'a', text: 'SPARK news', publishedTime: new Date(Date.now() - 20 * 86400000).toISOString() },
    { id: '2', author_handle: 'b', text: 'SPARK news', publishedTime: new Date().toISOString() },
  ] },
  { id: 'x-reaction-01', query: 'SPARK 反応', requirements: ['spark', '反応'], officialHandles: ['official'], posts: [
    { id: '1', author_handle: 'official', text: 'SPARK news', publishedTime: new Date().toISOString() },
    { id: '2', author_handle: 'fanA', text: 'SPARK 反応', publishedTime: new Date().toISOString() },
    { id: '3', author_handle: 'fanB', text: 'SPARK 反応まとめ', publishedTime: new Date().toISOString() },
  ] },
  { id: 'x-lexical-01', query: 'SPARK', requirements: ['spark'], officialHandles: [], posts: [
    { id: '1', author_handle: 'a', text: 'ok', publishedTime: new Date().toISOString() },
    { id: '2', author_handle: 'b', text: 'SPARK SPARK SPARK detailed', publishedTime: new Date().toISOString() },
  ] },
  { id: 'x-recency-01', query: 'SPARK live', requirements: ['spark'], officialHandles: [], posts: [
    { id: '1', author_handle: 'a', text: 'SPARK live report', publishedTime: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: '2', author_handle: 'b', text: 'SPARK live photos', publishedTime: new Date(Date.now() - 10 * 86400000).toISOString() },
  ] },
];
function scoreXCase(c: XEvalCase) {
  const arms: Record<string, any[]> = {
    recent: rankRealtimeItems(c.posts as any, { query: c.query, mode: 'recent' }),
    popular: rankRealtimeItems(c.posts as any, { query: c.query, mode: 'popular' }),
    evidence: rankRealtimeItems(c.posts as any, { query: c.query, mode: 'evidence', requirements: c.requirements, officialHandles: c.officialHandles }),
  };
  const out: Record<string, any> = {};
  for (const [k, items] of Object.entries(arms)) {
    const top = items[0] || {};
    const text = ((top as any).text || '').toLowerCase();
    const covered = c.requirements.filter((t) => text.includes(t)).length;
    out[k] = { topId: (top as any).id ?? null, coverage: c.requirements.length > 0 ? Number((covered / c.requirements.length).toFixed(3)) : 1 };
  }
  return { id: c.id, query: c.query, arms: out };
}
const results = cases.map(scoreCase);
const agg: Record<string, any> = {};
for (const arm of ['A','B','C','D','E']) {
  const rs = results.map((r) => r.arms[arm].reqCoverage);
  const os = results.map((r) => r.arms[arm].officialRecall);
  agg[arm] = { meanReqCoverage: Number((rs.reduce((a,b)=>a+b,0)/rs.length).toFixed(3)), meanOfficialRecall: Number((os.reduce((a,b)=>a+b,0)/os.length).toFixed(3)), cases: rs.length };
}
console.log('## Retrieval eval (offline, ' + cases.length + ' cases)');
console.log('');
console.log('| case | A cov | B cov | C cov | D cov | E cov |');
console.log('|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.id} | ${r.arms.A.reqCoverage} | ${r.arms.B.reqCoverage} | ${r.arms.C.reqCoverage} | ${r.arms.D.reqCoverage} | ${r.arms.E.reqCoverage} |`);
console.log('');
console.log('Adaptive trigger (first-batch confidence):');
console.log('');
console.log('| case | would-adapt | reasons |');
console.log('|---|---|---|');
for (const r of results) console.log('| ' + r.id + ' | ' + (!r.confidence.good) + ' | ' + (r.confidence.reasons.join(', ') || '-') + ' |');
console.log('');
const xResults = xCases.map(scoreXCase);
console.log('Mean req coverage: ' + JSON.stringify(agg));
console.log('');
console.log('## X ranking eval (offline, ' + xCases.length + ' cases)');
console.log('');
console.log('| case | recent top | popular top | evidence top | evidence cov |');
console.log('|---|---|---|---|---|');
for (const r of xResults) console.log('| ' + r.id + ' | ' + r.arms.recent.topId + ' | ' + r.arms.popular.topId + ' | ' + r.arms.evidence.topId + ' | ' + r.arms.evidence.coverage + ' |');
const outIdx = args.indexOf('--json-out');
if (outIdx >= 0 && args[outIdx+1]) {
  mkdirSync(dirname(args[outIdx+1]), { recursive: true });
  writeFileSync(args[outIdx+1], JSON.stringify({ startedAt: new Date().toISOString(), results, agg, xResults }, null, 2));
  console.log('wrote ' + args[outIdx+1]);
}
