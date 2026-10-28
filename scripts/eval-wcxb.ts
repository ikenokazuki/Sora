// 本文の取り出し（convertHtmlToMarkdown）を WCXB（Web Content Extraction Benchmark、CC BY 4.0）で測る。
// docs/evaluations/main-content/results.md。ここでは予測の JSON（{file_id: 本文}）を作り、採点は WCXB の evaluate.py で行う。
//   git clone --depth 1 https://github.com/Murrough-Foley/web-content-extraction-benchmark data/wcxb
//   bun scripts/eval-wcxb.ts --data data/wcxb --split test --out data/wcxb-sora-test.json
//   python3 -I data/wcxb/evaluate.py --split test --results data/wcxb-sora-test.json --per-type
// --bevendorff <dir> のときは、Bevendorff ら（SIGIR 2023）の評価集（https://github.com/chatnoir-eu/web-content-extraction-benchmark の
// datasets/combined.tar.xz を展開した combined/）を読み、評価集ごとの語の F1（WCXB と同じ式）を出す。
//   bun scripts/eval-wcxb.ts --bevendorff data/wceb/combined
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { convertHtmlToMarkdown } from '../src/html_parser.js';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = `${arg('--data') ?? 'data/wcxb'}/${arg('--split') ?? 'dev'}`;
const out = arg('--out') ?? `data/wcxb-sora-${arg('--split') ?? 'dev'}.json`;

function decode(buf: Uint8Array): string {
  const cs = new TextDecoder('latin1').decode(buf.slice(0, 4096)).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (cs && cs !== 'utf-8' && cs !== 'utf8') { try { return new TextDecoder(cs).decode(buf); } catch {} }
  return new TextDecoder('utf-8').decode(buf);
}
/** Markdown の記号と URL を外す（採点は \w+ の語で数えるので、URL の語を残さない）。 */
const toText = (md: string) => md
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
  .replace(/^#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  .replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, '').replace(/\|/g, ' ').replace(/[*_`~]{1,3}/g, '');

const extract = (html: string, url: string) => { try { return toText(convertHtmlToMarkdown(html, url, 10_000_000, false, true).markdown); } catch { return ''; } };

const bev = arg('--bevendorff');
if (bev) {
  const tokens = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const f1 = (pred: string, ref: string) => {
    const r = new Map<string, number>(); for (const w of tokens(ref)) r.set(w, (r.get(w) ?? 0) + 1);
    const p = new Map<string, number>(); for (const w of tokens(pred)) p.set(w, (p.get(w) ?? 0) + 1);
    const nr = [...r.values()].reduce((a, b) => a + b, 0), np = [...p.values()].reduce((a, b) => a + b, 0);
    if (nr === 0) return np === 0 ? 1 : 0;
    if (np === 0) return 0;
    let ov = 0; for (const [w, c] of p) ov += Math.min(c, r.get(w) ?? 0);
    return ov === 0 ? 0 : (2 * (ov / np) * (ov / nr)) / (ov / np + ov / nr);
  };
  const all: number[] = [];
  for (const f of readdirSync(`${bev}/ground-truth`).filter((x) => x.endsWith('.jsonl')).sort()) {
    const ds = f.slice(0, -6);
    const scores = readFileSync(`${bev}/ground-truth/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => {
      const g = JSON.parse(l);
      return f1(extract(decode(readFileSync(`${bev}/html/${ds}/${g.page_id}.html`)), 'https://example.com/'), g.plaintext ?? '');
    });
    all.push(...scores);
    console.log(JSON.stringify({ dataset: ds, pages: scores.length, f1: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3) }));
  }
  console.log(JSON.stringify({ dataset: 'all', pages: all.length, f1: +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3) }));
  process.exit(0);
}

const predictions: Record<string, string> = {};
for (const f of readdirSync(`${dir}/ground-truth`).filter((x) => x.endsWith('.json')).sort()) {
  const id = f.slice(0, -5);
  const gt = JSON.parse(readFileSync(`${dir}/ground-truth/${f}`, 'utf8'));
  const html = decode(gunzipSync(readFileSync(`${dir}/html/${id}.html.gz`)));
  predictions[id] = extract(html, gt.url || 'https://example.com/');
}
writeFileSync(out, JSON.stringify(predictions));
console.log(JSON.stringify({ pages: Object.keys(predictions).length, out }));
