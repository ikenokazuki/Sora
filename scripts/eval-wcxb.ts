// 本文の取り出し（convertHtmlToMarkdown）を WCXB（Web Content Extraction Benchmark、CC BY 4.0）で測る。
// docs/evaluations/main-content/results.md。ここでは予測の JSON（{file_id: 本文}）を作り、採点は WCXB の evaluate.py で行う。
//   git clone --depth 1 https://github.com/Murrough-Foley/web-content-extraction-benchmark data/wcxb
//   bun scripts/eval-wcxb.ts --data data/wcxb --split test --out data/wcxb-sora-test.json
//   python3 -I data/wcxb/evaluate.py --split test --results data/wcxb-sora-test.json --per-type
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

const predictions: Record<string, string> = {};
for (const f of readdirSync(`${dir}/ground-truth`).filter((x) => x.endsWith('.json')).sort()) {
  const id = f.slice(0, -5);
  const gt = JSON.parse(readFileSync(`${dir}/ground-truth/${f}`, 'utf8'));
  const html = decode(gunzipSync(readFileSync(`${dir}/html/${id}.html.gz`)));
  try { predictions[id] = toText(convertHtmlToMarkdown(html, gt.url || 'https://example.com/', 10_000_000, false, true).markdown); } catch { predictions[id] = ''; }
}
writeFileSync(out, JSON.stringify(predictions));
console.log(JSON.stringify({ pages: Object.keys(predictions).length, out }));
