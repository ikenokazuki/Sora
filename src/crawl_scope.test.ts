import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { crawlSiteUrl, isHostInSites } from './scraper.js';
import { app } from './index.js';

// crawl_site / POST /crawl の対象範囲（include / exclude / ホスト）と、/map・/crawl のエラー応答。
// 以前は excludePatterns の条件が逆で 0 ページになり、includePatterns は起点 URL にも適用され、
// 起点がリダイレクトされると別ホストのリンクをたどれなかった。

let prevAllow: string | undefined;

beforeAll(() => {
  prevAllow = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
});

afterAll(() => {
  if (prevAllow !== undefined) process.env.ALLOW_LOCAL_FETCH = prevAllow;
  else delete process.env.ALLOW_LOCAL_FETCH;
});

const body = (title: string, links: string[]) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>`
  + `<p>${(title + ' page body text that is long enough to be treated as real content. ').repeat(8)}</p>`
  + links.map((l) => `<a href="${l}">${l}</a>`).join(' ')
  + '</main></body></html>';

const SITE: Record<string, string> = {
  '/': body('Home', ['/docs/a', '/tag/x', '/docs/b', '/about']),
  '/docs/a': body('Docs A', ['/docs/c']),
  '/docs/b': body('Docs B', []),
  '/docs/c': body('Docs C', []),
  '/tag/x': body('Tag X', []),
  '/about': body('About', []),
};

/** Host が 127.0.0.2 のときは 127.0.0.1 へ 301（apex → www のような「別ホストへの転送」を再現する）。 */
function startSite(opts: { redirectFromAlias?: boolean; delayMs?: number } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get('host') ?? '';
      if (opts.redirectFromAlias && host.startsWith('127.0.0.2')) {
        return Response.redirect(`http://127.0.0.1:${server.port}${url.pathname}`, 301);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const html = SITE[url.pathname];
        if (!html) return new Response('not found', { status: 404 });
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      } finally {
        inFlight--;
      }
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}`, maxInFlight: () => maxInFlight };
}

const paths = (r: { pages: Array<{ url: string }> }) => r.pages.map((p) => new URL(p.url).pathname);

describe('crawlSiteUrl: include / exclude パターン', () => {
  test('パターン指定なしは同一サイトを幅優先でたどる', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 10, maxDepth: 2, noCache: true });
      expect(paths(r)).toEqual(['/', '/docs/a', '/tag/x', '/docs/b', '/about', '/docs/c']);
    } finally {
      server.stop(true);
    }
  });

  test('excludePatterns に一致する URL だけを除き、他は取得する', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 10, maxDepth: 2, excludePatterns: ['/tag/**'], noCache: true });
      expect(paths(r)).toEqual(['/', '/docs/a', '/docs/b', '/about', '/docs/c']);
    } finally {
      server.stop(true);
    }
  });

  test('includePatterns は発見したリンクにだけ適用し、起点 URL は常に取得する', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 10, maxDepth: 2, includePatterns: ['/docs/**'], noCache: true });
      expect(paths(r)).toEqual(['/', '/docs/a', '/docs/b', '/docs/c']);
    } finally {
      server.stop(true);
    }
  });

  test('include と exclude の併用', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({
        url: base + '/', maxPages: 10, maxDepth: 2,
        includePatterns: ['/docs/**'], excludePatterns: ['/docs/b'], noCache: true,
      });
      expect(paths(r)).toEqual(['/', '/docs/a', '/docs/c']);
    } finally {
      server.stop(true);
    }
  });

  test('起点 URL が excludePatterns に一致しても取得する（明示された URL なので）', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 10, maxDepth: 1, excludePatterns: ['/', '/about'], noCache: true });
      expect(paths(r)).toContain('/');
      expect(paths(r)).not.toContain('/about');
    } finally {
      server.stop(true);
    }
  });
});

describe('crawlSiteUrl: ホストの扱い', () => {
  test('起点が別ホストへリダイレクトされても、転送先のリンクをたどる', async () => {
    const { server, base } = startSite({ redirectFromAlias: true });
    try {
      const aliasUrl = `http://127.0.0.2:${server.port}/`;
      const r = await crawlSiteUrl({ url: aliasUrl, maxPages: 10, maxDepth: 2, noCache: true });
      expect(paths(r)).toEqual(['/', '/docs/a', '/tag/x', '/docs/b', '/about', '/docs/c']);
      expect(new URL(r.pages[0].url).host).toBe(new URL(base).host);
    } finally {
      server.stop(true);
    }
  });

  test('isHostInSites: www の有無は同一サイト、サブドメイン指定はドット区切りで比較する', () => {
    const sites = new Set(['example.com']);
    expect(isHostInSites('example.com', sites)).toBe(true);
    expect(isHostInSites('www.example.com', sites)).toBe(true);
    expect(isHostInSites('docs.example.com', sites)).toBe(false);
    expect(isHostInSites('docs.example.com', sites, true)).toBe(true);
    expect(isHostInSites('www.example.com', sites, true)).toBe(true);
    expect(isHostInSites('evilexample.com', sites, true)).toBe(false);
    expect(isHostInSites('notexample.com', sites)).toBe(false);
    expect(isHostInSites('example.com.evil.net', sites, true)).toBe(false);
  });
});

describe('crawlSiteUrl: 件数・並行度・失敗の扱い', () => {
  test('maxPages を超えず、並行取得でも幅優先の順序を保つ', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 3, maxDepth: 2, concurrency: 3, noCache: true });
      expect(paths(r)).toEqual(['/', '/docs/a', '/tag/x']);
      expect(r.count).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test('concurrency を指定した件数まで並行に取得する（1 なら逐次）', async () => {
    const parallel = startSite({ delayMs: 300 });
    try {
      await crawlSiteUrl({ url: parallel.base + '/', maxPages: 5, maxDepth: 1, concurrency: 3, noCache: true });
      expect(parallel.maxInFlight()).toBeGreaterThanOrEqual(2);
      expect(parallel.maxInFlight()).toBeLessThanOrEqual(3);
    } finally {
      parallel.server.stop(true);
    }
    const sequential = startSite({ delayMs: 50 });
    try {
      await crawlSiteUrl({ url: sequential.base + '/', maxPages: 4, maxDepth: 1, concurrency: 1, noCache: true });
      expect(sequential.maxInFlight()).toBe(1);
    } finally {
      sequential.server.stop(true);
    }
  });

  test('起点そのものが取得できなければ、0 件の成功ではなくエラーを伝える', async () => {
    const prev = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'false';
    try {
      await expect(crawlSiteUrl({ url: 'http://127.0.0.1:9/', maxPages: 3, noCache: true })).rejects.toThrow(/遮断/);
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prev;
    }
  });

  test('起点以外のページの失敗は握りつぶして、取得できたページを返す', async () => {
    const { server, base } = startSite();
    try {
      const withBroken = body('Home', ['/missing', '/about']);
      SITE['/'] = withBroken;
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 5, maxDepth: 1, noCache: true });
      expect(paths(r)).toContain('/');
      expect(paths(r)).toContain('/about');
    } finally {
      SITE['/'] = body('Home', ['/docs/a', '/tag/x', '/docs/b', '/about']);
      server.stop(true);
    }
  });
});

describe('REST: /map・/crawl・/crawl/stream の入力エラーと遮断の応答', () => {
  const post = (path: string, payload: unknown, raw = false) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(payload) : JSON.stringify(payload) });

  for (const path of ['/map', '/crawl', '/crawl/stream']) {
    test(`${path}: 不正な JSON は 400 INVALID_JSON`, async () => {
      const res = await post(path, '{not json', true);
      expect(res.status).toBe(400);
      expect((await res.json() as any).code).toBe('INVALID_JSON');
    });

    test(`${path}: url が無い・URL として読めない・http(s) 以外は 400 INVALID_INPUT`, async () => {
      for (const payload of [{}, { url: 'not a url' }, { url: 'ftp://example.com/' }, { url: 123 }]) {
        const res = await post(path, payload);
        expect(res.status).toBe(400);
        expect((await res.json() as any).code).toBe('INVALID_INPUT');
      }
    });
  }

  test('/map: 内部アドレスは 403 SSRF_BLOCKED', async () => {
    const prev = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'false';
    try {
      const res = await post('/map', { url: 'http://127.0.0.1/', noCache: true });
      expect(res.status).toBe(403);
      const json = (await res.json()) as any;
      expect(json.code).toBe('SSRF_BLOCKED');
      expect(json.retryable).toBe(false);
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prev;
    }
  });

  test('/crawl: 内部アドレスは 200 の空結果ではなく 403 SSRF_BLOCKED', async () => {
    const prev = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'false';
    try {
      const res = await post('/crawl', { url: 'http://127.0.0.1/', noCache: true });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).code).toBe('SSRF_BLOCKED');
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prev;
    }
  });

  test('/crawl/stream: 失敗は黙って閉じず error イベントで知らせる', async () => {
    const prev = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'false';
    try {
      const res = await post('/crawl/stream', { url: 'http://127.0.0.1/', noCache: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('event: error');
      expect(text).toContain('SSRF_BLOCKED');
      expect(text).not.toContain('event: done');
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prev;
    }
  });

  test('/crawl: excludePatterns が REST 経由でも効く', async () => {
    const { server, base } = startSite();
    try {
      const res = await post('/crawl', { url: base + '/', maxPages: 10, maxDepth: 2, excludePatterns: ['/tag/**'], noCache: true });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.pages.map((p: any) => new URL(p.url).pathname)).not.toContain('/tag/x');
      expect(json.count).toBe(5);
    } finally {
      server.stop(true);
    }
  });
});
