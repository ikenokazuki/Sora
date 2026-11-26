import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { closeSharedBrowser, resolveChromiumPath } from './browser_engine.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import * as cache from './cache.js';
import * as db from './db.js';
import { scrapeUrl } from './scraper.js';
import { waitFor } from './test_fixtures/wait.js';

// ブラウザで開いたページの localStorage は、利用者ごとに保存して、次に開くときに戻す。戻すのは保存したオリジン（http・https とホストとポート）の
// 文書だけで、別のオリジンの iframe や転送先には入れない。転送先のページの値で、元のオリジンの保存分を書き換えない（本物の Chromium と手元のサーバー）
const filler = `<p>${'保存の確認のための本文の段落です。'.repeat(20)}</p>`;
/** 読み込みのときに、自分の localStorage の token を知らせる。そのあとの script を足せる */
const reporting = (who: string, after = '') => `<!doctype html><html><head><title>${who}</title></head><body><main>${filler}</main><script>fetch('/report?who=${who}&v=' + encodeURIComponent(localStorage.getItem('token') ?? 'none'));${after}</script></body></html>`;
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe.skipIf(!resolveChromiumPath())('保存した localStorage は、保存したオリジンにだけ戻し、そのオリジンの値だけを保存する', () => {
  let siteA: ReturnType<typeof Bun.serve>;
  let siteB: ReturnType<typeof Bun.serve>;
  const reports: Array<{ origin: 'A' | 'B'; who: string; v: string }> = [];
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  const originA = () => `http://127.0.0.1:${siteA.port}`;
  /** B は、別のホスト名（localhost）でも、A と同じホスト名の別のポート（127.0.0.1）でも開ける */
  const originB = (host = 'localhost') => `http://${host}:${siteB.port}`;
  const record = (origin: 'A' | 'B', req: Request) => {
    const u = new URL(req.url);
    reports.push({ origin, who: u.searchParams.get('who') ?? '', v: u.searchParams.get('v') ?? '' });
    return new Response('ok');
  };
  let n = 0;
  const open = async (tenantId: string, url: string) => {
    await scrapeUrl({ tenantId, url: `${url}${url.includes('?') ? '&' : '?'}n=${++n}`, mode: 'browser', noCache: true, timeoutMs: 8000 });
  };
  const seen = async (origin: 'A' | 'B', who: string): Promise<string[]> => {
    await waitFor(() => reports.some((r) => r.origin === origin && r.who === who));
    return reports.filter((r) => r.origin === origin && r.who === who).map((r) => r.v);
  };

  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    siteB = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/report') return record('B', req);
      if (path === '/frame') return html(reporting('frame'));
      if (path === '/evil') return html(reporting('evil', `localStorage.setItem('token', 'EVIL')`));
      // 保存するときの確認を、ページの側から偽る（window.origin の置き換えと、値の変換の差し込み）
      if (path === '/spoof') return html(reporting('spoof', `localStorage.setItem('token', 'EVIL'); window.origin = ${JSON.stringify(originA())}; Object.prototype.toJSON = function () { return { origin: ${JSON.stringify(originA())}, items: { token: 'EVIL' } }; };`));
      // 返り値を、結果を待つ処理に then を呼ばせて差し替える（保存のための値だけ）
      if (path === '/thenable') return html(reporting('thenable', `localStorage.setItem('token', 'EVIL'); Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { if (!this || !this.items || !this.origin) return undefined; return (resolve) => resolve(Object.assign(Object.create(null), { origin: ${JSON.stringify(originA())}, items: { token: 'EVIL' } })); } });`));
      if (path === '/top') return html(reporting('top'));
      return new Response('', { status: 404 });
    } });
    siteA = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/report') return record('A', req);
      if (path === '/set') return html(reporting('set', `localStorage.setItem('token', 'A-SECRET')`));
      if (path === '/with-frame') return html(reporting('with-frame').replace('<main>', `<main><iframe src="${originB()}/frame"></iframe>`));
      if (path === '/to-frame') return new Response(null, { status: 302, headers: { location: `${originB()}/frame` } });
      if (path === '/to-evil') return new Response(null, { status: 302, headers: { location: `${originB()}/evil` } });
      if (path === '/to-spoof') return new Response(null, { status: 302, headers: { location: `${originB()}/spoof` } });
      if (path === '/to-thenable') return new Response(null, { status: 302, headers: { location: `${originB()}/thenable` } });
      if (path === '/check') return html(reporting('check'));
      return new Response('', { status: 404 });
    } });
  });
  beforeEach(() => {
    reports.length = 0;
    cache.clearCache();
  });
  afterAll(async () => {
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
    await closeSharedBrowser();
    siteA.stop(true);
    siteB.stop(true);
  });

  test('同じオリジンには戻し、別のオリジンの iframe には入れない', async () => {
    const tenant = 'name:storage-frame';
    await open(tenant, `${originA()}/set`);
    await open(tenant, `${originA()}/with-frame`);
    expect(await seen('A', 'with-frame')).toEqual(['A-SECRET']);
    expect(await seen('B', 'frame')).toEqual(['none']);
  }, 60_000);

  test('別のオリジンへの転送先には入れない', async () => {
    const tenant = 'name:storage-redirect';
    await open(tenant, `${originA()}/set`);
    await open(tenant, `${originA()}/to-frame`);
    expect(await seen('B', 'frame')).toEqual(['none']);
  }, 60_000);

  test('同じホスト名の別のポート（別のオリジン）には入れない', async () => {
    const tenant = 'name:storage-port';
    await open(tenant, `${originA()}/set`);
    await open(tenant, `${originB('127.0.0.1')}/top`);
    expect(await seen('B', 'top')).toEqual(['none']);
  }, 60_000);

  for (const path of ['to-evil', 'to-spoof', 'to-thenable']) {
    test(`転送先のページの値で、元のオリジンの保存分を書き換えない（${path}）`, async () => {
      const tenant = `name:storage-write-${path}`;
      await open(tenant, `${originA()}/set`);
      await open(tenant, `${originA()}/${path}`);
      await open(tenant, `${originA()}/check`);
      expect(await seen('A', 'check')).toEqual(['A-SECRET']);
    }, 60_000);
  }
});

// ブラウザの知る URL と、値を読んだ文書がずれた場合（確かめる間にページが移った）。ブラウザは起動せず、偽のページで順番を作る
describe('値を読んだ文書のオリジンも確かめる', () => {
  for (const [name, readFrom, saved] of [['同じオリジンの文書なら保存する', 'http://a.example.invalid', 1], ['別のオリジンの文書の値は保存しない', 'http://b.example.invalid', 0]] as const) {
    test(name, async () => {
      const page = new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : prop === 'url' ? () => 'http://a.example.invalid/' : prop === 'evaluate' ? async () => ({ origin: readFrom, items: { token: 'x' } }) : async () => '') });
      const spies = [
        spyOn(engine, 'resolveChromiumPath').mockReturnValue('/test/chromium'),
        spyOn(engine, 'getBrowser').mockResolvedValue({ browser: { createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }) }, isDedicated: false } as never),
        spyOn(db, 'dbSaveTenantStorage'),
      ];
      try {
        await fetchWithStealthBrowser('http://a.example.invalid/', 1000, undefined, undefined, 'networkidle2', false, true, 'name:storage-fake');
        expect(spies[2]).toHaveBeenCalledTimes(saved);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }, 20_000);
  }
});
