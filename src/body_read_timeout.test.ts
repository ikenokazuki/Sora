import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as browserEngine from './browser_engine.js';
import * as cache from './cache.js';
import { CACHE_TTL_EMPTY } from './cache.js';
import { BodyTimeoutError, readBodyWithLimit } from './net/safe_transport.js';
import { pdfSlots } from './pdf.js';
import { fetchSitemapEntries, mapSiteUrl, scrapeUrl } from './scraper.js';
import { limits } from './security/limits.js';
import * as tenantCache from './security/tenant_cache.js';
import { installFakePdfLauncher } from './test_fixtures/pdf_launcher.js';
import { makePdf } from './test_fixtures/pdf.js';
import { failureOf, waitFor, within } from './test_fixtures/wait.js';

// 取得の時間の上限（timeoutMs）は、応答のヘッダーを受けた後の本文の読み込みにも効く。本文が終わらない応答が、
// 全員で共有する PDF の解析の枠などを、握り続けないことを確かめる（手元のサーバーだけ）

/** 1 かたまりを送ったまま、閉じない本文 */
const neverEnding = (first: string | Uint8Array, onCancel?: () => void) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(typeof first === 'string' ? new TextEncoder().encode(first) : first); },
  cancel() { onCancel?.(); },
});

describe('readBodyWithLimit の時間の上限', () => {
  test('本文が終わらなければ、読み始めから timeoutMs で打ち切り、読み込みを中止する', async () => {
    let cancelled = false;
    const started = Date.now();
    const error = await within(5000, failureOf(readBodyWithLimit(new Response(neverEnding('a', () => { cancelled = true; })), 1000, { timeoutMs: 200 })));
    expect(error).toBeInstanceOf(BodyTimeoutError);
    expect(error?.message).toContain('本文の読み込みがタイムアウト');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(cancelled).toBe(true);
  });

  test('少しずつ届き続けても、合計の時間で打ち切る', async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) { interval = setInterval(() => controller.enqueue(new Uint8Array([1])), 20); },
      cancel() { clearInterval(interval); },
    });
    try {
      const error = await within(5000, failureOf(readBodyWithLimit(new Response(trickle), 1_000_000, { timeoutMs: 300 })));
      expect(error).toBeInstanceOf(BodyTimeoutError);
    } finally {
      clearInterval(interval);
    }
  });

  test('中止の信号が来たら、時間の上限を待たずに、信号の理由で打ち切る', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop-by-caller')), 50);
    const error = await within(5000, failureOf(readBodyWithLimit(new Response(neverEnding('a')), 1000, { timeoutMs: 60_000, signal: controller.signal })));
    expect(error?.message).toBe('stop-by-caller');
    // 呼ぶ前から中止されていたら、何も送ってこない本文でも、待たない
    let cancelled = false;
    const silent = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const aborted = AbortSignal.abort(new Error('already-stopped'));
    const second = await within(5000, failureOf(readBodyWithLimit(new Response(silent), 1000, { timeoutMs: 60_000, signal: aborted })));
    expect(second?.message).toBe('already-stopped');
    expect(cancelled).toBe(true);
  });

  test('時間内に終わる本文は、そのまま読む', async () => {
    const body = await readBodyWithLimit(new Response('hello'), 1000, { timeoutMs: 1000 });
    expect(new TextDecoder().decode(body)).toBe('hello');
  });
});

describe('本文が終わらない応答は、timeoutMs で打ち切る（手元のサーバー。実際の取得の経路）', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  const prevIsolation = process.env.SORA_ISOLATION;
  const spies: Array<{ mockRestore: () => void }> = [];
  let fakeLauncher: ReturnType<typeof installFakePdfLauncher> | undefined;
  let n = 0;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}?n=${++n}-${Date.now()}`;

  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/never.html') return new Response(neverEnding('<!doctype html><html><body><p>start</p>'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (path === '/never.pdf') return new Response(neverEnding('%PDF-1.4\n'), { headers: { 'content-type': 'application/pdf' } });
        if (path === '/ok.pdf') return new Response(Buffer.from(makePdf([['Sora body timeout ok PDF']])), { headers: { 'content-type': 'application/pdf' } });
        if (path === '/sitemap.xml' || path === '/never-sitemap.xml') return new Response(neverEnding('<?xml version="1.0"?><urlset>'), { headers: { 'content-type': 'application/xml' } });
        if (/robots\.txt|sitemap/.test(path)) return new Response('', { status: 404 });
        return new Response(`<!doctype html><html><head><title>map root</title></head><body><main>${'<p>map root body with enough text to read.</p>'.repeat(10)}<a href="/p1">p1</a> <a href="/p2">p2</a></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
  });
  beforeEach(() => {
    cache.clearCache();
    spies.push(spyOn(browserEngine, 'resolveChromiumPath').mockReturnValue(undefined));
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    fakeLauncher?.restore();
    fakeLauncher = undefined;
    if (prevIsolation === undefined) delete process.env.SORA_ISOLATION;
    else process.env.SORA_ISOLATION = prevIsolation;
  });

  test('HTML の本文が終わらなければ、timeoutMs で失敗する', async () => {
    const error = await within(8000, failureOf(scrapeUrl({ tenantId: 'name:a', url: url('/never.html'), mode: 'fast', noCache: true, timeoutMs: 1000 })));
    expect(error?.message).toContain('本文の読み込みがタイムアウト');
  }, 20_000);

  test('PDF の本文が終わらなければ、timeoutMs で失敗し、解析の枠を手放す', async () => {
    const jobs = [1, 2].map(() => failureOf(scrapeUrl({ tenantId: 'name:mallory', url: url('/never.pdf'), mode: 'fast', noCache: true, timeoutMs: 1000 })));
    const errors = await within(8000, Promise.all(jobs));
    for (const error of errors) expect(error?.message).toContain('本文の読み込みがタイムアウト');
    expect(pdfSlots.activeCount).toBe(0);
  }, 20_000);

  test('strict では、1 人が同時に持てる解析の枠は 1 つ。終わらない PDF の間も、ほかの利用者の PDF は解析できる', async () => {
    process.env.SORA_ISOLATION = 'strict';
    fakeLauncher = installFakePdfLauncher();
    const mallory = [1, 2].map(() => failureOf(scrapeUrl({ tenantId: 'name:mallory', url: url('/never.pdf'), mode: 'fast', noCache: true, timeoutMs: 5000 })));
    try {
      await waitFor(() => pdfSlots.activeCount === 1 && pdfSlots.pendingCount === 1);
      const victim = await within(4000, scrapeUrl({ tenantId: 'name:victim', url: url('/ok.pdf'), mode: 'fast', noCache: true, timeoutMs: 3000 }));
      expect(victim.content).toContain('Sora body timeout ok PDF');
    } finally {
      await within(20_000, Promise.all(mallory));
    }
    expect(pdfSlots.activeCount).toBe(0);
    expect(pdfSlots.pendingCount).toBe(0);
  }, 40_000);

  test('robots.txt の本文が終わらなくても、map_site は、5 秒で諦めて先へ進む', async () => {
    // robots.txt は URL に ? を付けられないので、この確認だけの別のサーバーを使う
    const robots = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/robots.txt') return new Response(neverEnding('User-agent: *\n'), { headers: { 'content-type': 'text/plain' } });
        if (path.includes('sitemap')) return new Response('', { status: 404 });
        return new Response('<!doctype html><html><head><title>r</title></head><body><main><p>robots root body.</p><a href="/r1">r1</a></main></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
    try {
      const result = await within(12_000, mapSiteUrl({ tenantId: 'name:a', url: `http://127.0.0.1:${robots.port}/`, limit: 10, noCache: true }));
      expect(result.links.some((link) => link.endsWith('/r1'))).toBe(true);
    } finally {
      robots.stop(true);
    }
  }, 30_000);

  test('サイトマップの本文は、全体の時間の期限（中止の信号）でも打ち切る', async () => {
    const ctx = { tenantId: 'name:a', limits: limits(), signal: AbortSignal.timeout(1000), fetched: 0 };
    const entries = await within(6000, fetchSitemapEntries(url('/never-sitemap.xml'), ctx));
    expect(entries).toEqual([]);
  }, 20_000);

  test('サイトマップの本文を時間で打ち切ったら、警告を付けて、短くだけ置く', async () => {
    const ttl = spyOn(tenantCache, 'setToTenantCache');
    spies.push(ttl);
    const result = await within(30_000, mapSiteUrl({ tenantId: 'name:a', url: url('/map-root'), limit: 50 }));
    expect(result.warnings?.join('')).toContain('サイトマップの本文の読み込みは 10 秒まで');
    const stored = ttl.mock.calls.find((call) => String(call[1]).startsWith('map:v4:'));
    expect(stored?.[3]).toBe(CACHE_TTL_EMPTY);
  }, 40_000);
});
