import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, resolveChromiumPath } from './browser_engine.js';
import { dbGetTenantCookies, dbGetTenantStorage, dbSaveTenantCookies, dbSaveTenantStorage } from './db.js';
import { scrapeUrl } from './scraper.js';

// ブラウザは、開いたページの Cookie と localStorage をサイトごとに保存し、次に開くときに戻す。
// エラーの画面から保存した札（TikTok の WAF の Cookie など）を戻し続けて、毎回 403 になっていた（2026-10-26、本番）。
afterAll(closeSharedBrowser);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function serve(handler: (req: Request) => Response): string {
  const previous = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
  const server = Bun.serve({ port: 0, fetch: handler });
  cleanups.push(() => {
    server.stop(true);
    if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = previous;
  });
  return `http://127.0.0.1:${server.port}`;
}

const page = (body: string) => `<html><head><title>テストのページ</title></head><body><main><h1>テストのページ</h1><p>${body}</p></main></body></html>`;

describe.skipIf(!resolveChromiumPath())('stored cookies and error pages', () => {
  test('a page that fails with the stored cookies is opened again without them, and the stale cookies are dropped', async () => {
    let requests = 0;
    const base = serve((req) => {
      if (new URL(req.url).pathname !== '/video') return new Response('', { status: 404 }); // favicon など
      requests++;
      const blocked = (req.headers.get('cookie') ?? '').includes('waf=blocked');
      return blocked
        ? new Response(page('You don\'t have authorization to view this page.'), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : new Response(page(`${'本文の段落です。'.repeat(20)}`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    dbSaveTenantCookies('legacy', '127.0.0.1', [{ name: 'waf', value: 'blocked', domain: '127.0.0.1', path: '/' }]);
    dbSaveTenantStorage('legacy', '127.0.0.1', { waf_state: 'blocked' });
    const r = await scrapeUrl({ url: `${base}/video`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect(r.contentStatus).toBe('body');
    expect(r.content).toContain('本文の段落です');
    expect(requests).toBe(2);
    expect((dbGetTenantCookies('legacy', '127.0.0.1') ?? []).map((c) => c.name)).not.toContain('waf');
    expect(dbGetTenantStorage('legacy', '127.0.0.1')?.waf_state).toBeUndefined();
  }, 30000);

  // TikTok は確認の画面（"Please wait..."、HTTP 200）も返す。その画面の札を戻すと、毎回確認の画面になった（2026-10-26、本番）
  const challenge = page('Please wait...').replace(/<p>.*<\/p>/, '<p>Please wait...</p>').replace('<h1>テストのページ</h1>', '');

  test('a page still on a challenge with the stored cookies is opened again without them', async () => {
    let requests = 0;
    const base = serve((req) => {
      if (new URL(req.url).pathname !== '/challenged') return new Response('', { status: 404 }); // favicon など
      requests++;
      const pending = (req.headers.get('cookie') ?? '').includes('chal=pending');
      return new Response(pending ? challenge : page(`${'本文の段落です。'.repeat(20)}`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    dbSaveTenantCookies('legacy', '127.0.0.1', [{ name: 'chal', value: 'pending', domain: '127.0.0.1', path: '/' }]);
    const r = await scrapeUrl({ url: `${base}/challenged`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect(r.content).toContain('本文の段落です');
    expect(requests).toBe(2);
    expect((dbGetTenantCookies('legacy', '127.0.0.1') ?? []).map((c) => c.name)).not.toContain('chal');
  }, 30000);

  test('the cookies a challenge page sets are not stored', async () => {
    const base = serve(() => new Response(challenge, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'chal_token=pending; Path=/' } }));
    await scrapeUrl({ url: `${base}/always-challenged`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect((dbGetTenantCookies('legacy', '127.0.0.1') ?? []).map((c) => c.name)).not.toContain('chal_token');
  }, 30000);

  test('the cookies an error page sets are not stored', async () => {
    const base = serve(() => new Response(page('Forbidden'), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'waf_token=bad; Path=/' } }));
    const r = await scrapeUrl({ url: `${base}/blocked`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect((dbGetTenantCookies('legacy', '127.0.0.1') ?? []).map((c) => c.name)).not.toContain('waf_token');
  }, 30000);
});
