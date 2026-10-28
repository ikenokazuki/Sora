// 段落の点数（scorePassage）を、日本語の公開評価集 JQaRA（CC BY-SA 4.0）で測る。docs/evaluations/term-matching/results.md
// 問いごとの候補（dev 50 件・test 100 件）を一つのページの段落とみなし（見出しは title、IDF も候補の中で数える）、点数の順の nDCG@10・MRR@10 を出す。
// 同点は id のハッシュの順（データの並びには正解が先に来る偏りがある）。--select で、ハイライトの選び方（extractQueryHighlightDetails）が
// 選んだ段落の精度と、同じ数を scorePassage の上位から取った場合を比べる。
//   curl -L -o data/jqara/test.parquet https://huggingface.co/datasets/hotchpotch/JQaRA/resolve/main/data/test-00000-of-00001.parquet
//   duckdb -c "COPY (SELECT q_id, any_value(question) AS question, list(struct_pack(id := id, title := title, text := text, label := label)) AS passages FROM 'data/jqara/test.parquet' GROUP BY q_id ORDER BY q_id) TO 'data/jqara/test.jsonl' (FORMAT JSON)"
//   bun scripts/eval-jqara.ts --data data/jqara --split test [--select]
import { readFileSync } from 'node:fs';
import { extractTermsWithBigrams, scorePassage } from '../src/extractor/hierarchical_bm25.js';
import { extractQueryHighlightDetails } from '../src/enrichment.js';

type Passage = { id: string; title: string; text: string; label: number };
type Q = { q_id: string; question: string; passages: Passage[] };
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const split = arg('--split') ?? 'dev';
const qs: Q[] = readFileSync(`${arg('--data') ?? 'data/jqara'}/${split}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rank = (scores: number[], ps: Passage[]) => ps.map((p, i) => ({ s: scores[i], h: fnv(p.id), i })).sort((a, b) => b.s - a.s || a.h - b.h).map((x) => x.i);

function metrics(order: number[], ps: Passage[]) {
  let dcg = 0, rr = 0;
  order.slice(0, 10).forEach((i, r) => { if (ps[i].label > 0) { dcg += 1 / Math.log2(r + 2); if (!rr) rr = 1 / (r + 1); } });
  const pos = ps.filter((p) => p.label > 0).length;
  let idcg = 0;
  for (let r = 0; r < Math.min(10, pos); r++) idcg += 1 / Math.log2(r + 2);
  return { ndcg: idcg ? dcg / idcg : 0, mrr: rr };
}
const s0 = (q: Q, opts?: { k1?: number; b?: number }) => {
  const blocks = q.passages.map((p) => ({ headingPath: [p.title], nearestHeading: p.title, depth: 1, body: p.text }));
  const terms = extractTermsWithBigrams(q.question);
  return blocks.map((b) => scorePassage(b, terms, blocks, opts));
};

const scorers: Record<string, (q: Q) => number[]> = {
  'scorePassage（今の既定 k1=0.9, b=0.4）': (q) => s0(q),
  'scorePassage（以前の既定 k1=1.5, b=0.75）': (q) => s0(q, { k1: 1.5, b: 0.75 }),
};
for (const [name, fn] of Object.entries(scorers)) {
  let nd = 0, mr = 0, n = 0;
  for (const q of qs) { if (!q.passages.some((p) => p.label > 0)) continue; const m = metrics(rank(fn(q), q.passages), q.passages); nd += m.ndcg; mr += m.mrr; n++; }
  console.log(JSON.stringify({ split, scorer: name, questions: n, ndcg10: +(nd / n).toFixed(4), mrr10: +(mr / n).toFixed(4) }));
}

if (args.includes('--select')) {
  let n = 0, k = 0, hlPos = 0, hlHit = 0, bmPos = 0, bmHit = 0;
  for (const q of qs) {
    if (!q.passages.some((p) => p.label > 0)) continue;
    const md = q.passages.map((p) => `## ${p.title}\n\n${p.text}`).join('\n\n');
    // ハイライトは「## 見出し\n\n本文（長い節は区間を切り出し）」なので、本文の先頭 30 字を含む候補に当てる
    const sel = extractQueryHighlightDetails(md, q.question, {}).highlights
      .map((h) => q.passages.findIndex((p) => p.text.includes(h.replace(/^## .*\n\n/, '').replace(/^\.\.\./, '').slice(0, 30))))
      .filter((i) => i >= 0);
    n++;
    if (sel.length === 0) continue;
    k += sel.length;
    const p = sel.filter((i) => q.passages[i].label > 0).length;
    hlPos += p; if (p > 0) hlHit++;
    const top = rank(s0(q), q.passages).slice(0, sel.length);
    const t = top.filter((i) => q.passages[i].label > 0).length;
    bmPos += t; if (t > 0) bmHit++;
  }
  console.log(JSON.stringify({ split, questions: n, avgSelected: +(k / n).toFixed(2), highlights: { precision: +(hlPos / k).toFixed(4), hit: +(hlHit / n).toFixed(4) }, scorePassageSameCount: { precision: +(bmPos / k).toFixed(4), hit: +(bmHit / n).toFixed(4) } }));
}
