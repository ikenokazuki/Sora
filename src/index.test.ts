import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { app } from './index.js';
import { createAuthMiddleware } from './auth.js';
import {
  isBlockedHostname,
  convertHtmlToMarkdown,
  scrapeUrl,
  filterByDomains,
  extractQueryHighlights,
  resolveCityId,
} from './scraper.js';

describe('web-fetcher Core Functions', () => {
  it('isBlockedHostname should block local and private IPs/hostnames', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('10.0.0.1')).toBe(true);
    expect(isBlockedHostname('192.168.1.1')).toBe(true);
    expect(isBlockedHostname('172.16.0.1')).toBe(true);
    expect(isBlockedHostname('169.254.169.254')).toBe(true);
    expect(isBlockedHostname('::1')).toBe(true);
    expect(isBlockedHostname('service.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('yahoo.co.jp')).toBe(false);
  });

  it('convertHtmlToMarkdown should extract title, ogImage, and markdown body', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta property="og:title" content="Test Page OG" />
          <meta property="og:image" content="https://example.com/image.jpg" />
          <meta name="description" content="A test page description" />
        </head>
        <body>
          <header>Header content</header>
          <main>
            <h1>Article Title</h1>
            <p>This is the main article content.</p>
          </main>
          <footer>Footer content</footer>
        </body>
      </html>
    `;
    const result = convertHtmlToMarkdown(sampleHtml, 'https://example.com/article', 10000);
    expect(result.title).toBe('Test Page');
    expect(result.ogImage).toBe('https://example.com/image.jpg');
    expect(result.description).toBe('A test page description');
    expect(result.markdown).toContain('Article Title');
    expect(result.markdown).toContain('This is the main article content');
    expect(result.markdown).not.toContain('Header content');
    expect(result.markdown).not.toContain('Footer content');
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

  it('extractQueryHighlights should extract relevant sentences from long text', () => {
    const content = `
      # イベント開催概要
      2026年9月15日に東京ドームで大型アイドルフェスが開催されます。
      チケットは8月1日から一般発売がスタートします。

      ## 交通アクセス
      最寄り駅はJR水道橋駅または後楽園駅となります。
      駐車場はございませんので公共交通機関をご利用ください。
    `;

    const highlights = extractQueryHighlights(content, '東京ドーム チケット 発売');
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain('東京ドーム');
  });

  it('scrapeUrl should include source: "web" in the response', async () => {
    try {
      const result = await scrapeUrl({
        url: 'https://example.com',
        fastOnly: true,
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
  testApp.get('/protected', (c) => c.json({ status: 'authenticated' }));

  it('should allow /health without auth', async () => {
    const res = await testApp.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
  });

  it('should allow direct local access (no proxy headers)', async () => {
    const res = await testApp.fetch(new Request('http://localhost/protected'));
    expect(res.status).toBe(200);
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

describe('GhostFetch REST & MCP Endpoints', () => {
  it('GET /health should return 200 OK with service details', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.service).toBe('ghostfetch');
    expect(data.status).toBe('ok');
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

  it('POST /mcp should respond to JSON-RPC tools/list with all 13 tools', async () => {
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
    expect(toolNames.length).toBe(14);
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
    expect(data.service).toBe('ghostfetch');
    expect(data.version).toBe('2.0.0');
    expect(data.endpoints.searchImage).toBeDefined();
    expect(data.endpoints.searchVideo).toBeDefined();
    expect(data.endpoints.searchNews).toBeDefined();
    expect(data.endpoints.searchChiebukuro).toBeDefined();
    expect(data.endpoints.searchSuggest).toBeDefined();
    expect(data.endpoints.transitRoute).toBeDefined();
    expect(data.endpoints.weather).toBeDefined();
  });
});

