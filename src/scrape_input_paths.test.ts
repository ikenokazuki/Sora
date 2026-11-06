import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { resolveChromiumPath } from './browser_engine.js';
import * as browserStealth from './browser_stealth.js';
import * as cache from './cache.js';
import * as scraper from './scraper.js';
import { scrapeBatchUrls, scrapeUrl } from './scraper.js';
import { scrapeRoutes } from './routes/scrape.js';
import { formatCompactScrapeResult } from './response_cleaner.js';

// 手元のサーバーで、scrape・scrape_batch の入力が取得の経路ごとにどう効くかを確かめる（外へは出ない）
const filler = '静的に取れる、十分に長い本文の文です。'.repeat(20);
const mail = 'contact@example.com';
const phone = '03-1234-5678';
const pdfText = 'Sora PDF body text for screenshot test';

/** 1 ページに英字を 1 行書いただけの、最小の PDF */
function minimalPdf(text: string): string {
  const stream = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
        const path = new URL(req.url).pathname;
        otherSeen.push({ path, headers: req.headers });
        if (path === '/landing') return html(`${filler} 転送先のページです。`);
        return new Response('window.__other = 1;', { headers: { 'content-type': 'text/javascript' } });
      },
    });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        seen.push({ path, headers: req.headers });
        if (path === '/redirect') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/landing` } });
        if (path === '/pii') {
          return new Response(
            `<!doctype html><html><head><title>店の案内</title><meta name="author" content="${mail}">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: '店', url: 'https://example.com/', email: mail, telephone: phone })}</script></head>
<body><main><h1>案内</h1><p>${filler}</p>
<p><a href="mailto:${mail}">メールで問い合わせ</a> <a href="tel:${phone}">電話で問い合わせ</a> <a href="https://example.com/items/42">商品</a></p>
<p><img src="https://example.com/map.png" alt="連絡先 ${mail} ${phone}"></p></main></body></html>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
        if (path.endsWith('.pdf')) return new Response(minimalPdf(pdfText), { headers: { 'content-type': 'application/pdf' } });
        if (path.endsWith('.png')) return new Response(PNG_1X1, { headers: { 'content-type': 'image/png' } });
        if (path === '/clip') {
          return new Response(`<!doctype html><html><body><p>${filler}</p><div id="box" style="width:200px;height:100px;background:#c00"></div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        // 静的な取得では本文が取れ、ブラウザでは JavaScript で 403 の画面に飛ばされる（ボット対策のページの形）
        if (path === '/bounce') {
          return new Response(`<!doctype html><html><head><title>案内</title><script>location.replace('/blocked')</script></head><body><main><h1>案内</h1><p>${filler}</p></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (path === '/blocked') {
          return new Response('<!doctype html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You do not have permission to access this page.</p></body></html>', { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        // 本文が 50 字未満の SPA の殻（静的な取得では本文が取れず、ブラウザで描画する形）
        if (path === '/spa-shell') {
          return new Response('<!doctype html><html><head><title>アプリ</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
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

    test('jsonLd・images の alt・author・evidence・mailto:/tel: のリンクにもかかる', async () => {
      const options = { url: `${base()}/pii`, mode: 'fast' as const, formats: ['markdown', 'html', 'rawHtml', 'jsonLd', 'links', 'images'] as Array<'markdown' | 'html' | 'rawHtml' | 'jsonLd' | 'links' | 'images'>, verbose: true, noCache: true };
      const plain = await scrapeUrl(options);
      // 元のページには、どの項目にもメールと電話番号がある（マスクで消えたと言えるように）
      expect(JSON.stringify(plain.jsonLd)).toContain(mail);
      expect(plain.rawHtml).toContain(`mailto:${mail}`);
      expect(plain.rawHtml).toContain(`tel:${phone}`);
      expect(plain.images?.[0]?.alt).toContain(mail);
      expect(plain.author).toContain(mail);

      const masked = await scrapeUrl({ ...options, maskPii: true });
      const json = JSON.stringify(masked);
      expect(json).not.toContain(mail);
      expect(json).not.toContain(phone);
      expect(json).not.toContain('0312345678');
      expect(JSON.stringify(masked.jsonLd)).toContain('[EMAIL]');
      expect(JSON.stringify(masked.jsonLd)).toContain('[PHONE]');
      expect(masked.rawHtml).toContain('mailto:[EMAIL]');
      expect(masked.links).toContain('https://example.com/items/42');
      expect(masked.images?.[0]?.alt).toBe('連絡先 [EMAIL] [PHONE]');
      expect(masked.images?.[0]?.url).toBe('https://example.com/map.png');
    });

    test('maskPii を付けなければ、そのまま返す', async () => {
      const result = await scrapeUrl({ url: `${base()}/mask`, mode: 'fast', formats: ['rawHtml'], noCache: true });
      expect(result.rawHtml).toContain(mail);
    });
  });

  describe('formats の screenshot', () => {
    const chromium = resolveChromiumPath();
    const browserTest = chromium ? test : test.skip;

    browserTest('既定の auto で静的に取れるページでも、ブラウザで画像を取る（本文は静的な取得のまま）', async () => {
      const result = await scrapeUrl({ url: `${base()}/shot`, formats: ['markdown', 'screenshot'], noCache: true });
      expect(result.renderedWithBrowser).toBe(false);
      expect(result.content).toContain('静的に取れる、十分に長い本文の文です。');
      expect(result.screenshot?.length).toBeGreaterThan(100);
      expect(result.warnings).toBeUndefined();
    }, 60_000);

    browserTest('scrape_batch も同じ', async () => {
      const batch = await scrapeBatchUrls({ urls: [`${base()}/shot-batch`], formats: ['screenshot'], noCache: true });
      expect(batch.results[0].screenshot?.length).toBeGreaterThan(100);
    }, 60_000);

    browserTest('ブラウザだけが 403 の画面に飛ばされても、本文と HTTP の状態は静的な取得のまま（ブラウザからは画像だけ）', async () => {
      const plain = await scrapeUrl({ url: `${base()}/bounce`, formats: ['markdown'], noCache: true });
      expect(plain.content).toContain('静的に取れる、十分に長い本文の文です。');
      const shot = await scrapeUrl({ url: `${base()}/bounce`, formats: ['markdown', 'screenshot'], noCache: true });
      expect(shot.content).toBe(plain.content);
      expect(shot.title).toBe(plain.title);
      expect(shot.contentStatus).toBe(plain.contentStatus);
      expect(shot.contentStatus).not.toBe('unavailable');
      expect(shot.renderedWithBrowser).toBe(false);
      expect(shot.screenshot?.length).toBeGreaterThan(100);
      expect(shot.warnings).toBeUndefined();
    }, 60_000);

    browserTest('画像を撮れず警告が付いた結果は、短い時間だけキャッシュする（一時的な失敗を 30 分残さない）', async () => {
      const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockRejectedValue(new Error('browser down'));
      const setSpy = spyOn(cache, 'setToCache');
      try {
        const url = `${base()}/shot-ttl-${Date.now()}`;
        const result = await scrapeUrl({ url, formats: ['markdown', 'screenshot'] });
        expect(result.warnings?.join('\n')).toContain('screenshot');
        expect(setSpy.mock.calls.filter(([key]) => String(key).startsWith(`scrape:v10:${url}:`)).map(([, , ttl]) => ttl)).toEqual([cache.CACHE_TTL_EMPTY]);
      } finally {
        spy.mockRestore();
        setSpy.mockRestore();
      }
    }, 60_000);

    browserTest('clipSelector は、screenshot があるとき要素だけの画像を返す（auto でもブラウザで撮る）', async () => {
      const result = await scrapeUrl({ url: `${base()}/clip`, formats: ['screenshot'], clipSelector: '#box', noCache: true });
      const png = Buffer.from(result.screenshot ?? '', 'base64');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([200, 100]);
    }, 60_000);

    test('PDF は、screenshot を求めても本文のまま（画像は付けず、警告を付ける）', async () => {
      const plain = await scrapeUrl({ url: `${base()}/doc.pdf`, formats: ['markdown'], noCache: true });
      expect(plain.content).toContain(pdfText);
      const result = await scrapeUrl({ url: `${base()}/doc.pdf`, formats: ['markdown', 'screenshot'], noCache: true });
      expect(result.content).toBe(plain.content);
      expect(result.contentType).toBe('application/pdf');
      expect(result.screenshot).toBeUndefined();
      expect(result.warnings?.join('\n')).toContain('screenshot');
    }, 60_000);

    test('画像のファイルも、種類と大きさの本文のまま（画像は付けず、警告を付ける）', async () => {
      const result = await scrapeUrl({ url: `${base()}/pic.png`, formats: ['markdown', 'screenshot'], noCache: true });
      expect(result.contentType).toBe('image/png');
      expect(result.content).toContain('種類: image/png');
      expect(result.content).toContain('大きさ: 70 バイト');
      expect(result.screenshot).toBeUndefined();
      expect(result.warnings?.join('\n')).toContain('screenshot');
    }, 60_000);

    browserTest('ブラウザが失敗したときは、静的に取れた本文を警告つきで返す', async () => {
      const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockRejectedValue(new Error('browser down'));
      try {
        const result = await scrapeUrl({ url: `${base()}/shot-fallback`, formats: ['markdown', 'screenshot'], noCache: true });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(result.renderedWithBrowser).toBe(false);
        expect(result.content).toContain('静的に取れる、十分に長い本文の文です。');
        expect(result.screenshot).toBeUndefined();
        expect(result.warnings?.join('\n')).toContain('screenshot');
      } finally {
        spy.mockRestore();
      }
    }, 60_000);

    browserTest('本文が 50 字未満の SPA でブラウザが失敗しても、screenshot を求めていれば静的な結果に警告を付けて返す', async () => {
      const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockRejectedValue(new Error('browser down'));
      try {
        const result = await scrapeUrl({ url: `${base()}/spa-shell`, formats: ['markdown', 'screenshot'], noCache: true });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(result.renderedWithBrowser).toBe(false);
        expect(result.title).toBe('アプリ');
        expect(result.screenshot).toBeUndefined();
        expect(result.warnings?.join('\n')).toContain('screenshot');
        // screenshot を求めていない SPA の失敗は、今までどおり例外。expect(...).rejects には渡さずに待つ（Bun 1.4.2 では、渡した処理の中の
        // 同じ送り先への 2 回目の取得で本文の読み出しが進まず、取得の時間切れになる。ふつうに待てば進む）
        const error = await scrapeUrl({ url: `${base()}/spa-shell`, formats: ['markdown'], noCache: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('browser down');
      } finally {
        spy.mockRestore();
      }
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

  describe('REST: ?verbose=true と null の項目（/scrape・/scrape/stream・/scrape/batch で同じ扱い）', () => {
    const post = (path: string, body: unknown) => scrapeRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    test('?verbose=true は、本文の verbose が無いとき scrapeUrl・scrapeBatchUrls に verbose: true で渡る（本文の verbose が優先）', async () => {
      const urlSpy = spyOn(scraper, 'scrapeUrl');
      const batchSpy = spyOn(scraper, 'scrapeBatchUrls');
      try {
        const url = `${base()}/verbose-query`;
        for (const path of ['/scrape', '/scrape/stream']) {
          urlSpy.mockClear();
          const res = await post(`${path}?verbose=true`, { url, mode: 'fast', noCache: true });
          expect(res.status, path).toBe(200);
          await res.text();
          expect(urlSpy.mock.calls[0][0].verbose, path).toBe(true);

          urlSpy.mockClear();
          await (await post(path, { url, mode: 'fast', noCache: true })).text();
          expect(urlSpy.mock.calls[0][0].verbose, `${path} クエリなし`).toBeFalsy();

          urlSpy.mockClear();
          await (await post(`${path}?verbose=true`, { url, mode: 'fast', verbose: false, noCache: true })).text();
          expect(urlSpy.mock.calls[0][0].verbose, `${path} 本文が優先`).toBe(false);
        }
        const batch = await post('/scrape/batch?verbose=true', { urls: [url], mode: 'fast', noCache: true });
        expect(batch.status).toBe(200);
        expect(batchSpy.mock.calls[0][0].verbose).toBe(true);
      } finally {
        urlSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });

    test('/scrape: null の項目は未指定として扱う（必須の url が null なら 400）', async () => {
      const ok = await post('/scrape', { url: `${base()}/null-scrape`, mode: 'fast', maxChars: null, query: null, formats: null, headers: null, noCache: null });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).content).toContain('静的に取れる');
      expect((await post('/scrape', { url: null })).status).toBe(400);
    });

    test('/scrape/stream: null の項目は未指定として扱う（必須の url が null なら 400）', async () => {
      const ok = await post('/scrape/stream', { url: `${base()}/null-stream`, mode: 'fast', maxChars: null, query: null, formats: null, noCache: null });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('event: done');
      expect((await post('/scrape/stream', { url: null })).status).toBe(400);
    });

    test('/scrape/batch: null の項目は未指定として扱う（必須の urls が null なら 400）', async () => {
      const ok = await post('/scrape/batch', { urls: [`${base()}/null-batch`], mode: 'fast', maxChars: null, concurrency: null, webhookUrl: null, formats: null, noCache: null });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).successful).toBe(1);
      expect((await post('/scrape/batch', { urls: null })).status).toBe(400);
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

    browserTest('別のオリジンへの転送には、資格情報でないヘッダーだけが付いてくる（Authorization は付かない）', async () => {
      seen.length = 0;
      otherSeen.length = 0;
      const result = await scrapeUrl({ url: `${base()}/redirect`, mode: 'browser', headers: { ...headers, Authorization: 'Bearer secret-token', 'X-API-Key': 'k-1' }, noCache: true });
      expect(result.content).toContain('転送先のページです。');
      const landing = otherSeen.find((entry) => entry.path === '/landing');
      expect(landing).toBeDefined();
      expect(landing?.headers.get('accept-language')).toBe('fr');
      expect(landing?.headers.get('x-test-header')).toBe('sora-1');
      expect(landing?.headers.get('authorization')).toBeNull();
      expect(landing?.headers.get('x-api-key')).toBeNull();
      // 転送の前のオリジンには、全部付く
      const first = seen.find((entry) => entry.path === '/redirect');
      expect(first?.headers.get('authorization')).toBe('Bearer secret-token');
      expect(first?.headers.get('x-api-key')).toBe('k-1');
    }, 60_000);

    browserTest('User-Agent はブラウザでは送らない（navigator.userAgent と食い違うため）。静的な取得では送る', async () => {
      seen.length = 0;
      const ua = { 'User-Agent': 'caller-agent/1.0', 'X-Test-Header': 'sora-1' };
      await scrapeUrl({ url: `${base()}/ua-browser`, mode: 'browser', headers: ua, noCache: true });
      const page = seen.find((entry) => entry.path === '/ua-browser');
      expect(page?.headers.get('x-test-header')).toBe('sora-1');
      expect(page?.headers.get('user-agent')).not.toBe('caller-agent/1.0');
      await scrapeUrl({ url: `${base()}/ua-static`, mode: 'fast', headers: ua, noCache: true });
      expect(seen.find((entry) => entry.path === '/ua-static')?.headers.get('user-agent')).toBe('caller-agent/1.0');
    }, 60_000);

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

  test('/scrape/stream: renderJs と fastOnly の同時指定は、ストリームを開く前に 400（SCRAPE_ERROR のイベントにしない）', async () => {
    const res = await post('/scrape/stream', { url: 'https://example.com/', renderJs: true, fastOnly: true });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false, error: expect.stringContaining('同時に指定できません') });
  });

  test('/scrape/stream: 壊れた removeSelectors も 400', async () => {
    const res = await post('/scrape/stream', { url: 'https://example.com/', removeSelectors: ['.ad', 'div['] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false, error: expect.stringContaining('div[') });
  });

  test('/scrape/batch: 壊れた removeSelectors', async () => {
    const res = await post('/scrape/batch', { urls: ['https://example.com/'], removeSelectors: ['div['] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false });
  });
});
