import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import * as browserStealth from './browser_stealth.js';
import * as scraper from './scraper.js';
import { crawlSiteUrl, mapSiteUrl } from './scraper.js';

// crawl_site の listOnly（mapSiteUrl・/map）の limit と日付の順、crawl_site の整形、/crawl・/crawl/stream の検査と webhook、scrape の urls（scrapeBatchUrls・/scrape/batch）の webhookUrl（手元のサーバーだけ。外へは出ない）

let prevAllow: string | undefined;
beforeAll(() => {
  prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
});
afterAll(() => {
  if (prevAllow !== undefined) process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
  else delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
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
  /** 最初の 1 件を待ったあと、少し待ってから返す（2 回目以降が遅れて届いても件数に出る） */
  const waitForOnly = async (settleMs = 500) => {
    await waitFor();
    await Bun.sleep(settleMs);
    return received;
  };
  return { server, url: `http://127.0.0.1:${server.port}/hook`, received, waitFor, waitForOnly };
}

const post = (path: string, payload: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('crawl_site の listOnly（mapSiteUrl）: 日付で絞ってから件数で切る', () => {
  test('limit 2 と since を一緒に指定しても、新しい 2 件が残る', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 2, since: '2026-05-01', noCache: true });
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
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 1, until: '2026-09-15', noCache: true });
      expect(r.links).toEqual([`${base}/old1`]);
      expect(r.count).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test('日付を指定しないときは、今までどおり limit 件', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 2, noCache: true });
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

  test('MCP の crawl_site の listOnly: true も同じ（応答は { url, links, count, source }）', async () => {
    const { server, base } = startSite({ sitemap: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'crawl-map-params', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      const out: any = await client.callTool({ name: 'crawl_site', arguments: { url: base + '/', listOnly: true, limit: 2, since: '2026-05-01' } });
      expect(out.isError).toBeFalsy();
      const json = JSON.parse(out.content[0].text);
      expect(json).toMatchObject({ url: base + '/', links: [`${base}/new1`, `${base}/new2`], count: 2, source: 'sitemap' });
    } finally {
      await client.close();
      await mcp.close();
      server.stop(true);
    }
  });

  test('キャッシュ: 古い版の結果（件数で先に切った 0 件）を、新しい版が引き継がない', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      const key = `map:${base}/:2:false:2026-05-01:`;
      const { setToCache } = await import('./cache.js');
      setToCache(key, { url: base + '/', links: [], count: 0, source: 'sitemap' });
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 2, since: '2026-05-01' });
      expect(r.links).toEqual([`${base}/new1`, `${base}/new2`]);
    } finally {
      server.stop(true);
    }
  });
});

describe('crawl_site の listOnly（mapSiteUrl）: サイトマップの読み方', () => {
  const xml = (body: string) => new Response(`<?xml version="1.0"?>${body}`, { headers: { 'content-type': 'application/xml' } });
  const urlset = (items: string) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;

  test('日付で絞るとき読むのは先頭 5,000 件まで（5,001 件目以降は、日付が合っても拾わない）', async () => {
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path !== '/sitemap.xml') return new Response('not found', { status: 404 });
        const base = `http://127.0.0.1:${server.port}`;
        // 0〜4998 番は古い、4999 番（5,000 件目）と 5000 番（5,001 件目）と 5001 番は新しい
        const items = Array.from({ length: 5002 }, (_, i) => `<url><loc>${base}/p${i}</loc><lastmod>${i < 4999 ? '2026-01-01' : '2026-10-01'}</lastmod></url>`).join('');
        return xml(urlset(items));
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 1000, since: '2026-05-01', noCache: true });
      expect(r.source).toBe('sitemap');
      expect(r.links).toEqual([`${base}/p4999`]);
      // 日付を指定しなければ、limit 件までを先頭から
      const plain = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit: 3, noCache: true });
      expect(plain.links).toEqual([`${base}/p0`, `${base}/p1`, `${base}/p2`]);
    } finally {
      server.stop(true);
    }
  });

  test('子のサイトマップは、先頭の 1 つだけを先に取り、まだ足りなければ残りを 3 つずつ並べて取る。並びと件数の上限は、1 つずつ取るときと同じ', async () => {
    // 子の応答は、同じ組（先頭の 1 つ、そのあとは 3 つずつ）の要求がそろうまで返さず、そろったら組の後ろの子から返す。時間に頼らず、
    // 同時に来た要求の数と順番で確かめる（組の大きさが違う作りは、応答を待ったまま止まり、テストの時間切れで落ちる）
    const group = (i: number) => (i === 0 ? 0 : 1 + Math.floor((i - 1) / 3));
    const groupSize = (g: number) => Array.from({ length: 8 }, (_, i) => i).filter((i) => group(i) === g).length;
    let waiting = new Map<number, Array<[number, () => void]>>();
    let inFlight = 0;
    let maxInFlight = 0;
    let events: string[] = [];
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const base = `http://127.0.0.1:${server.port}`;
        if (path === '/sitemap.xml') {
          return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: 8 }, (_, i) => `<sitemap><loc>${base}/child${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`);
        }
        const child = path.match(/^\/child(\d)\.xml$/);
        if (!child) return new Response('not found', { status: 404 });
        const i = Number(child[1]);
        events.push(`start ${i}`);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const held = waiting.get(group(i)) ?? [];
        waiting.set(group(i), held);
        const released = new Promise<void>((resolve) => held.push([i, resolve]));
        // 組の全員が待ちに入ってから、後ろの子から放す（放した順に end が並ぶ）
        if (held.length === groupSize(group(i))) queueMicrotask(() => { for (const [, release] of held.sort(([a], [b]) => b - a)) release(); });
        await released;
        inFlight--;
        events.push(`end ${i}`);
        return xml(urlset(`<url><loc>${base}/c${i}a</loc></url><url><loc>${base}/c${i}b</loc></url>`));
      },
    });
    /** 取った子の番号（取った順）。mapSiteUrl を呼ぶたびに数え直す */
    const run = async (limit: number) => {
      events = [];
      waiting = new Map();
      maxInFlight = 0;
      const base = `http://127.0.0.1:${server.port}`;
      const r = await mapSiteUrl({ tenantId: 'legacy', url: base + '/', limit, noCache: true });
      return { links: r.links, fetched: events.filter((e) => e.startsWith('start ')).map((e) => e.slice(6)), base };
    };
    try {
      const all = await run(100);
      expect(all.links).toEqual(Array.from({ length: 8 }, (_, i) => [`${all.base}/c${i}a`, `${all.base}/c${i}b`]).flat());
      // 先頭の 1 つは単独で取り終えてから、残りを同時に最大 3 つずつ取る。組の後ろの子から返っても、結果は子の並び
      expect(events.indexOf('end 0')).toBeLessThan(events.indexOf('start 1'));
      expect(maxInFlight).toBe(3);
      expect(events.filter((e) => e.startsWith('end ')).slice(1, 4)).toEqual(['end 3', 'end 2', 'end 1']);
      expect(all.fetched.slice().sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);

      // 先頭の 1 つで足りるときは、ほかの子を取らない
      const one = await run(2);
      expect(one.links).toEqual([`${one.base}/c0a`, `${one.base}/c0b`]);
      expect(one.fetched).toEqual(['0']);

      // 足りないときは、先頭のあとの 3 つ（1〜3）を取ったところで足りて、4 つ目以降は取らない
      const few = await run(5);
      expect(few.links).toEqual([`${few.base}/c0a`, `${few.base}/c0b`, `${few.base}/c1a`, `${few.base}/c1b`, `${few.base}/c2a`]);
      expect(few.fetched.slice().sort()).toEqual(['0', '1', '2', '3']);
    } finally {
      server.stop(true);
    }
  });
});

describe('POST /map: MapRequestSchema の範囲を 400 にする', () => {
  test('limit・timeoutMs の範囲外と不正な形は 400 INVALID_INPUT（取得もしない）', async () => {
    const spy = spyOn(scraper, 'mapSiteUrl');
    try {
      for (const extra of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: '10' }, { timeoutMs: 0 }, { timeoutMs: 120_001 }, { includeSubdomains: 'yes' }, { since: 5 }, { noCache: 1 }]) {
        const res = await post('/map', { url: 'https://example.com/', ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(400);
        const json = (await res.json()) as any;
        expect(json.code).toBe('INVALID_INPUT');
        expect(json.retryable).toBe(false);
        expect(json.error).toContain(Object.keys(extra)[0]);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('範囲の端（limit 1・1000、timeoutMs 120000）は通り、null の項目は未指定として扱う（必須の url が null なら 400）', async () => {
    const { server, base } = startSite({ sitemap: true });
    try {
      for (const extra of [{ limit: 1 }, { limit: 1000 }, { timeoutMs: 120_000 }, { limit: null, timeoutMs: null, since: null, until: null, includeSubdomains: null, noCache: null }]) {
        const res = await post('/map', { url: base + '/', noCache: true, ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(200);
      }
      const bad = await post('/map', { url: null });
      expect(bad.status).toBe(400);
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
      const r = await crawlSiteUrl({ tenantId: 'legacy', url: base + '/', maxPages: 3, maxDepth: 1, noCache: true });
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
      const r = await crawlSiteUrl({ tenantId: 'legacy', url: base + '/', maxPages: 3, maxDepth: 1, formats: ['markdown', 'links'], noCache: true });
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

describe('crawl_site: 各ページの warnings は応答に残る', () => {
  test('screenshot を求めて画像を取れなかったページには、warnings が付く（/crawl の応答と、/crawl/stream の page イベントも）', async () => {
    const { server, base } = startSite();
    // 画像を撮るブラウザを失敗させる（取れなかった旨の warnings が、ページごとに付く）
    const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockRejectedValue(new Error('browser down'));
    try {
      const r = await crawlSiteUrl({ tenantId: 'legacy', url: base + '/', maxPages: 3, maxDepth: 1, formats: ['markdown', 'screenshot'], noCache: true });
      expect(r.pages.length).toBe(3);
      for (const p of r.pages) {
        expect(p.screenshot).toBeUndefined();
        expect(p.warnings?.join('\n')).toContain('screenshot');
      }

      const res = await post('/crawl', { url: base + '/', maxPages: 2, maxDepth: 1, formats: ['markdown', 'screenshot'], noCache: true });
      const json = (await res.json()) as any;
      expect(json.pages.length).toBe(2);
      for (const p of json.pages) expect(p.warnings?.join('\n')).toContain('screenshot');

      const stream = await post('/crawl/stream', { url: base + '/', maxPages: 2, maxDepth: 1, formats: ['markdown', 'screenshot'], noCache: true });
      const events = [...(await stream.text()).matchAll(/event: page\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
      expect(events.length).toBe(2);
      for (const e of events) expect(e.page.warnings?.join('\n')).toContain('screenshot');
    } finally {
      spy.mockRestore();
      server.stop(true);
    }
  });

  test('screenshot を求めなければ、warnings は付かない', async () => {
    const { server, base } = startSite();
    try {
      const r = await crawlSiteUrl({ tenantId: 'legacy', url: base + '/', maxPages: 2, maxDepth: 1, noCache: true });
      for (const p of r.pages) expect(p.warnings).toBeUndefined();
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
      const got = await receiver.waitForOnly();
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
      const got = await receiver.waitForOnly();
      expect(got.length).toBe(1);
      expect(got[0].data.count).toBe(2);
    } finally {
      server.stop(true);
      receiver.server.stop(true);
    }
  });
});

describe('scrape の urls（/scrape/batch）: webhook の中身は応答と同じ整形後の結果', () => {
  test('REST の /scrape/batch: 1 回だけ届き、data は応答と同じ（内部の項目は付かない）', async () => {
    const { server, base } = startSite();
    const receiver = startReceiver();
    try {
      const res = await post('/scrape/batch', { urls: [base + '/a', base + '/b'], webhookUrl: receiver.url, noCache: true });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.results[0].quality).toBeUndefined();
      const got = await receiver.waitForOnly();
      expect(got.length).toBe(1);
      expect(got[0].event).toBe('scrape.completed');
      expect(got[0].data.total).toBe(2);
      expect(got[0].data.results.map((r: any) => r.url).sort()).toEqual([base + '/a', base + '/b']);
      // 応答の並びは取得の完了順なので、url で並べてから比べる
      const byUrl = (a: any, b: any) => a.url.localeCompare(b.url);
      expect({ ...got[0].data, results: got[0].data.results.sort(byUrl) }).toEqual({ ...json, results: json.results.sort(byUrl) });
    } finally {
      server.stop(true);
      receiver.server.stop(true);
    }
  });

  test('verbose: true のときは、応答と同じく整形しない', async () => {
    const { server, base } = startSite();
    const receiver = startReceiver();
    try {
      const res = await post('/scrape/batch', { urls: [base + '/a'], webhookUrl: receiver.url, verbose: true, noCache: true });
      const json = (await res.json()) as any;
      expect(json.results[0].quality).toBeDefined();
      const got = await receiver.waitForOnly();
      expect(got.length).toBe(1);
      expect(got[0].data.results[0].quality).toBe(json.results[0].quality);
    } finally {
      server.stop(true);
      receiver.server.stop(true);
    }
  });

  test('MCP の scrape の urls も同じ（1 回だけ、応答と同じ整形後）', async () => {
    const { server, base } = startSite();
    const receiver = startReceiver();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'crawl-map-params', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      const out: any = await client.callTool({ name: 'scrape', arguments: { urls: [base + '/a'], webhookUrl: receiver.url, noCache: true } });
      const json = JSON.parse(out.content[0].text);
      expect(json.results[0].quality).toBeUndefined();
      const got = await receiver.waitForOnly();
      expect(got.length).toBe(1);
      expect(got[0].data).toEqual(json);
    } finally {
      await client.close();
      await mcp.close();
      server.stop(true);
      receiver.server.stop(true);
    }
  });
});

describe('scrape の urls（/scrape/batch）: webhookUrl は URL の形を確かめる', () => {
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

  test('MCP の scrape の urls も URL でない webhookUrl を断る', async () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 0, successful: 0, failed: 0, results: [], errors: [] } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'crawl-map-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const bad = await client.callTool({ name: 'scrape', arguments: { urls: ['https://example.com/'], webhookUrl: 'not a url' } }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect((bad as any).isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const ok = await client.callTool({ name: 'scrape', arguments: { urls: ['https://example.com/'], webhookUrl: 'https://example.com/hook' } });
      expect((ok as any).isError).not.toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
