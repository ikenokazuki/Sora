import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveChromiumPath } from './browser_engine.js';
import { scrapeBatchUrls, scrapeUrl } from './scraper.js';
import { scrapeRoutes } from './routes/scrape.js';
import { formatCompactScrapeResult } from './response_cleaner.js';

// 手元のサーバーで、scrape・scrape_batch の入力が取得の経路ごとにどう効くかを確かめる（外へは出ない）
const filler = '静的に取れる、十分に長い本文の文です。'.repeat(20);
const mail = 'contact@example.com';

describe('scrape・scrape_batch の入力の経路（手元のサーバー）', () => {
  let server: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  const seen: Array<{ path: string; headers: Headers }> = [];
  const otherSeen: Array<{ path: string; headers: Headers }> = [];
  const prevAllow = process.env.ALLOW_LOCAL_FETCH;
  const html = (body: string) => new Response(`<!doctype html><html><head><title>${mail} の案内</title></head><body><main><h1>案内</h1><p>${body}</p></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  beforeAll(() => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    other = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        otherSeen.push({ path: new URL(req.url).pathname, headers: req.headers });
        return new Response('window.__other = 1;', { headers: { 'content-type': 'text/javascript' } });
      },
    });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        seen.push({ path, headers: req.headers });
        if (path === '/clip') {
          return new Response(`<!doctype html><html><body><p>${filler}</p><div id="box" style="width:200px;height:100px;background:#c00"></div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (path === '/with-script') {
          return new Response(`<!doctype html><html><head><title>t</title></head><body><main><p>${filler}</p><script src="http://127.0.0.1:${other.port}/other.js"></script></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return html(`${filler} 連絡先: ${mail}`);
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    other.stop(true);
    if (prevAllow === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = prevAllow;
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  describe('maskPii', () => {
    test('html・rawHtml・title・description にもかかる（静的な取得）', async () => {
      const result = await scrapeUrl({ url: `${base()}/mask`, mode: 'fast', formats: ['markdown', 'html', 'rawHtml'], maskPii: true, noCache: true });
      expect(result.content).not.toContain(mail);
      expect(result.title).toBe('[EMAIL] の案内');
      expect(result.html).toContain('[EMAIL]');
      expect(result.rawHtml).toContain('[EMAIL]');
      expect(JSON.stringify(formatCompactScrapeResult(result))).not.toContain(mail);
    });

    test('maskPii を付けなければ、そのまま返す', async () => {
      const result = await scrapeUrl({ url: `${base()}/mask`, mode: 'fast', formats: ['rawHtml'], noCache: true });
      expect(result.rawHtml).toContain(mail);
    });
  });

  describe('formats の screenshot', () => {
    const chromium = resolveChromiumPath();
    const browserTest = chromium ? test : test.skip;

    browserTest('既定の auto で静的に取れるページでも、ブラウザで画像を取る', async () => {
      const result = await scrapeUrl({ url: `${base()}/shot`, formats: ['markdown', 'screenshot'], noCache: true });
      expect(result.renderedWithBrowser).toBe(true);
      expect(result.screenshot?.length).toBeGreaterThan(100);
      expect(result.warnings).toBeUndefined();
    }, 60_000);

    browserTest('scrape_batch も同じ', async () => {
      const batch = await scrapeBatchUrls({ urls: [`${base()}/shot-batch`], formats: ['screenshot'], noCache: true });
      expect(batch.results[0].renderedWithBrowser).toBe(true);
      expect(batch.results[0].screenshot?.length).toBeGreaterThan(100);
    }, 60_000);

    browserTest('clipSelector は、screenshot があるとき要素だけの画像を返す（auto でもブラウザで撮る）', async () => {
      const result = await scrapeUrl({ url: `${base()}/clip`, formats: ['screenshot'], clipSelector: '#box', noCache: true });
      const png = Buffer.from(result.screenshot ?? '', 'base64');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([200, 100]);
    }, 60_000);

    test('mode に fast を明示したときはブラウザに切り替えず、画像を取れない旨の警告を付ける', async () => {
      for (const options of [{ mode: 'fast' as const }, { fastOnly: true }]) {
        const result = await scrapeUrl({ url: `${base()}/shot-fast`, formats: ['markdown', 'screenshot'], noCache: true, ...options });
        expect(result.renderedWithBrowser).toBe(false);
        expect(result.screenshot).toBeUndefined();
        expect(result.warnings?.join('\n')).toContain('screenshot');
        expect(formatCompactScrapeResult(result).warnings).toEqual(result.warnings);
      }
    });

    test('screenshot を求めていなければ、警告は付けない', async () => {
      const result = await scrapeUrl({ url: `${base()}/shot-fast`, mode: 'fast', noCache: true });
      expect(result.warnings).toBeUndefined();
      expect('warnings' in formatCompactScrapeResult(result)).toBe(false);
    });
  });

  describe('headers', () => {
    const chromium = resolveChromiumPath();
    const browserTest = chromium ? test : test.skip;
    const headers = { 'X-Test-Header': 'sora-1', 'Accept-Language': 'fr' };

    test('静的な取得では届く（今までどおり）', async () => {
      seen.length = 0;
      await scrapeUrl({ url: `${base()}/static-headers`, mode: 'fast', headers, noCache: true });
      expect(seen.at(-1)?.headers.get('x-test-header')).toBe('sora-1');
    });

    for (const [name, options] of [['mode: browser', { mode: 'browser' as const }], ['renderJs: true', { renderJs: true }]] as const) {
      browserTest(`ブラウザの経路（${name}）でも、取得先と同じオリジンへの要求に届く。ほかのオリジンへは付けない`, async () => {
        seen.length = 0;
        otherSeen.length = 0;
        await scrapeUrl({ url: `${base()}/with-script`, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' }, noCache: true });
        const page = seen.find((entry) => entry.path === '/with-script');
        expect(page?.headers.get('x-test-header')).toBe('sora-1');
        expect(page?.headers.get('accept-language')).toBe('fr');
        expect(page?.headers.get('authorization')).toBe('Bearer secret-token');
        // 別のオリジン（ポートが違う）のスクリプトの要求には、資格情報もほかのヘッダーも付けない
        const script = otherSeen.find((entry) => entry.path === '/other.js');
        expect(script).toBeDefined();
        expect(script?.headers.get('x-test-header')).toBeNull();
        expect(script?.headers.get('authorization')).toBeNull();
      }, 60_000);
    }

    browserTest('headers を渡さない取得は、今までどおり（Accept-Language は日本語）', async () => {
      seen.length = 0;
      await scrapeUrl({ url: `${base()}/no-headers`, mode: 'browser', noCache: true });
      const page = seen.find((entry) => entry.path === '/no-headers');
      expect(page?.headers.get('x-test-header')).toBeNull();
      expect(page?.headers.get('accept-language')?.startsWith('ja')).toBe(true);
    }, 60_000);
  });
});

describe('REST: 入力の誤りは 400 と retryable:false', () => {
  const post = (path: string, body: unknown) => scrapeRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('/scrape: renderJs と fastOnly の同時指定', async () => {
    const res = await post('/scrape', { url: 'https://example.com/', renderJs: true, fastOnly: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false, error: expect.stringContaining('同時に指定できません') });
  });

  test('/scrape: 壊れた removeSelectors（取得の前に断る）', async () => {
    const res = await post('/scrape', { url: 'https://example.com/', removeSelectors: ['.ad', 'div['] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false, error: expect.stringContaining('div[') });
  });

  test('/scrape/batch: 壊れた removeSelectors', async () => {
    const res = await post('/scrape/batch', { urls: ['https://example.com/'], removeSelectors: ['div['] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false });
  });
});
