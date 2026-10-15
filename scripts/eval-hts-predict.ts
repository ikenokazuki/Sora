// HTS 推測（POST /trade/hts-predict、MCP predict_hts_code）の評価。
// 実データ（USITC 全件・CBP 判例）に問い合わせる。dev で調整し、test は報告だけに使う（eval/hts_predict_cases.json の split）。
// 指標: 1位の6桁一致、1位の見出し（4桁）一致、候補（上位）内の6桁一致、信頼度ごとの的中率、待ち時間。
// --no-cross は CBP 判例への通信を遮断する（判例の寄与と、判例が使えないときの経路を測る）。
// Usage: bun scripts/eval-hts-predict.ts [--split dev|test] [--no-cross] [--limit N] [--out eval/results/hts-predict-<ts>.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predictHtsCode } from '../src/services/trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const split = arg('--split');
const noCross = args.includes('--no-cross');
const limit = parseInt(arg('--limit') ?? '', 10) || Infinity;

if (noCross) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(raw).hostname === 'rulings.cbp.gov') return new Response('blocked by --no-cross', { status: 503 });
    return original(input as never, init);
  }) as typeof fetch;
}

interface Case {
  id: string;
  split: string;
  productName: string;
  description: string;
  material?: string;
  expected: { hs6: string[] };
}
const data = JSON.parse(readFileSync(join(here, '../eval/hts_predict_cases.json'), 'utf8')) as { cases: Case[] };
const cases = data.cases.filter((c) => !split || c.split === split).slice(0, limit);

const digits = (s: string) => s.replace(/\D/g, '');
const matches = (code: string, expected: string[]) => expected.some((p) => digits(code).startsWith(p));
const heading = (code: string, expected: string[]) => expected.some((p) => digits(code).slice(0, 4) === p.slice(0, 4));
const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`);

interface Row {
  id: string;
  split: string;
  name: string;
  expected: string[];
  got?: string;
  rate?: string;
  confidence?: string;
  ok6: boolean;
  ok4: boolean;
  inCandidates: boolean;
  ms: number;
  error?: string;
}
const rows: Row[] = [];
for (const c of cases) {
  const t0 = performance.now();
  const row: Row = { id: c.id, split: c.split, name: c.productName, expected: c.expected.hs6, ok6: false, ok4: false, inCandidates: false, ms: 0 };
  try {
    const r = await predictHtsCode({ productName: c.productName, description: c.description, material: c.material });
    row.got = r.bestMatch.htsCode;
    row.rate = r.bestMatch.generalRate;
    row.confidence = r.bestMatch.confidence;
    row.ok6 = matches(r.bestMatch.htsCode, c.expected.hs6);
    row.ok4 = heading(r.bestMatch.htsCode, c.expected.hs6);
    row.inCandidates = r.candidates.some((x) => matches(x.htsCode, c.expected.hs6)) || row.ok6;
  } catch (err) {
    row.error = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
  }
  row.ms = Math.round(performance.now() - t0);
  rows.push(row);
}

const summarize = (rs: Row[]) => {
  const n = rs.length;
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const byConf: Record<string, { n: number; ok: number }> = {};
  for (const r of rs) {
    const k = r.confidence ?? 'error';
    const s = (byConf[k] ??= { n: 0, ok: 0 });
    s.n++;
    if (r.ok6) s.ok++;
  }
  return {
    n,
    top1Hs6: rs.filter((r) => r.ok6).length,
    top1Heading: rs.filter((r) => r.ok4).length,
    inCandidates: rs.filter((r) => r.inCandidates).length,
    errors: rs.filter((r) => r.error).length,
    byConfidence: byConf,
    firstCallMs: rs[0]?.ms,
    p50Ms: ms[Math.floor(ms.length * 0.5)],
    p95Ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
  };
};

for (const r of rows) {
  if (r.ok6) continue;
  console.log(`${r.ok4 ? '4d' : 'NG'} ${r.id} ${r.name.padEnd(44)} exp=${r.expected.join('/')} got=${r.got ?? `ERR ${r.error}`} conf=${r.confidence ?? '-'} rate=${r.rate ?? '-'}`);
}
const splits = [...new Set(rows.map((r) => r.split))];
const summary: Record<string, ReturnType<typeof summarize>> = { all: summarize(rows) };
for (const s of splits) summary[s] = summarize(rows.filter((r) => r.split === s));
console.log(`\n${noCross ? '[--no-cross] ' : ''}cases=${rows.length}`);
for (const [name, s] of Object.entries(summary)) {
  const conf = Object.entries(s.byConfidence).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(', ');
  console.log(
    `${name.padEnd(5)} top1 6-digit ${s.top1Hs6}/${s.n} (${pct(s.top1Hs6, s.n)}), heading ${pct(s.top1Heading, s.n)}, in candidates ${pct(s.inCandidates, s.n)}, errors ${s.errors}; by confidence: ${conf}; first ${s.firstCallMs}ms p50 ${s.p50Ms}ms p95 ${s.p95Ms}ms`,
  );
}

const outPath = arg('--out') ?? join(here, `../eval/results/hts-predict-${noCross ? 'no-cross-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), noCross, split: split ?? 'all', rows, summary }, null, 2));
console.log(`wrote ${outPath}`);
process.exit(0);
