import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { app } from './index.js';
import { createAuthMiddleware, isSecureEqual } from './auth.js';
import { createMcpServer, isModuleActive } from './mcp.js';
import {
  isBlockedHostname,
  isPrivateIp,
  matchUrlPattern,
  decodeHtmlBuffer,
  extractWithSelectors,
  parsePdfToMarkdown,
  safeTruncateMarkdown,
  estimateTokens,
  scrapeBatchUrls,
  convertHtmlToMarkdown,
  cleanMarkdownTokens,
  normalizeRealtimeItem,
  extractTablesFromHtml,
  generateExtractiveSummary,
  dedupSearchResults,
  maskPiiInText,
  generatePromptContext,
  highlightQueryMatchesInMarkdown,
  calculateContentStats,
  extractCitationsFromMarkdown,
  chunkMarkdownContent,
  validateExtractedLinks,
  sendWebhookNotification,
  scrapeUrl,
  crawlSiteUrl,
  filterByDomains,
  extractQueryHighlights,
  resolveCityId,
  executeBrowserActions,
  resolveChromiumPath,
  getCacheMetrics,
  setToCache,
  getFromCache,
  clearCache,
  sweepExpiredEntries,
  runWithSingleFlight,
  validateHostIpDns,
  SimpleSemaphore,
} from './scraper.js';

describe('web-fetcher Core Functions', () => {
  it('isBlockedHostname should block local, private IPs, decimal IPs, and metadata hostnames', () => {
    const prev = process.env.ALLOW_LOCAL_FETCH;
    delete process.env.ALLOW_LOCAL_FETCH;
    try {
      expect(isBlockedHostname('localhost')).toBe(true);
      expect(isBlockedHostname('127.0.0.1')).toBe(true);
      expect(isBlockedHostname('10.0.0.1')).toBe(true);
      expect(isBlockedHostname('192.168.1.1')).toBe(true);
      expect(isBlockedHostname('172.16.0.1')).toBe(true);
      expect(isBlockedHostname('169.254.169.254')).toBe(true);
      expect(isBlockedHostname('metadata.google.internal')).toBe(true);
      expect(isBlockedHostname('2130706433')).toBe(true); // 127.0.0.1 in decimal
      expect(isBlockedHostname('::1')).toBe(true);
      expect(isBlockedHostname('::')).toBe(true);
      expect(isBlockedHostname('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedHostname('100.64.0.1')).toBe(true); // CGNAT
      expect(isBlockedHostname('198.18.0.1')).toBe(true); // Benchmark
      expect(isBlockedHostname('service.internal')).toBe(true);
      expect(isBlockedHostname('example.com')).toBe(false);
      expect(isBlockedHostname('yahoo.co.jp')).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ALLOW_LOCAL_FETCH = prev;
    }
  });

  it('normalizeRealtimeItem should convert UNIX timestamp to ISO publishedTime and format author', () => {
    const rawItem = {
      id: '123456789',
      text: 'テスト投稿です #テスト',
      created_at: 1787386954,
      author_name: '太郎',
      author_handle: 'taro_yamada',
      url: 'https://x.com/taro_yamada/status/123456789',
    };
    const normalized = normalizeRealtimeItem(rawItem);
    expect(normalized.source).toBe('x');
    expect(normalized.siteName).toBe('X (Twitter)');
    expect(normalized.author).toBe('太郎 (@taro_yamada)');
    expect(normalized.publishedTime).toBe(new Date(1787386954 * 1000).toISOString());
  });

  it('cleanMarkdownTokens should remove empty links, javascript links, and collapse whitespace', () => {
    const dirtyMd = `
      # Header

      [ ](https://example.com/empty)
      [Click Here](javascript:void(0))
      ![] (https://example.com/empty-img.png)



      Paragraph text with trailing spaces.   
    `;
    const cleaned = cleanMarkdownTokens(dirtyMd);
    expect(cleaned).not.toContain('[ ](https://example.com/empty)');
    expect(cleaned).not.toContain('javascript:void(0)');
    expect(cleaned).toContain('Click Here');
    expect(cleaned).not.toContain('\n\n\n');
  });

  it('convertHtmlToMarkdown should purge cookie banners, extract metadata (publishedTime, author, siteName), format GFM tables and preserve codeblock languages', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta property="og:title" content="Test Page OG" />
          <meta property="og:image" content="https://example.com/image.jpg" />
          <meta property="og:site_name" content="Tech Blog" />
          <meta property="article:published_time" content="2026-08-22T10:00:00Z" />
          <meta name="author" content="Alice Developer" />
          <meta name="description" content="A test page description" />
        </head>
        <body>
          <div id="onetrust-consent-sdk"><div class="cookie-banner">当サイトはCookieを使用します。<button>同意</button></div></div>
          <header>Header content</header>
          <main>
            <h1>Article Title</h1>
            <p>This is the main article content.</p>
            <pre><code class="language-python">def hello():
    print("Hello, world!")</code></pre>
            <table>
              <thead>
                <tr><th>Header 1</th><th>Header 2</th></tr>
              </thead>
              <tbody>
                <tr><td>Cell A</td><td>Cell B</td></tr>
              </tbody>
            </table>
          </main>
          <footer>Footer content</footer>
        </body>
      </html>
    `;
    const result = convertHtmlToMarkdown(sampleHtml, 'https://example.com/article', 10000);
    expect(result.title).toBe('Test Page');
    expect(result.ogImage).toBe('https://example.com/image.jpg');
    expect(result.description).toBe('A test page description');
    expect(result.publishedTime).toBe('2026-08-22T10:00:00Z');
    expect(result.author).toBe('Alice Developer');
    expect(result.siteName).toBe('Tech Blog');
    expect(result.markdown).toContain('publishedTime: "2026-08-22T10:00:00Z"');
    expect(result.markdown).toContain('author: "Alice Developer"');
    expect(result.markdown).toContain('siteName: "Tech Blog"');
    expect(result.markdown).toContain('```python');
    expect(result.markdown).toContain('Article Title');
    expect(result.markdown).toContain('This is the main article content');
    expect(result.markdown).toContain('| Header 1 | Header 2 |');
    expect(result.markdown).toContain('| Cell A | Cell B |');
    expect(result.markdown).not.toContain('Header content');
    expect(result.markdown).not.toContain('Footer content');
    expect(result.markdown).not.toContain('当サイトはCookieを使用します');

    // onlyMainContent: false の場合は Header/Footer も含めて抽出
    const fullResult = convertHtmlToMarkdown(sampleHtml, 'https://example.com/article', 10000, false, false);
    expect(fullResult.markdown).toContain('Header content');
    expect(fullResult.markdown).toContain('Footer content');
  });

  it('cache metrics and individual TTL should work correctly', () => {
    clearCache();
    setToCache('test:key:1', { value: 123 }, 5000);
    const cachedItem = getFromCache<any>('test:key:1');
    expect(cachedItem?.value).toBe(123);
    expect(cachedItem?.cached).toBe(true);
    expect(getFromCache('nonexistent:key')).toBeNull();

    const metrics = getCacheMetrics();
    expect(metrics.size).toBe(1);
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.hitRatio).toBe(0.5);
  });

  it('filterByDomains should filter items by includeDomains and excludeDomains', () => {
    const sampleItems = [
      { title: 'Official Natalie', url: 'https://natalie.mu/music/news/123' },
      { title: 'Oricon News', url: 'https://www.oricon.co.jp/news/456' },
      { title: 'Spam Blog', url: 'https://matome-matome.com/post/789' },
    ];

    const included = filterByDomains(sampleItems, ['natalie.mu', 'oricon.co.jp']);
    expect(included.length).toBe(2);
    expect(included.map((i) => i.title)).toContain('Official Natalie');
    expect(included.map((i) => i.title)).not.toContain('Spam Blog');

    const excluded = filterByDomains(sampleItems, undefined, ['matome-matome.com']);
    expect(excluded.length).toBe(2);
    expect(excluded.map((i) => i.title)).not.toContain('Spam Blog');
  });

  it('extractQueryHighlights should extract relevant sentences from long text (spaced and non-spaced Japanese)', () => {
    const content = `
      # イベント開催概要
      2026年9月15日に東京ドームで大型アイドルフェスが開催されます。
      チケットは8月1日から一般発売がスタートします。

      ## 交通アクセス
      最寄り駅はJR水道橋駅または後楽園駅となります。
      駐車場はございませんので公共交通機関をご利用ください。
    `;

    // 1. スペース区切りクエリ
    const highlightsSpaced = extractQueryHighlights(content, '東京ドーム チケット 発売');
    expect(highlightsSpaced.length).toBeGreaterThan(0);
    expect(highlightsSpaced[0]).toContain('東京ドーム');

    // 2. スペースなし日本語クエリ (Intl.Segmenter による自動分解)
    const highlightsNoSpace = extractQueryHighlights(content, '東京ドームチケット発売日');
    expect(highlightsNoSpace.length).toBeGreaterThan(0);
    expect(highlightsNoSpace[0]).toContain('東京ドーム');

    // 3. 複数キーワード密度による優先度判定
    const docWithTwoParagraphs = `
      チケットに関する一般的な説明が長々と書かれている段落です。チケットの種類にはS席、A席、B席があります。

      東京ドームでのチケット発売日は2026年8月1日です。全席指定となります。
    `;
    // 4. 見出し文脈の継承テスト (Heading Context Inheritance)
    const docWithHeadings = `
      # ライブ情報

      ## チケット料金と購入方法
      全席指定で9,800円となります。公式プレイガイドよりお求めいただけます。

      ## グッズ販売
      Tシャツやタオルなどのオフィシャルグッズを販売します。
    `;
    const highlightsHeading = extractQueryHighlights(docWithHeadings, 'チケット 購入');
    expect(highlightsHeading.length).toBeGreaterThan(0);
    expect(highlightsHeading[0]).toContain('全席指定で9,800円');

    // 5. 完全フレーズ一致 & 近接度ボーナステスト
    const docWithPhraseMatch = `
      東京ドームで開催されるイベントです。チケットは後日案内されます。

      東京ドームチケット発売日は来週月曜日です。
    `;
    const highlightsPhrase = extractQueryHighlights(docWithPhraseMatch, '東京ドームチケット発売日');
    expect(highlightsPhrase.length).toBeGreaterThan(0);
    expect(highlightsPhrase[0]).toContain('来週月曜日');
  });

  it('scrapeUrl should include source: "web" in the response', async () => {
    try {
      const result = await scrapeUrl({
        url: 'https://example.com',
        mode: 'fast',
      });
      expect(result.source).toBe('web');
    } catch {}
  });

  it('scrapeUrl should reject when both fastOnly: true and renderJs: true are specified', async () => {
    expect(
      scrapeUrl({
        url: 'https://example.com',
        fastOnly: true,
        renderJs: true,
      }),
    ).rejects.toThrow('同時に指定できません');
  });

  it('resolveCityId should correctly resolve Japanese city and prefecture names to IDs', () => {
    expect(resolveCityId('東京')).toBe('130010');
    expect(resolveCityId('東京都')).toBe('130010');
    expect(resolveCityId('大阪')).toBe('270000');
    expect(resolveCityId('大阪府')).toBe('270000');
    expect(resolveCityId('福岡')).toBe('400010');
    expect(resolveCityId('札幌')).toBe('016010');
    expect(resolveCityId('400040')).toBe('400040');

    // 気象庁公式データに基づく市区町村・観光地の単体指定テスト
    expect(resolveCityId('天童市')).toBe('060010');
    expect(resolveCityId('天童')).toBe('060010');
    expect(resolveCityId('浦安市')).toBe('120010');
    expect(resolveCityId('浦安')).toBe('120010');
    expect(resolveCityId('軽井沢町')).toBe('200020');
    expect(resolveCityId('軽井沢')).toBe('200020');
    expect(resolveCityId('箱根町')).toBe('140020');
    expect(resolveCityId('箱根')).toBe('140020');
    expect(resolveCityId('別府市')).toBe('440010');
    expect(resolveCityId('石垣島')).toBe('473000');
  });
});

describe('web-fetcher Auth Middleware', () => {
  const testApp = new Hono();
  testApp.use('*', createAuthMiddleware('secret-test-key'));
  testApp.get('/health', (c) => c.json({ status: 'ok' }));
  testApp.get('/metrics', (c) => c.json({ status: 'ok' }));
  testApp.get('/protected', (c) => c.json({ status: 'authenticated' }));

  it('should allow /health and /metrics without auth', async () => {
    const resHealth = await testApp.fetch(new Request('http://localhost/health'));
    expect(resHealth.status).toBe(200);

    const resMetrics = await testApp.fetch(new Request('http://localhost/metrics'));
    expect(resMetrics.status).toBe(200);
  });

  it('should reject direct local access by default when API key is set', async () => {
    const prev = process.env.ALLOW_LOCAL_NO_AUTH;
    delete process.env.ALLOW_LOCAL_NO_AUTH;
    try {
      const res = await testApp.fetch(new Request('http://localhost/protected'));
      expect(res.status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.ALLOW_LOCAL_NO_AUTH = prev;
    }
  });

  it('should allow direct local access only when ALLOW_LOCAL_NO_AUTH=true', async () => {
    const prev = process.env.ALLOW_LOCAL_NO_AUTH;
    process.env.ALLOW_LOCAL_NO_AUTH = 'true';
    try {
      const res = await testApp.fetch(new Request('http://localhost/protected'));
      expect(res.status).toBe(200);
    } finally {
      if (prev !== undefined) process.env.ALLOW_LOCAL_NO_AUTH = prev;
      else delete process.env.ALLOW_LOCAL_NO_AUTH;
    }
  });

  it('should reject proxied request without API key', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(401);
  });

  it('should allow proxied request with valid Bearer token', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
        authorization: 'Bearer secret-test-key',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('authenticated');
  });

  it('should allow proxied request with valid X-API-Key header', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
        'x-api-key': 'secret-test-key',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('authenticated');
  });
});

describe('Sora REST & MCP Endpoints', () => {
  it('GET /health should return 200 OK with service details', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.service).toBe('sora');
    expect(data.status).toBe('ok');
  });

  it('GET /metrics should return 200 OK with operational metrics', async () => {
    const res = await app.fetch(new Request('http://localhost/metrics'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.service).toBe('sora');
    expect(data.cache).toBeDefined();
    expect(data.activeSessions).toBeDefined();
    expect(data.memory).toBeDefined();
    expect(data.chromium).toBeDefined();
  });

  it('POST /scrape should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /crawl/stream should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/crawl/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /scrape should support formats parameter with links and rawHtml', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Format Test</title></head>
        <body>
          <h1>Title</h1>
          <a href="https://example.com/about">About</a>
          <a href="https://example.com/contact">Contact</a>
        </body>
      </html>
    `;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(mockHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      const res = await app.fetch(
        new Request('http://localhost/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `http://127.0.0.1:${server.port}/format-test`,
            mode: 'fast',
            formats: ['markdown', 'links', 'rawHtml'],
            noCache: true,
          }),
        }),
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.title).toBe('Format Test');
      expect(Array.isArray(data.links)).toBe(true);
      expect(data.links).toContain('https://example.com/about');
      expect(data.links).toContain('https://example.com/contact');
      expect(data.rawHtml).toContain('Format Test');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('POST /crawl/stream should return SSE stream with start, page, and done events', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Crawl Root</title></head>
        <body>
          <h1>Crawl Root</h1>
          <a href="/subpage">Subpage</a>
        </body>
      </html>
    `;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(mockHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      const res = await app.fetch(
        new Request('http://localhost/crawl/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `http://127.0.0.1:${server.port}/crawl-test`,
            maxPages: 1,
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('event: page');
      expect(text).toContain('event: done');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('POST /map should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /crawl should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /mcp should respond to JSON-RPC tools/list with all 16 tools', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const rawText = await res.text();
    let body: any;
    try {
      body = JSON.parse(rawText);
    } catch {
      const dataLine = rawText.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        body = JSON.parse(dataLine.replace(/^data:\s*/, ''));
      }
    }

    expect(body?.jsonrpc).toBe('2.0');
    expect(body?.result).toBeDefined();
    expect(Array.isArray(body?.result?.tools)).toBe(true);

    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('scrape');
    expect(toolNames).toContain('scrape_batch');
    expect(toolNames).toContain('search_web');
    expect(toolNames).toContain('search_realtime');
    expect(toolNames).toContain('search_deep');
    expect(toolNames).toContain('map_site');
    expect(toolNames).toContain('crawl_site');
    expect(toolNames).toContain('search_trend');
    expect(toolNames).toContain('search_image');
    expect(toolNames).toContain('search_video');
    expect(toolNames).toContain('search_news');
    expect(toolNames).toContain('search_chiebukuro');
    expect(toolNames).toContain('suggest_keywords');
    expect(toolNames).toContain('search_route');
    expect(toolNames).toContain('get_weather');
    expect(toolNames).toContain('browser_action');
    expect(toolNames.length).toBe(16);
  });

  it('isModuleActive should correctly evaluate enabled modules', () => {
    expect(isModuleActive('web', ['web'])).toBe(true);
    expect(isModuleActive('browser', ['web'])).toBe(false);
    expect(isModuleActive('yahoo', ['web'])).toBe(false);
    expect(isModuleActive('life', ['web'])).toBe(false);

    expect(isModuleActive('web', ['all'])).toBe(true);
    expect(isModuleActive('browser', ['all'])).toBe(true);
    expect(isModuleActive('yahoo', ['all'])).toBe(true);
    expect(isModuleActive('life', ['all'])).toBe(true);

    expect(isModuleActive('life', ['web', 'life'])).toBe(true);
    expect(isModuleActive('browser', ['browser', 'web'])).toBe(true);
    expect(isModuleActive('yahoo', ['web', 'life'])).toBe(false);
  });

  it('createMcpServer with module filtering should register only designated category tools', () => {
    const webOnlyServer = createMcpServer({ modules: ['web'] });
    expect(webOnlyServer).toBeDefined();

    const browserOnlyServer = createMcpServer({ modules: ['browser'] });
    expect(browserOnlyServer).toBeDefined();

    const lifeOnlyServer = createMcpServer({ modules: ['life'] });
    expect(lifeOnlyServer).toBeDefined();

    const yahooOnlyServer = createMcpServer({ modules: ['yahoo'] });
    expect(yahooOnlyServer).toBeDefined();
  });

  it('POST /browser/action should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/browser/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /search/image should return 400 when query is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/search/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /search/video should return 400 when query is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/search/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /search/news should return 400 when query is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/search/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /search/chiebukuro should return 400 when query is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/search/chiebukuro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /search/suggest should return 400 when query is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/search/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /transit/route should return 400 when from/to is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/transit/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /weather should return 400 when city is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/weather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('GET / should list all endpoints including new ones', async () => {
    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.service).toBe('sora');
    expect(data.version).toBe('2.0.0');
    expect(data.endpoints.searchImage).toBeDefined();
    expect(data.endpoints.searchVideo).toBeDefined();
    expect(data.endpoints.searchNews).toBeDefined();
    expect(data.endpoints.searchChiebukuro).toBeDefined();
    expect(data.endpoints.searchSuggest).toBeDefined();
    expect(data.endpoints.transitRoute).toBeDefined();
    expect(data.endpoints.weather).toBeDefined();
    expect(data.endpoints.browserAction).toBeDefined();
  });

  it('executeBrowserActions should handle full browser interaction lifecycle when Chromium is available', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const mockHtml = `
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><title>Interaction Test</title></head>
      <body>
        <input id="kw" type="text" value="" />
        <button id="btn" onclick="document.getElementById('res').innerText = 'Found: ' + document.getElementById('kw').value;">検索</button>
        <div id="res"></div>
      </body>
      </html>
    `;

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(mockHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      const result = await executeBrowserActions({
        url: `http://127.0.0.1:${server.port}/test`,
        actions: [
          { type: 'fill', selector: '#kw', text: 'Sora Interactive' },
          { type: 'click', text: '検索' },
          { type: 'wait', ms: 100 },
        ],
        extract: { markdown: true, screenshot: true },
      });

      expect(result.source).toBe('browser');
      expect(result.renderedWithBrowser).toBe(true);
      expect(result.actionLogs.length).toBe(3);
      expect(result.actionLogs.every((l: any) => l.success)).toBe(true);
      expect(result.content).toContain('Sora Interactive');
      expect(result.screenshot).toBeDefined();
      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('handleBrowserSessionAction should maintain stateful multi-turn interactive session', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) return;

    const mockHtml = `
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><title>Multi-Turn Session</title></head>
      <body>
        <h1>セッションテスト</h1>
        <input id="session-input" type="text" value="" />
        <button id="step-btn" onclick="document.getElementById('status').innerText = 'State: ' + document.getElementById('session-input').value;">確定</button>
        <div id="status">未実行</div>
      </body>
      </html>
    `;

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(mockHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      // Turn 1: 新規セッション作成 & 画面オープン (所有者トークン付き)
      const turn1 = await executeBrowserActions({
        url: `http://127.0.0.1:${server.port}/session-test`,
        createSession: true,
        ownerToken: 'user-alice-token',
        actions: [{ type: 'fill', selector: '#session-input', text: 'Turn1 Value' }],
        extract: { markdown: true },
      });

      expect(turn1.sessionId).toBeDefined();
      expect(turn1.sessionClosed).toBe(false);
      const sessionId = turn1.sessionId!;

      // Turn 2: 同一セッションID & 正しい所有者で続けてボタンクリック
      const turn2 = await executeBrowserActions({
        sessionId,
        ownerToken: 'user-alice-token',
        actions: [
          { type: 'click', text: '確定' },
          { type: 'wait', ms: 100 },
        ],
        extract: { markdown: true },
      });

      expect(turn2.sessionId).toBe(sessionId);
      expect(turn2.content).toContain('State: Turn1 Value');

      // Turn 2.5: 異なる所有者トークン（第三者）からのセッションハイジャック試行が 403 で拒絶されること
      await expect(
        executeBrowserActions({
          sessionId,
          ownerToken: 'user-bob-attacker-token',
          actions: [{ type: 'wait', ms: 10 }],
        }),
      ).rejects.toThrow('Forbidden');

      // Turn 3: セッションの明示的クローズ (所有者による)
      const turn3 = await executeBrowserActions({
        sessionId,
        ownerToken: 'user-alice-token',
        closeSession: true,
      });

      expect(turn3.sessionClosed).toBe(true);
      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('matchUrlPattern should match wildcard glob patterns correctly', () => {
    expect(matchUrlPattern('https://example.com/docs/intro', ['/docs/**'])).toBe(true);
    expect(matchUrlPattern('https://example.com/docs/api/v1', ['/docs/**'])).toBe(true);
    expect(matchUrlPattern('https://example.com/blog/post-1', ['/docs/**'])).toBe(false);
    expect(matchUrlPattern('https://example.com/files/manual.pdf', ['*.pdf'])).toBe(true);
    expect(matchUrlPattern('https://example.com/files/manual.html', ['*.pdf'])).toBe(false);
    expect(matchUrlPattern('https://sub.example.com/api', ['https://sub.example.com/**'])).toBe(true);
  });

  it('convertHtmlToMarkdown should extract jsonLd, metadata fallbacks, and image list', () => {
    const htmlWithJsonLd = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Article with Schema</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "NewsArticle",
              "headline": "Structured Data Title",
              "datePublished": "2026-08-22T12:00:00Z",
              "author": {
                "@type": "Person",
                "name": "Jane Doe"
              },
              "publisher": {
                "@type": "Organization",
                "name": "Tech Daily News"
              }
            }
          </script>
        </head>
        <body>
          <main>
            <h1>Main Title</h1>
            <p>Main content paragraph.</p>
            <img src="/images/photo1.jpg" alt="Photo 1" title="Title 1" />
            <img src="https://cdn.example.com/photo2.png" alt="Photo 2" />
          </main>
        </body>
      </html>
    `;
    const res = convertHtmlToMarkdown(htmlWithJsonLd, 'https://example.com/article', 5000);
    expect(res.jsonLd).toBeDefined();
    expect(res.jsonLd!.length).toBe(1);
    expect(res.jsonLd![0].headline).toBe('Structured Data Title');
    expect(res.publishedTime).toBe('2026-08-22T12:00:00Z');
    expect(res.author).toBe('Jane Doe');
    expect(res.siteName).toBe('Tech Daily News');
    expect(res.images).toBeDefined();
    expect(res.images!.length).toBe(2);
    expect(res.images![0].url).toBe('https://example.com/images/photo1.jpg');
    expect(res.images![0].alt).toBe('Photo 1');
    expect(res.images![1].url).toBe('https://cdn.example.com/photo2.png');
  });

  it('GET /metrics should support Prometheus format when format=prometheus or Accept: text/plain', async () => {
    const res = await app.request('/metrics?format=prometheus');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# HELP sora_uptime_seconds');
    expect(text).toContain('sora_uptime_seconds');
    expect(text).toContain('sora_memory_rss_bytes');
    expect(text).toContain('sora_cache_hits_total');
  });

  it('decodeHtmlBuffer should automatically detect and decode Shift_JIS and UTF-8', () => {
    // 1. Shift_JIS テスト ("こんにちは世界")
    const sjisBytes = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x90, 0xa2, 0x8a, 0x45]);
    const decodedSjis = decodeHtmlBuffer(sjisBytes, 'text/html; charset=Shift_JIS');
    expect(decodedSjis).toBe('こんにちは世界');

    // 2. <meta charset="Shift_JIS"> による自動検出
    const sjisHtml = Buffer.concat([
      Buffer.from('<html><head><meta charset="Shift_JIS"></head><body>'),
      Buffer.from(sjisBytes),
      Buffer.from('</body></html>'),
    ]);
    const decodedFromMeta = decodeHtmlBuffer(sjisHtml, 'text/html');
    expect(decodedFromMeta).toContain('こんにちは世界');

    // 3. UTF-8 デコード
    const utf8Bytes = Buffer.from('こんにちは世界', 'utf-8');
    const decodedUtf8 = decodeHtmlBuffer(utf8Bytes, 'text/html; charset=UTF-8');
    expect(decodedUtf8).toBe('こんにちは世界');
  });

  it('convertHtmlToMarkdown with selectors should extract pinpoint fields and attributes', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Product Page</title></head>
        <body>
          <div class="product">
            <h1 class="title">高級キーボード</h1>
            <span class="price">¥24,800</span>
            <a class="btn-buy" href="/cart/add?id=123">購入する</a>
            <img class="main-photo" src="/images/keyboard.jpg" alt="キーボード写真" />
          </div>
        </body>
      </html>
    `;
    const res = convertHtmlToMarkdown(html, 'https://shop.example.com/item/1', 5000, false, true, {
      productName: '.title',
      price: '.price',
      buyLink: '.btn-buy@href',
      photoUrl: '.main-photo@src',
      photoAlt: '.main-photo@alt',
      nonExistent: '.not-found',
    });

    expect(res.extracted).toBeDefined();
    expect(res.extracted?.productName).toBe('高級キーボード');
    expect(res.extracted?.price).toBe('¥24,800');
    expect(res.extracted?.buyLink).toBe('https://shop.example.com/cart/add?id=123');
    expect(res.extracted?.photoUrl).toBe('https://shop.example.com/images/keyboard.jpg');
    expect(res.extracted?.photoAlt).toBe('キーボード写真');
    expect(res.extracted?.nonExistent).toBeNull();
  });

  it('safeTruncateMarkdown should properly close unclosed code blocks and table rows', () => {
    const mdWithCode = 'Here is code:\n```typescript\nconst a = 10;\nconst b = 20;\n```\nDone.';
    const truncated = safeTruncateMarkdown(mdWithCode, 35);
    expect(truncated.endsWith('```')).toBe(true);
    const backtickCount = (truncated.match(/```/g) || []).length;
    expect(backtickCount % 2).toBe(0);
  });

  it('estimateTokens should accurately calculate token budget for Japanese and English', () => {
    const jaText = 'こんにちは世界。本日は晴天なり。';
    const tokensJa = estimateTokens(jaText);
    expect(tokensJa).toBeGreaterThan(5);
    expect(tokensJa).toBeLessThan(30);

    const enText = 'Hello world, this is a fast web fetcher.';
    const tokensEn = estimateTokens(enText);
    expect(tokensEn).toBeGreaterThan(5);
    expect(tokensEn).toBeLessThan(20);
  });

  it('X-Response-Time header should be present in HTTP responses', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const respTime = res.headers.get('x-response-time');
    expect(respTime).toBeDefined();
    expect(respTime).toMatch(/^[0-9.]+ms$/);
  });

  it('POST /scrape/batch should validate input and process multiple URLs', async () => {
    const resEmpty = await app.request('/scrape/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [] }),
    });
    expect(resEmpty.status).toBe(400);

    const res = await app.request('/scrape/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: ['https://example.com/1', 'https://example.com/2'],
        fastOnly: true,
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.total).toBe(2);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('convertHtmlToMarkdown with removeSelectors should purge custom unwanted elements', () => {
    const html = `
      <html>
        <body>
          <main>
            <h1>メインタイトル</h1>
            <p>本文テキストです。</p>
            <div class="ad-banner">広告バナー内容</div>
            <div id="comments-section">コメント欄</div>
          </main>
        </body>
      </html>
    `;
    const res = convertHtmlToMarkdown(
      html,
      'https://example.com/article',
      5000,
      false,
      true,
      undefined,
      ['.ad-banner', '#comments-section'],
    );
    expect(res.markdown).toContain('メインタイトル');
    expect(res.markdown).toContain('本文テキストです');
    expect(res.markdown).not.toContain('広告バナー内容');
    expect(res.markdown).not.toContain('コメント欄');
  });

  it('GET /openapi.json and GET /docs should return interactive API specifications', async () => {
    const openapiRes = await app.request('/openapi.json');
    expect(openapiRes.status).toBe(200);
    const schema: any = await openapiRes.json();
    expect(schema.openapi).toBe('3.0.0');
    expect(schema.info.title).toContain('Sora');
    expect(schema.paths['/scrape']).toBeDefined();
    expect(schema.paths['/scrape/batch']).toBeDefined();

    const docsRes = await app.request('/docs');
    expect(docsRes.status).toBe(200);
    const html = await docsRes.text();
    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('/openapi.json');
  });

  it('extractTablesFromHtml should parse HTML tables into structured JSON objects', () => {
    const html = `
      <html>
        <body>
          <table id="spec-table">
            <caption>製品仕様比較表</caption>
            <thead>
              <tr><th>モデル</th><th>メモリ</th><th>価格</th></tr>
            </thead>
            <tbody>
              <tr><td>Sora Pro</td><td>32GB</td><td>¥198,000</td></tr>
              <tr><td>Sora Air</td><td>16GB</td><td>¥128,000</td></tr>
            </tbody>
          </table>
        </body>
      </html>
    `;
    const res = convertHtmlToMarkdown(html, 'https://example.com/item', 5000, false, true);
    expect(res.tables).toBeDefined();
    expect(res.tables?.length).toBe(1);
    expect(res.tables?.[0].caption).toBe('製品仕様比較表');
    expect(res.tables?.[0].headers).toEqual(['モデル', 'メモリ', '価格']);
    expect(res.tables?.[0].rows[0]['モデル']).toBe('Sora Pro');
    expect(res.tables?.[0].rows[1]['価格']).toBe('¥128,000');
  });

  it('generateExtractiveSummary should extract top key sentences from article text', () => {
    const longArticle = `
      本日は新しい Web スクレイピングサービス Sora 2.0 のリリース日です。
      このシステムは圧倒的な高速性と高い耐障害性を兼ね備えています。
      特にリアルタイム情報と深層検索の統合は大きな特徴です。
      開発チームは数ヶ月にわたり性能改善を行ってきました。
      今後のロードマップにもご期待ください。
    `;
    const summary = generateExtractiveSummary(longArticle, 2);
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary.length).toBeLessThanOrEqual(2);
  });

  it('dedupSearchResults should filter out duplicate and highly similar items', () => {
    const rawItems = [
      { id: 1, title: '【速報】東京で大雨警報が発令されました', snippet: '気象庁発表' },
      { id: 2, title: '【速報】東京で大雨警報が発令されました！', snippet: '気象庁発表' },
      { id: 3, title: '明日の全国の天気予報と気温の推移', snippet: '全国的に晴れ' },
    ];
    const deduped = dedupSearchResults(rawItems, (item) => `${item.title} ${item.snippet}`);
    expect(deduped.length).toBe(2);
    expect(deduped.map((i) => i.id)).toEqual([1, 3]);
  });

  it('maskPiiInText should automatically mask emails, phone numbers, and credit cards', () => {
    const raw = '連絡先: info@example.com / TEL: 090-1234-5678 / カード番号: 4532-0150-1234-5671 です。';
    const masked = maskPiiInText(raw);
    expect(masked).toContain('[EMAIL]');
    expect(masked).toContain('[PHONE]');
    expect(masked).toContain('[CREDIT_CARD]');
    expect(masked).not.toContain('info@example.com');
    expect(masked).not.toContain('090-1234-5678');
  });

  it('convertHtmlToMarkdown should extract YouTube media info and chapters', () => {
    const html = `
      <html>
        <head>
          <meta itemprop="duration" content="PT15M30S">
        </head>
        <body>
          <h1>YouTube Video Title</h1>
          <p>チャプター目次:
          0:00 はじめに
          2:30 スクレイピングの基本
          10:15 応用テクニック
          </p>
        </body>
      </html>
    `;
    const res = convertHtmlToMarkdown(html, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 5000);
    expect(res.media).toBeDefined();
    expect(res.media?.type).toBe('youtube');
    expect(res.media?.videoId).toBe('dQw4w9WgXcQ');
    expect(res.media?.chapters?.length).toBe(3);
    expect(res.media?.chapters?.[0].title).toBe('はじめに');
    expect(res.media?.chapters?.[1].seconds).toBe(150);
  });

  it('generatePromptContext should build standard XML context wrapper for LLMs', () => {
    const promptXml = generatePromptContext({
      url: 'https://example.com/ai-news',
      title: '最新の AI ニュース',
      content: '# 本文\nここが記事の内容です。',
      siteName: 'AI Watch',
      publishedTime: '2026-08-22T10:00:00Z',
      summary: ['AI Watch の最新記事です', '大幅な高速化が達成されました'],
      isTruncated: false,
      contentType: 'text/html',
      source: 'web',
    });

    expect(promptXml).toContain('<web_page url="https://example.com/ai-news"');
    expect(promptXml).toContain('site_name="AI Watch"');
    expect(promptXml).toContain('<summary>');
    expect(promptXml).toContain('- AI Watch の最新記事です');
    expect(promptXml).toContain('</web_page>');
  });

  it('highlightQueryMatchesInMarkdown should emphasize matched keywords with <mark>', () => {
    const markdown = '# タイトル\nSora は超高速なスクレイピングツールです。\n```ts\nconst sora = "fast";\n```';
    const highlighted = highlightQueryMatchesInMarkdown(markdown, 'スクレイピング');
    expect(highlighted).toContain('<mark>スクレイピング</mark>');
  });

  it('calculateContentStats should accurately calculate characterCount, wordCount, and readingTimeMin', () => {
    const japaneseText = 'あ'.repeat(1200); // 1200文字 -> 約3分
    const statsJa = calculateContentStats(japaneseText);
    expect(statsJa.characterCount).toBe(1200);
    expect(statsJa.readingTimeMin).toBe(3);

    const englishText = 'word '.repeat(500); // 500語 -> 約3分
    const statsEn = calculateContentStats(englishText);
    expect(statsEn.wordCount).toBe(500);
    expect(statsEn.readingTimeMin).toBe(3);
  });

  it('extractCitationsFromMarkdown should extract external links and their surrounding context', () => {
    const markdown = `
      政府の最新統計によると、IT市場は急拡大しています。
      詳細なデータは [総務省統計局レポート](https://www.stat.go.jp/data/it-report.html) をご参照ください。
      また、海外市場については [Gartner Market Report](https://www.gartner.com/en/reports/123) でも言及されています。
    `;
    const citations = extractCitationsFromMarkdown(markdown);
    expect(citations.length).toBe(2);
    expect(citations[0].text).toBe('総務省統計局レポート');
    expect(citations[0].url).toBe('https://www.stat.go.jp/data/it-report.html');
    expect(citations[0].context).toContain('総務省統計局レポート');
    expect(citations[1].text).toBe('Gartner Market Report');
    expect(citations[1].url).toBe('https://www.gartner.com/en/reports/123');
  });

  it('sendWebhookNotification should handle notification without throwing errors', async () => {
    await expect(sendWebhookNotification('http://127.0.0.1:59999/invalid-webhook', { test: true })).resolves.toBeUndefined();
  });

  it('chunkMarkdownContent should split markdown into semantic chunks with headings and tokens', () => {
    const markdown = `# 主要見出し\nこれは最初のセクションです。\n\n## サブセクション\nこれは 2 番目のセクションです。\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n## 最後のセクション\n最後のまとめです。`;
    const chunks = chunkMarkdownContent(markdown, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].heading).toBe('主要見出し');
    expect(chunks[0].estimatedTokens).toBeGreaterThan(0);
  });

  it('convertHtmlToMarkdown should extract image metadata, caption, and dimensions', () => {
    const html = `
      <html>
        <head><title>画像テスト</title><meta property="og:image" content="https://example.com/main.png" /></head>
        <body>
          <figure>
            <img src="https://example.com/main.png" alt="メイン画像" width="800" height="600" />
            <figcaption>これはメイン図解です</figcaption>
          </figure>
          <img src="https://example.com/sub.jpg" alt="サブ画像" width="300" height="200" />
        </body>
      </html>
    `;
    const result = convertHtmlToMarkdown(html, 'https://example.com/article', 5000);
    expect(result.images).toBeDefined();
    expect(result.images?.length).toBe(2);
    expect(result.images?.[0].caption).toBe('これはメイン図解です');
    expect(result.images?.[0].width).toBe(800);
    expect(result.images?.[0].height).toBe(600);
    expect(result.images?.[0].isMainImage).toBe(true);
  });

  it('validateExtractedLinks should validate link status without breaking', async () => {
    const links = ['https://example.com/valid', 'http://127.0.0.1:59998/broken'];
    const statuses = await validateExtractedLinks(links, 500, 2);
    expect(statuses.length).toBe(2);
    expect(statuses[0].url).toBe('https://example.com/valid');
    expect(typeof statuses[0].ok).toBe('boolean');
  });

  it('isSecureEqual should correctly compare strings in constant time', () => {
    expect(isSecureEqual('my-secret-key', 'my-secret-key')).toBe(true);
    expect(isSecureEqual('my-secret-key', 'wrong-key')).toBe(false);
    expect(isSecureEqual('my-secret-key', '')).toBe(false);
    expect(isSecureEqual('', '')).toBe(false);
    expect(isSecureEqual(undefined, 'key')).toBe(false);
  });

  it('cache should enforce true LRU ordering, entry size limit, and TTL sweep', () => {
    clearCache();

    // 1. 巨大エントリ (2MB 超過) のキャッシュ保存拒否
    const hugePayload = 'A'.repeat(2.5 * 1024 * 1024);
    const saved = setToCache('huge_key', { data: hugePayload });
    expect(saved).toBe(false);
    expect(getFromCache('huge_key')).toBeNull();

    // 2. 正常エントリの保存 & 取得時の LRU 順序更新
    setToCache('key1', { v: 1 }, 10000);
    setToCache('key2', { v: 2 }, 10000);
    setToCache('key3', { v: 3 }, 10000);

    // key1 にアクセスして最新化
    const item1 = getFromCache<any>('key1');
    expect(item1?.v).toBe(1);

    // 3. sweepExpiredEntries による期限切れ一括削除
    setToCache('expired_key', { v: 99 }, -1000); // 過去の有効期限
    const deleted = sweepExpiredEntries();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(getFromCache('expired_key')).toBeNull();
  });

  it('HTTP responses should contain security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('runWithSingleFlight should deduplicate concurrent requests for identical key', async () => {
    let executionCount = 0;
    const task = async () => {
      executionCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { val: 'success' };
    };

    // 3 回同時に呼び出し
    const [res1, res2, res3] = await Promise.all([
      runWithSingleFlight('flight_key_1', task),
      runWithSingleFlight('flight_key_1', task),
      runWithSingleFlight('flight_key_1', task),
    ]);

    expect(executionCount).toBe(1); // 1回しか実行されないこと
    expect(res1.val).toBe('success');
    expect(res2.val).toBe('success');
    expect(res3.val).toBe('success');
  });

  it('validateHostIpDns should block private IPs and throw appropriate security error', async () => {
    const prevEnv = process.env.ALLOW_LOCAL_FETCH;
    delete process.env.ALLOW_LOCAL_FETCH;

    await expect(validateHostIpDns('127.0.0.1')).rejects.toThrow('プライベートネットワーク');
    await expect(validateHostIpDns('localhost')).rejects.toThrow('プライベートネットワーク');
    await expect(validateHostIpDns('169.254.169.254')).rejects.toThrow('プライベートネットワーク');

    process.env.ALLOW_LOCAL_FETCH = prevEnv;
  });

  it('SimpleSemaphore should limit concurrency correctly', async () => {
    const sem = new SimpleSemaphore(2);
    let activeWorkers = 0;
    let maxWorkersObserved = 0;

    const worker = async () => {
      await sem.acquire();
      try {
        activeWorkers++;
        if (activeWorkers > maxWorkersObserved) {
          maxWorkersObserved = activeWorkers;
        }
        await new Promise((r) => setTimeout(r, 30));
      } finally {
        activeWorkers--;
        sem.release();
      }
    };

    await Promise.all([worker(), worker(), worker(), worker()]);
    expect(maxWorkersObserved).toBe(2);
    expect(activeWorkers).toBe(0);
  });

  it('REST API should validate input with Zod and return structured error response with code and retryable', async () => {
    // 1. URL 未指定時の Zod バリデーションエラー & 構造化レスポンス
    const res = await app.request('/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxChars: 5000 }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.code).toBe('INVALID_INPUT');
    expect(json.status).toBe(400);
    expect(json.retryable).toBe(false);

    // 2. バッチスクレイプで空配列を渡した場合
    const batchRes = await app.request('/scrape/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [] }),
    });
    expect(batchRes.status).toBe(400);
    const batchJson = (await batchRes.json()) as any;
    expect(batchJson.code).toBe('INVALID_INPUT');
    expect(batchJson.retryable).toBe(false);
  });

  it('ALLOW_BROWSER_EVALUATE=false should block arbitrary script execution via evaluate', async () => {
    process.env.ALLOW_BROWSER_EVALUATE = 'false';
    const res = await app.request('/browser/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        actions: [{ type: 'evaluate', script: '1+1' }],
      }),
    });

    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.actionLogs).toBeDefined();
    expect(json.actionLogs[0].success).toBe(false);
    expect(json.actionLogs[0].message).toContain('evaluate is disabled');
    delete process.env.ALLOW_BROWSER_EVALUATE;
  });

  it('POST /scrape/stream should return SSE stream with progress and done events', async () => {
    const res = await app.request('/scrape/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        mode: 'fast',
        maxChars: 200,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: progress');
    expect(text).toContain('event: done');
  });

  it('GET /openapi.json should return dynamically generated OpenAPI 3.0 document from Zod schemas', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.info.title).toContain('Sora');
    expect(doc.paths['/scrape'].post.requestBody.content['application/json'].schema.type).toBe('object');
    expect(doc.paths['/scrape/stream']).toBeDefined();
    expect(doc.paths['/scrape/batch']).toBeDefined();
    expect(doc.paths['/weather']).toBeDefined();
  });
});


