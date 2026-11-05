import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import { crawlSiteUrl, mapSiteUrl } from './scraper.js';

// map_site の limit と日付の順、crawl_site の整形、/crawl・/crawl/stream の検査と webhook、scrape_batch の webhookUrl（手元のサーバーだけ。外へは出ない）

let prevAllow: string | undefined;
beforeAll(() => {
  prevAllow = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
});
afterAll(() => {
  if (prevAllow !== undefined) process.env.ALLOW_LOCAL_FETCH = prevAllow;
  else delete process.env.ALLOW_LOCAL_FETCH;
});

const page = (title: string, links: string[]) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>`
  + `<p>${(title + ' page body text that is long enough to be treated as real content. ').repeat(8)}</p>`
  + links.map((l) => `<a href="${l}">${l}</a>`).join(' ')
  + '</main></body></html>';

/** 古い 2 件 → 新しい 2 件の順に並んだ sitemap.xml と、ページ数枚のサイト（robots.txt は無い） */
function startSite(opts: { sitemap?: boolean; depth?: number } = {}) {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      const base = `http://127.0.0.1:${server.port}`;
      if (path === '/sitemap.xml' && opts.sitemap) {
        const entries = [['old1', '2026-01-01'], ['old2', '2026-02-01'], ['new1', '2026-09-01'], ['new2', '2026-10-01']];
        const urls = entries.map(([n, d]) => `<url><loc>${base}/${n}</loc><lastmod>${d}</lastmod></url>`).join('');
        return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { 'content-type': 'application/xml' } });
      }
      if (path === '/') return new Response(page('Home', ['/a', '/b']), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      // /chain/N は N+1 へだけリンクする（maxDepth の上限の確認用）
      const chain = path.match(/^\/chain\/(\d+)$/);
      if (chain) {
        const n = Number(chain[1]);
        const next = n < (opts.depth ?? 9) ? [`/chain/${n + 1}`] : [];
        return new Response(page(`Chain ${n}`, next), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (path === '/a' || path === '/b') return new Response(page(path.slice(1).toUpperCase(), []), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('not found', { status: 404 });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

/** webhook の受け口。届いた本文を貯める */
function startReceiver() {
  const received: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      received.push(await req.json());
      return new Response('ok');
    },
  });
  const waitFor = async (n = 1, ms = 3000) => {
    const end = Date.now() + ms;
    while (received.length < n && Date.now() < end) await Bun.sleep(20);
    return received;
  };
  return { server, url: `http://127.0.0.1:${server.port}/hook`, received, waitFor };
}

const post = (path: string, payload: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('map_site: 日付で絞ってから件数で切る', () => {
  test('limit 2 と since を一緒に指定しても、新しい 2 件が残る', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const r = await mapSiteUrl({ url: base + '/', limit: 2, since: '2026-05-01', noCache: true });
      expect(r.source).toBe('sitemap');
      expect(r.links).toEqual([`${base}/new1`, `${base}/new2`]);
      expect(r.count).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('日付の絞り込みの後に残る件数が limit より多ければ、limit 件で切る（先頭から）', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const r = await mapSiteUrl({ url: base + '/', limit: 1, until: '2026-09-15', noCache: true });
      expect(r.links).toEqual([`${base}/old1`]);
      expect(r.count).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test('日付を指定しないときは、今までどおり limit 件', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const r = await mapSiteUrl({ url: base + '/', limit: 2, noCache: true });
      expect(r.links).toEqual([`${base}/old1`, `${base}/old2`]);
    } finally {
      server.stop(true);
    }
  });

  test('REST の /map も同じ', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const res = await post('/map', { url: base + '/', limit: 2, since: '2026-05-01', noCache: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).links).toEqual([`${base}/new1`, `${base}/new2`]);
    } finally {
      server.stop(true);
    }
  });

  test('キャッシュ: 古い版の結果（件数で先に切った 0 件）を、新しい版が引き継がない', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const key = `map:${base}/:2:false:2026-05-01:`;
      const { setToCache } = await import('./cache.js');
      setToCache(key, { url: base + '/', links: [], count: 0, source: 'sitemap' });
      const r = await mapSiteUrl({ url: base + '/', limit: 2, since: '2026-05-01' });
      expect(r.links).toEqual([`${base}/new1`, `${base}/new2`]);
    } finally {
      server.stop(true);
    }
  });
});

describe('crawl_site: pages は scrape と同じ整形（links は formats で求めたときだけ）', () => {
  const internal = ['quality', 'evidence', 'qualityReasons', 'missingFields', 'completeness', 'contentType', 'source', 'renderedWithBrowser', 'estimatedTokens'];

  test('既定の formats では links も内部の項目も付かない', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 3, maxDepth: 1, noCache: true });
      expect(r.pages.length).toBe(3);
      for (const p of r.pages) {
        expect(p.url).toBeString();
        expect(p.title).toBeString();
        expect(p.content).toBeString();
        expect(p.links).toBeUndefined();
        for (const k of internal) expect(p[k], k).toBeUndefined();
      }
    } finally {
      server.stop(true);
    }
  });

  test('formats に links を求めたときは links が付く（たどる動作は同じ）', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ url: base + '/', maxPages: 3, maxDepth: 1, formats: ['markdown', 'links'], noCache: true });
      expect(r.pages.length).toBe(3);
      expect(r.pages[0].links).toContain(`${base}/a`);
      for (const k of internal) expect(r.pages[0][k], k).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test('REST の /crawl と、/crawl/stream の page イベントも同じ整形', async () => {
    const { server, base } = startSite();
    try {
      const res = await post('/crawl', { url: base + '/', maxPages: 3, maxDepth: 1, noCache: true });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.pages[0].links).toBeUndefined();
      expect(json.pages[0].quality).toBeUndefined();

      const stream = await post('/crawl/stream', { url: base + '/', maxPages: 2, maxDepth: 1, noCache: true });
      const text = await stream.text();
      const events = [...text.matchAll(/event: page\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
      expect(events.length).toBe(2);
      for (const e of events) {
        expect(e.page.content).toBeString();
        expect(e.page.links).toBeUndefined();
        expect(e.page.quality).toBeUndefined();
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('/crawl・/crawl/stream: スキーマの範囲を 400 にする', () => {
  for (const path of ['/crawl', '/crawl/stream']) {
    test(`${path}: 範囲外（maxDepth 100・maxChars 50001・timeoutMs 120001・maxPages 51・concurrency 11）と不正な形は 400 INVALID_INPUT`, async () => {
      const { server, base } = startSite();
      try {
        for (const extra of [{ maxDepth: 100 }, { maxChars: 50_001 }, { timeoutMs: 120_001 }, { maxPages: 51 }, { concurrency: 11 }, { formats: ['bogus'] }, { webhookUrl: 'not a url' }, { maxDepth: 0 }]) {
          const res = await post(path, { url: base + '/', ...extra });
          expect(res.status, JSON.stringify(extra)).toBe(400);
          expect(((await res.json()) as any).code).toBe('INVALID_INPUT');
        }
      } finally {
        server.stop(true);
      }
    });
  }

  test('maxDepth 5 は通り、9 段のつながりも 6 ページ（起点 + 5 段）までで止まる', async () => {
    const { server, base } = startSite();
    try {
      const res = await post('/crawl', { url: base + '/chain/0', maxPages: 20, maxDepth: 5, noCache: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).count).toBe(6);
    } finally {
      server.stop(true);
    }
  });

  test('null の項目は未指定として扱う（必須の url が null なら 400）', async () => {
    const { server, base } = startSite();
    try {
      const ok = await post('/crawl', { url: base + '/', maxPages: 1, maxDepth: null, query: null, webhookUrl: null, noCache: true });
      expect(ok.status).toBe(200);
      const bad = await post('/crawl', { url: null });
      expect(bad.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe('webhook', () => {
  test('/crawl/stream も完了時に webhookUrl へ 1 回送る', async () => {
    const { server, base } = startSite();
    const receiver = startReceiver();
    try {
      const res = await post('/crawl/stream', { url: base + '/', maxPages: 2, maxDepth: 1, webhookUrl: receiver.url, noCache: true });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
      const got = await receiver.waitFor();
      expect(got.length).toBe(1);
      expect(got[0].event).toBe('scrape.completed');
      expect(got[0].data.count).toBe(2);
      expect(got[0].data.pages[0].url).toBe(base + '/');
      // 応答と同じ整形（内部の項目や links は付かない）
      expect(got[0].data.pages[0].quality).toBeUndefined();
      expect(got[0].data.pages[0].links).toBeUndefined();
    } finally {
      server.stop(true);
      receiver.server.stop(true);
    }
  });

  test('/crawl の webhookUrl は今までどおり 1 回届く', async () => {
    const { server, base } = startSite();
    const receiver = startReceiver();
    try {
      const res = await post('/crawl', { url: base + '/', maxPages: 2, maxDepth: 1, webhookUrl: receiver.url, noCache: true });
      expect(res.status).toBe(200);
      const got = await receiver.waitFor();
      expect(got.length).toBe(1);
      expect(got[0].data.count).toBe(2);
    } finally {
      server.stop(true);
      receiver.server.stop(true);
    }
  });
});

describe('scrape_batch: webhookUrl は URL の形を確かめる', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  test('REST の /scrape/batch は URL でない webhookUrl を 400 にする（取得もしない）', async () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls');
    restore.push(() => spy.mockRestore());
    const res = await post('/scrape/batch', { urls: ['https://example.com/'], webhookUrl: 'not a url' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.code).toBe('INVALID_INPUT');
    expect(json.error).toContain('webhookUrl');
    expect(spy).not.toHaveBeenCalled();
  });

  test('MCP の scrape_batch も URL でない webhookUrl を断る', async () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 0, successful: 0, failed: 0, results: [], errors: [] } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'crawl-map-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const bad = await client.callTool({ name: 'scrape_batch', arguments: { urls: ['https://example.com/'], webhookUrl: 'not a url' } }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect((bad as any).isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const ok = await client.callTool({ name: 'scrape_batch', arguments: { urls: ['https://example.com/'], webhookUrl: 'https://example.com/hook' } });
      expect((ok as any).isError).not.toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
