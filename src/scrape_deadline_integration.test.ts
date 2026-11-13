import { expect, spyOn, test } from 'bun:test';
import * as yahoo from './services/yahoo.js';
import { integratedSearch } from './scraper.js';

// 締切が発動したら、補充取得だけでなく adaptiveScrape の追加取得も待たない（待ち時間の上限を守る）
test('scrapeDeadlineMs also stops adaptive extra waves once the deadline fired', async () => {
  const page = (title: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${'本文の段落です。'.repeat(40)}</p></main></body></html>`;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/slow')) await new Promise((r) => setTimeout(r, 4000));
    return new Response(page(path), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }});
  const base = `http://127.0.0.1:${server.port}`;
  const items = ['/fast1', '/fast2', '/slow1', '/slow2', '/slow3'].map((p) => ({ title: p, url: base + p, snippet: `${p} snippet` }));
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items, count: items.length } as any);
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockResolvedValue({ items: [] } as any);
  const previous = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    const started = Date.now();
    const result = await integratedSearch({ tenantId: 'legacy', query: '存在しない語ほげ 料金', limit: 3, includeRealtime: false, noCache: true, scrapeDeadlineMs: 1500, adaptiveScrape: true, scrapeBudget: 5 });
    const elapsed = Date.now() - started;
    expect(result.results.some((r: any) => r.deadlineExceeded)).toBe(true);
    expect(result.results.some((r: any) => r.selectionReason === 'scrape_refill')).toBe(false);
    expect(elapsed).toBeLessThan(3500);
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
    if (previous === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previous;
    server.stop(true);
  }
}, 30000);

// 本文もハイライトも要求されていないとき（formats に markdown なし・検索語が URL だけでハイライトを選ぶ語が無い）は、
// 判定材料が無いので contextSufficiency を付けない（誤って insufficient と出さない）
test('contextSufficiency is omitted when neither markdown nor highlights were requested', async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(`<html><head><title>t</title></head><body><main><h1>会場案内</h1><p>${'駐車場の料金は 1,000円です。'.repeat(20)}</p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }});
  const items = ['/a', '/b', '/c'].map((p) => ({ title: p, url: `http://127.0.0.1:${server.port}${p}`, snippet: `${p}` }));
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items, count: items.length } as any);
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockResolvedValue({ items: [] } as any);
  const previous = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    const htmlOnly = await integratedSearch({ tenantId: 'legacy', query: `http://127.0.0.1:${server.port}/a`, limit: 3, includeRealtime: false, noCache: true, formats: ['html'] });
    expect(htmlOnly.count).toBe(1);
    expect(htmlOnly.contextSufficiency).toBeUndefined();
    const normal = await integratedSearch({ tenantId: 'legacy', query: '駐車場 料金', limit: 3, includeRealtime: false, noCache: true });
    expect(normal.contextSufficiency?.level).toBe('no_gap_detected');
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
    if (previous === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previous;
    server.stop(true);
  }
}, 30000);
