import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { closeSharedBrowser } from './browser_engine.js';
import { formatIntegratedSearchHostResponse } from './integrated_search_host_response.js';
import { integratedSearch } from './scraper.js';
import * as yahoo from './services/yahoo.js';

// maxChars で本文が切れたページの答えが、search_deep の evidence の応答に残る。ページ・検索結果はすべてテスト用の作り物。
// 答えは本文の切れたところより後ろの、巨大な表の節にある。ハイライトは全文から選ぶが maxChars に収まり、
// 本文が切れた結果では、evidence は本文でなくハイライトを返す（adaptiveScrape の追加取得で足した結果も）
afterAll(closeSharedBrowser);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const page = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const rows = Array.from({ length: 3000 }, (_, i) => `<tr><td>${i === 0 ? '開場時間' : `項目${i}`}</td><td>${i === 0 ? '17:00' : `料金 ${i} 円`}</td></tr>`).join('');
const pages: Record<string, string> = {
  '/long': page('公演案内', `${'<p>公演の前書きです。関係のない文が続きます。</p>'.repeat(120)}<h2>料金表</h2><table><tr><th>項目</th><th>内容</th></tr>${rows}</table>`),
  '/short': page('お知らせ', `<p>${'お知らせの文です。'.repeat(30)}</p>`),
};

async function search(paths: string[], extra: Record<string, unknown>) {
  const previous = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
  const server = Bun.serve({ port: 0, fetch: (req) => new Response(pages[new URL(req.url).pathname], { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
  const items = paths.map((p) => ({ title: p, url: `http://127.0.0.1:${server.port}${p}`, snippet: p, source: 'web' }));
  const spies = [
    spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items, count: items.length } as never),
    spyOn(yahoo, 'searchYahooRealtime').mockResolvedValue({ items: [] } as never),
  ];
  cleanups.push(() => {
    for (const spy of spies) spy.mockRestore();
    server.stop(true);
    if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = previous;
  });
  return integratedSearch({ query: '開場時間 料金', limit: 1, maxChars: 2000, includeRealtime: false, noCache: true, ...extra });
}

test.each([
  ['最初に読んだページ', ['/long'], {}],
  ['adaptiveScrape の追加取得で足したページ', ['/short', '/long'], { adaptiveScrape: true, scrapeBudget: 2 }],
] as const)('%s: 本文が切れても、evidence の応答に答え（表の先頭の行）が残る', async (_name, paths, extra) => {
  const result = await search([...paths], extra);
  const item = result.results.find((r: any) => String(r.url).endsWith('/long'));
  expect(item?.isTruncated).toBe(true);
  expect(item?.markdown.length).toBeLessThanOrEqual(2000);
  expect(item?.markdown).not.toContain('17:00');
  expect(item?.highlights.join('').length).toBeLessThanOrEqual(2000);

  const evidence = formatIntegratedSearchHostResponse(result, { responseMode: 'evidence' });
  const out = evidence.results.find((r: any) => String(r.url).endsWith('/long'));
  expect(out.markdown).toBeUndefined();
  expect(out.highlights.join('\n')).toContain('17:00');
}, 30_000);
