// X Realtime 固有名詞判定の評価（v2.36.0）。
// 既定はオフライン: 保存済みの Web タイトルと X 総ヒット数で判定精度を確かめる（ネットワーク不使用）。
// --live で Yahoo に問い合わせ、判定あり／なしの件数・関連件数・実行クエリ数・所要時間を比べる。
// 規律: クエリは逐次実行し、間隔を空け、件数を絞る（既定 6 クエリ × 2 通り）。
// Usage: bun scripts/eval-realtime-anchor.ts [--live] [--split dev|held] [--limit 6] [--delay-ms 3000]
//        [--out eval/results/realtime-anchor-<ts>.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRealtimeAnchor, postMentions } from '../src/retrieval/realtime_anchor.js';
import { createWebAnchorHints, searchYahooRealtime } from '../src/services/yahoo.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const live = args.includes('--live');
const split = arg('--split');
const limit = Math.max(1, parseInt(arg('--limit') ?? '', 10) || 6);
const delayMs = Math.max(1000, parseInt(arg('--delay-ms') ?? '', 10) || 3000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(join(here, '../eval/realtime_anchor_cases.json'), 'utf8'));
const rows = data.cases
  .filter((c: any) => !split || c.split === split)
  .flatMap((c: any) => c.queries.map((q: any) => ({ ...q, split: c.split, anchors: c.anchors, relevant: c.relevant })));

if (!live) {
  // 設計時の評価（dev 24/28・held 24/24）を下回れば失敗にする
  const floor: Record<string, number> = { dev: 24, held: 24 };
  const bySplit: Record<string, { ok: number; n: number; wrong: string[] }> = {};
  for (const r of rows) {
    const s = (bySplit[r.split] ??= { ok: 0, n: 0, wrong: [] });
    const anchor = detectRealtimeAnchor(r.terms, r.webTitles, r.totals);
    s.n++;
    if (anchor && r.anchors.includes(anchor)) s.ok++;
    else s.wrong.push(`${r.terms.join(' ')} → ${anchor ?? '(判定なし)'}`);
  }
  let failed = false;
  for (const [name, s] of Object.entries(bySplit)) {
    console.log(`${name}: ${s.ok}/${s.n}${s.wrong.length ? `  誤判定: ${s.wrong.join(' / ')}` : ''}`);
    if (s.ok < (floor[name] ?? 0)) {
      console.error(`${name} の判定精度が基準 ${floor[name]} を下回りました`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

const out: any[] = [];
for (const r of rows.slice(0, limit)) {
  const query = r.terms.join(' ');
  const row: any = { split: r.split, query };
  for (const mode of ['off', 'on'] as const) {
    const t0 = Date.now();
    try {
      const res: any = await searchYahooRealtime({
        query,
        detailEnrichment: false,
        ...(mode === 'on' ? { anchorHints: createWebAnchorHints(query) } : {}),
      });
      row[mode] = {
        ms: Date.now() - t0,
        count: res.count,
        relevant: res.items.filter((i: any) => postMentions(i, r.relevant)).length,
        queries: res.retrievalQueries.length,
        ...(res.anchorTerm ? { anchorTerm: res.anchorTerm } : {}),
        ...(res.aliasTerms ? { aliasTerms: res.aliasTerms } : {}),
        ...(res.anchorFiltered !== undefined ? { anchorFiltered: res.anchorFiltered } : {}),
        missingTerms: res.missingTerms,
      };
    } catch (e: any) {
      row[mode] = { error: String(e?.message || e).slice(0, 200) };
    }
    await sleep(delayMs);
  }
  console.log(JSON.stringify(row));
  out.push(row);
}

const summary = Object.fromEntries((['off', 'on'] as const).map((mode) => {
  const ok = out.map((r) => r[mode]).filter((m) => m && !m.error);
  const sum = (k: string) => ok.reduce((n, m) => n + (m[k] ?? 0), 0);
  const count = sum('count');
  return [mode, {
    queries: ok.length,
    posts: count,
    relevant: sum('relevant'),
    relevantRatio: count ? Number((sum('relevant') / count).toFixed(3)) : 0,
    retrievalQueries: sum('queries'),
    meanMs: ok.length ? Math.round(sum('ms') / ok.length) : 0,
  }];
}));
console.log(JSON.stringify(summary, null, 2));
const outPath = arg('--out') ?? join(here, `../eval/results/realtime-anchor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), split: split ?? 'all', rows: out, summary }, null, 2));
console.log(`saved: ${outPath}`);
process.exit(0);
