// 字幕の段落選び（チャプターの無い動画）の評価。docs/evaluations/youtube-excerpt/results.md
// 正解は説明欄のチャプターの時間帯、検索語はチャプターの題名。入力はチャプターを外した段落、予算は 2000 字。
// 今の rankParagraphs（話題のつながりの HMM）と、段落ごとの BM25 の順（以前の方式）を比べる。字幕の本文は出力しない。
// YouTube に問い合わせる（動画ごとに 1 回、間隔を空ける）。
// Usage: bun scripts/eval-youtube-excerpt.ts [--split dev|held] [--delay-ms 1500]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePassage, extractTermsWithBigrams } from '../src/extractor/hierarchical_bm25.js';
import { getYoutubeTranscript, rankParagraphs, type Paragraph } from '../src/services/youtube.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const split = arg('--split');
const delayMs = Math.max(500, parseInt(arg('--delay-ms') ?? '', 10) || 1500);
const BUDGET = 2000;
type Case = { videoId: string; query: string; lo: number; hi: number; split: 'dev' | 'held' };
const cases: Case[] = JSON.parse(readFileSync(join(here, '../eval/youtube_excerpt_cases.json'), 'utf8')).cases.filter((c: Case) => !split || c.split === split);

const clock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const toSec = (t: string) => t.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

/** 以前の方式: 段落ごとの BM25 の高い順（点数 0 は選ばない）に予算まで。 */
function bm25Only(paras: Paragraph[], query: string, cost: (i: number) => number): number[] {
  const blocks = paras.map((p) => ({ headingPath: [], nearestHeading: '', depth: 0, body: p.text }));
  const terms = extractTermsWithBigrams(query);
  const scores = blocks.map((b) => scorePassage(b, terms, blocks));
  const order = scores.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.i);
  const chosen: number[] = [];
  let used = 0;
  for (const i of order.length ? order : paras.map((_, i) => i)) {
    const add = cost(i) + (chosen.length ? 1 : 0);
    if (chosen.length && used + add > BUDGET) { if (order.length) continue; break; }
    chosen.push(i);
    used += add;
  }
  return chosen;
}

const transcripts = new Map<string, Paragraph[]>();
for (const id of [...new Set(cases.map((c) => c.videoId))]) {
  const r = await getYoutubeTranscript({ url: id, maxChars: 10_000_000 });
  const lines = String(r.transcript?.text ?? '').split('\n');
  transcripts.set(id, lines.map((l) => l.match(/^\[(\d+(?::\d+){1,2})\] (.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ startSec: toSec(m[1]), text: m[2] })));
  await new Promise((r) => setTimeout(r, delayMs));
}

// 指標は精度と取れた割合（rankParagraphs は時刻順で返すので、1 位は見ない）
const total = { old: { precision: 0, coverage: 0 }, now: { precision: 0, coverage: 0 } };
let n = 0;
for (const c of cases) {
  const paras = transcripts.get(c.videoId) ?? [];
  if (paras.length === 0) continue;
  const lens = paras.map((p) => `[${clock(p.startSec)}] ${p.text}`.length);
  const inGold = (i: number) => paras[i].startSec >= c.lo && paras[i].startSec < c.hi;
  const goldChars = paras.reduce((a, _, i) => a + (inGold(i) ? lens[i] : 0), 0);
  const score = (chosen: number[]) => {
    const sel = chosen.reduce((a, i) => a + lens[i], 0);
    const hit = chosen.filter(inGold).reduce((a, i) => a + lens[i], 0);
    return { precision: sel ? hit / sel : 0, coverage: goldChars ? hit / Math.min(goldChars, BUDGET) : 0 };
  };
  const o = score(bm25Only(paras, c.query, (i) => lens[i]));
  const w = score(rankParagraphs(paras, c.query, BUDGET, (i) => lens[i], 1, []).indices);
  for (const k of ['precision', 'coverage'] as const) { total.old[k] += o[k]; total.now[k] += w[k]; }
  n++;
}
const avg = (t: { precision: number; coverage: number }) => ({ precision: +(t.precision / n).toFixed(3), coverage: +(t.coverage / n).toFixed(3) });
console.log(JSON.stringify({ split: split ?? 'all', cases: n, bm25Only: avg(total.old), current: avg(total.now) }));
