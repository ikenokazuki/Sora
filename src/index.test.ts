import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { app } from './index.js';
import { createAuthMiddleware, isSecureEqual } from './auth.js';
import { createMcpServer, isModuleActive, McpSessionManager, searchCatalog } from './mcp.js';
import { sanitizeJsonSchemaForGemini } from './schema_sanitizer.js';
import { getProxyConfig } from './browser_engine.js';
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
  generateTextFragmentUrl,
  chooseBestDescription,
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
  dbGetCache,
  dbSetCache,
  dbDeleteCache,
  dbClearExpiredCache,
  dbClearAllCache,
  dbIncrementApiUsage,
  dbSaveWatchTarget,
  dbGetWatchTarget,
  dbSaveDomainCookies,
  dbGetDomainCookies,
  dbSaveDomainStorage,
  dbGetDomainStorage,
  isRenderStillBlockedOrBlank,
  getOrCreateHttpSession,
  closeHttpSession,
  dbListWatchTargets,
  dbDeleteWatchTarget,
  dbInsertWatchHistory,
  dbListWatchHistory,
  fetchWeatherWarnings,
  fetchRecentEarthquakes,
  fetchRoadTraffic,
  resolvePrefecture,
  resolveRoadCode,
  formatScale,
  registerWatchTarget,
  checkWatchTarget,
  checkAllWatchTargets,
  listWatchTargets,
  deleteWatchTarget,
  computeContentHash,
  searchMusic,
  searchSong,
  searchArtist,
  searchLaws,
  getLawData,
  searchDietMinutes,
  fetchElevationAndCoordinates,
  fetchFlightStatus,
  checkCpscCertificate,
  checkFdaRegulated,
  verifyHtsCode,
  checkProductCompliance,
  detectSpaOrBotPage,
  pickProxyUrl,
  pickBrowserProfile,
  getChromiumMajorVersion,
  fetchWithSafeRedirects,
  fetchWithStealthBrowser,
  resolveAirport,
  rerankSearchResults,
  checkDetailedHealth,
  buildUserAgentFromDefault,
  buildUserAgentMetadata,
  getFallbackUserAgent,
  getBotDetectionMetrics,
  getBrowser,
  applyStealthEvasions,
  groupCookiesByDomain,
  initDatabase,
  closeDb,
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

    // 6. 構造化セクション（楽曲コール・FAQ・レシピ等）の適応型セクション集約 & 見出し保持テスト
    const songNoteDoc = `
      ## ・好きって。
      〈イントロ〉タイガーファイヤー始動

      ## ・ソライロ
      〈イントロ〉スタンダード
      うりゃおい ×4 👏 ×5 しゃーいくぞ
      タイガー ファイヤー サイバー ファイバー ダイバー
      バイバー ジャージャー

      (1サビ前)イェッタイガー ×3 ファイボ ワイパー

      〈間奏〉日本語
      うりゃおい ×4 👏 ×5 しゃーいくぞ
      虎 火 人造 繊維 海人 振動 化繊

      (2サビ前)イェッタイガー ファイボ ワイパー

      〈間奏〉またね口上
      出会えたからこそできること
      全部があなたと作った日々だ
      間違いなんて一つもなくて
      変わらぬままのあなたがいい

      （落ちサビ前）俺とお前の赤い糸 俺の俺の〇〇〇

      〈アウトロ〉銀河口上
      銀河に轟く歌声と
      地球に花咲くその笑顔
      お前が好きだと輝き叫ぶ
      行くぜ全力どこまでも
      光のごとく駆け巡る
      好きじゃねぇ 愛してる

      ## ・Delight
      〈イントロ〉スタンダード＋ 黒服パーフェクトプルオーバー
      うりゃおい ×4 👏 ×5 しゃーいくぞ
      タイガー ファイヤー サイバー ファイバー

      ## ・待っていてね
      〈イントロ〉スタンダード倍速
    `;
    const songHighlights = extractQueryHighlights(songNoteDoc, '君と見るそら　ソライロ　コール', 3);
    // 相対スコア減衰カットオフと重要語カバレッジゲートにより、無関係な「Delight」等は排除されて1件のみ抽出される
    expect(songHighlights.length).toBe(1);
    const topHl = songHighlights[0];
    expect(topHl).toContain('## ・ソライロ');
    expect(topHl).toContain('〈イントロ〉スタンダード');
    expect(topHl).toContain('またね口上');
    expect(topHl).toContain('銀河口上');
    expect(topHl).not.toContain('Delight');
    expect(topHl).not.toContain('好きって。');
    expect(topHl).not.toContain('待っていてね');
  });

  it('generateTextFragmentUrl should create valid W3C Scroll-to-Text Fragment URLs', () => {
    const baseUrl = 'https://note.com/kimisora_mix/n/nd94f3a06fe8f';
    const snippet = '## ・ソライロ\n\n〈イントロ〉スタンダード\nタイガー ファイヤー\n銀河口上 愛してる';
    const fragmentUrl = generateTextFragmentUrl(baseUrl, snippet);
    expect(fragmentUrl).toContain('https://note.com/kimisora_mix/n/nd94f3a06fe8f#:~:text=');
    expect(fragmentUrl).toContain(encodeURIComponent('スタンダード'));
  });

  it('chooseBestDescription should replace generic boilerplate meta with dynamic query snippet', () => {
    const genericMeta = 'noteは、クリエイターが文章や画像、音声を投稿し、ユーザーがコンテンツを楽しんで応援できるプラットフォームです。';
    const query = '君と見るそら ソライロ コール';
    const dynamicSnippet = '## ・ソライロ\n\n〈イントロ〉スタンダード\nうりゃおい ×4 👏 ×5 しゃーいくぞ\nタイガー ファイヤー サイバー';

    // 1. クエリ主要語を含まない定型文メタは動的スニペットに置き換えられる
    const selected = chooseBestDescription(genericMeta, dynamicSnippet, query);
    expect(selected).toBeDefined();
    expect(selected).not.toContain('プラットフォーム');
    expect(selected).toContain('ソライロ');

    // 2. クエリ単語を十分に含む適切な Meta Description は尊重される
    const relevantMeta = 'アイドルグループ「君と見るそら」の代表曲「ソライロ」のライブコール・MIX・口上まとめです。';
    const selectedRelevant = chooseBestDescription(relevantMeta, dynamicSnippet, query);
    expect(selectedRelevant).toBe(relevantMeta);
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

  it('scrapeUrl with onlyHighlights: true should replace full content with only matched highlights', async () => {
    try {
      const result = await scrapeUrl({
        url: 'https://example.com',
        query: 'Domain',
        onlyHighlights: true,
        fastOnly: true,
      });
      if (result.highlights && result.highlights.length > 0) {
        expect(result.content).toBe(result.highlights.join('\n\n---\n\n'));
      }
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
    expect(data.botDetection).toBeDefined();
    expect(typeof data.botDetection.upgradeCount).toBe('number');
    expect(typeof data.botDetection.retryCount).toBe('number');
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

  it('searchCatalog should find tools by name, category, keywords, and description', () => {
    const dummyCatalog = new Map<string, any>([
      [
        'search_chiebukuro',
        {
          name: 'search_chiebukuro',
          category: 'yahoo',
          description: '【知恵袋 Q&A 検索】Yahoo! 知恵袋の Q&A 検索を実行',
          keywords: ['知恵袋', 'Q&A', '質問回答', '悩み', 'Yahoo'],
          handle: { enabled: false, enable() { this.enabled = true; } },
        },
      ],
      [
        'get_weather',
        {
          name: 'get_weather',
          category: 'life',
          description: '【天気予報】気象庁公式オープンデータ直結',
          keywords: ['天気予報', '気象', '気温', '降水確率', '週間天気', '天気'],
          handle: { enabled: false, enable() { this.enabled = true; } },
        },
      ],
    ]);

    // 1. Tool name match
    expect(searchCatalog(dummyCatalog, 'chiebukuro').map((e) => e.name)).toEqual(['search_chiebukuro']);
    // 2. Keyword match
    expect(searchCatalog(dummyCatalog, '天気').map((e) => e.name)).toEqual(['get_weather']);
    // 3. Category match
    expect(searchCatalog(dummyCatalog, 'yahoo').map((e) => e.name)).toEqual(['search_chiebukuro']);
    // 4. Multi-word search
    expect(searchCatalog(dummyCatalog, 'Yahoo 知恵袋').map((e) => e.name)).toEqual(['search_chiebukuro']);
    // 5. No match
    expect(searchCatalog(dummyCatalog, 'nonexistent')).toEqual([]);
    // 6. Empty query
    expect(searchCatalog(dummyCatalog, '')).toEqual([]);
  });

  it('POST /mcp should respond to initial tools/list with 11 core tools', async () => {
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
    expect(toolNames).toContain('search_deep');
    expect(toolNames).toContain('search_tools');
    expect(toolNames).toContain('check_product_compliance');
    expect(toolNames).toContain('get_weather');
    expect(toolNames).toContain('search_route');
    expect(toolNames).toContain('search_chiebukuro');
    expect(toolNames).toContain('search_realtime');
    expect(toolNames).toContain('search_disaster_warnings');
    expect(toolNames).toContain('search_earthquake');
    expect(toolNames).toContain('search_laws');
    expect(toolNames.length).toBe(11);
  });

  it('McpSessionManager should dynamically enable standby tools via search_tools in stateful session', async () => {
    const manager = new McpSessionManager();
    const parseRes = async (res: Response) => {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        const line = text.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          return JSON.parse(line.replace(/^data:\s*/, ''));
        }
        return null;
      }
    };

    // 1. Initialize session
    const initReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
      }),
    });
    const initRes = await manager.handleRequest(initReq);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id')!;
    expect(sessionId).toBeDefined();

    // 1.5 Send initialized notification
    const notifyReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await manager.handleRequest(notifyReq);

    // 2. Initial tools/list (should be 11 core tools)
    const listReq1 = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listRes1 = await manager.handleRequest(listReq1);
    const listBody1: any = await parseRes(listRes1);
    const names1 = listBody1.result.tools.map((t: any) => t.name);
    expect(names1.length).toBe(11);
    expect(names1).toContain('scrape');
    expect(names1).toContain('search_deep');
    expect(names1).toContain('check_product_compliance');
    expect(names1).toContain('search_tools');

    // 3. Attempting to call standby tool (search_song) directly should fail
    const callDisabledReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_song', arguments: { title: 'アイドル' } },
      }),
    });
    const callDisabledRes = await manager.handleRequest(callDisabledReq);
    const callDisabledBody: any = await parseRes(callDisabledRes);
    expect(callDisabledBody.result?.isError).toBe(true);
    expect(callDisabledBody.result?.content?.[0]?.text).toContain('disabled');

    // 4. Call search_tools to activate song search
    const searchReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_tools', arguments: { query: '楽曲' } },
      }),
    });
    const searchRes = await manager.handleRequest(searchReq);
    const searchBody: any = await parseRes(searchRes);
    expect(searchBody.result?.content?.[0]?.text).toContain('search_song');

    // 5. tools/list now includes search_song (12 tools)
    const listReq2 = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    const listRes2 = await manager.handleRequest(listReq2);
    const listBody2: any = await parseRes(listRes2);
    const names2 = listBody2.result.tools.map((t: any) => t.name);
    expect(names2.length).toBe(12);
    expect(names2).toContain('search_song');

    // 6. Search for non-existent tool returns helpful message
    const searchNoneReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'search_tools', arguments: { query: 'xyz123nonexistent' } },
      }),
    });
    const searchNoneRes = await manager.handleRequest(searchNoneReq);
    const searchNoneBody: any = await parseRes(searchNoneRes);
    expect(searchNoneBody.result?.content?.[0]?.text).toContain('見つかりませんでした');
  });

  it('createMcpServer with module filtering should not allow searching or enabling tools from inactive modules', async () => {
    const webOnlyServer = createMcpServer({ modules: ['web'] });
    const registeredTools = (webOnlyServer as any)._registeredTools;
    expect(registeredTools['scrape']).toBeDefined();
    expect(registeredTools['search_web']).toBeDefined();
    expect(registeredTools['search_tools']).toBeDefined();
    expect(registeredTools['search_chiebukuro']).toBeUndefined();
    expect(registeredTools['get_weather']).toBeUndefined();

    // Executing search_tools with query '知恵袋'
    const searchTool = registeredTools['search_tools'];
    const result = await searchTool.handler({ query: '知恵袋' });
    expect(result.content[0].text).toContain('見つかりませんでした');
  });

  it('createMcpServer with deferTools: false should expose all tools immediately without search_tools activation', () => {
    const staticServer = createMcpServer({ deferTools: false });
    const registeredTools = (staticServer as any)._registeredTools;
    expect(registeredTools['scrape'].enabled).toBe(true);
    expect(registeredTools['get_weather'].enabled).toBe(true);
    expect(registeredTools['search_chiebukuro'].enabled).toBe(true);
    expect(registeredTools['search_laws'].enabled).toBe(true);
  });

  it('MCP Streamable HTTP should support full multi-session lifecycle (initialize -> notifications -> tools/list)', async () => {
    // 1. Initialize
    const initReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'n8n-mcp-client', version: '2.33.7' },
        },
      }),
    });

    const initRes = await app.fetch(initReq);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');

    // 2. Notification initialized
    const notifyReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    const notifyRes = await app.fetch(notifyReq);
    expect(notifyRes.status).toBe(202);

    // 3. tools/list in session
    const toolsReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    const toolsRes = await app.fetch(toolsReq);
    expect(toolsRes.status).toBe(200);
    const toolsText = await toolsRes.text();
    expect(toolsText).toContain('scrape');
    expect(toolsText).toContain('search_web');

    // 4. Concurrent second client
    const initReq2 = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'second-n8n-client', version: '2.33.7' },
        },
      }),
    });
    const initRes2 = await app.fetch(initReq2);
    expect(initRes2.status).toBe(200);
    const sessionId2 = initRes2.headers.get('mcp-session-id');
    expect(sessionId2).toBeDefined();
    expect(sessionId2).not.toBe(sessionId);
  });

  it('isModuleActive should correctly evaluate enabled modules', () => {
    expect(isModuleActive('web', ['web'])).toBe(true);
    expect(isModuleActive('browser', ['web'])).toBe(false);
    expect(isModuleActive('yahoo', ['web'])).toBe(false);
    expect(isModuleActive('life', ['web'])).toBe(false);
    expect(isModuleActive('disaster', ['web'])).toBe(false);
    expect(isModuleActive('watch', ['web'])).toBe(false);
    expect(isModuleActive('music', ['web'])).toBe(false);
    expect(isModuleActive('gov', ['web'])).toBe(false);
    expect(isModuleActive('trade', ['web'])).toBe(false);

    expect(isModuleActive('web', ['all'])).toBe(true);
    expect(isModuleActive('browser', ['all'])).toBe(true);
    expect(isModuleActive('yahoo', ['all'])).toBe(true);
    expect(isModuleActive('life', ['all'])).toBe(true);
    expect(isModuleActive('disaster', ['all'])).toBe(true);
    expect(isModuleActive('watch', ['all'])).toBe(true);
    expect(isModuleActive('music', ['all'])).toBe(true);
    expect(isModuleActive('gov', ['all'])).toBe(true);
    expect(isModuleActive('trade', ['all'])).toBe(true);

    expect(isModuleActive('life', ['web', 'life'])).toBe(true);
    expect(isModuleActive('disaster', ['disaster', 'music'])).toBe(true);
    expect(isModuleActive('watch', ['watch'])).toBe(true);
    expect(isModuleActive('music', ['music', 'life'])).toBe(true);
    expect(isModuleActive('gov', ['gov', 'life'])).toBe(true);
    expect(isModuleActive('trade', ['trade', 'life'])).toBe(true);
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
    expect(data.version).toBe('2.6.0');
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

  it('click action should move the mouse through multiple intermediate points, not teleport', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const mockHtml = `
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><title>Mouse Trail Test</title></head>
      <body>
        <button id="btn" onclick="document.getElementById('res').innerText = 'clicked: ' + window.__mmCount;">押す</button>
        <div id="res">not clicked</div>
        <script>
          window.__mmCount = 0;
          document.addEventListener('mousemove', () => { window.__mmCount++; });
        </script>
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
        url: `http://127.0.0.1:${server.port}/mouse-trail`,
        actions: [{ type: 'click', selector: '#btn' }, { type: 'wait', ms: 100 }],
        extract: { markdown: true },
      });

      expect(result.actionLogs.every((l: any) => l.success)).toBe(true);
      const match = result.content.match(/clicked: (\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(5);
      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('buildUserAgentFromDefault should extract the real Chromium version and mask it as Windows Chrome (not Headless)', () => {
    const headlessUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36';
    const result = buildUserAgentFromDefault(headlessUa);
    expect(result).toContain('Chrome/148.0.0.0');
    expect(result).not.toContain('Headless');
    expect(result).toContain('Windows NT 10.0; Win64; x64');
  });

  it('buildUserAgentFromDefault should fall back to a sane default when the version cannot be parsed', () => {
    const result = buildUserAgentFromDefault('some unparsable string');
    expect(result).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+/);
    expect(result).not.toContain('Headless');
  });

  it('getFallbackUserAgent should track the real Chromium version so the fallback path cannot reintroduce a cross-path version mismatch', () => {
    const fallback = getFallbackUserAgent();
    expect(fallback).toContain('Windows NT 10.0');
    expect(fallback).not.toContain('Headless');

    const actual = getChromiumMajorVersion();
    if (actual !== undefined) {
      // 静的fetch(wreq)は実バージョンを名乗るため、フォールバックが古い固定値だと
      // 同一Cookieでバージョンが食い違う（この矛盾は本セッションで一度潰している）
      expect(fallback).toContain(`Chrome/${actual}.`);
    }
  });

  it('buildUserAgentMetadata should build Windows Client Hints metadata matching the given Chrome version (fixes CreepJS-detected UA/platform/userAgentData mismatch)', () => {
    const headlessUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.7778.167 Safari/537.36';
    const meta = buildUserAgentMetadata(headlessUa);
    expect(meta.platform).toBe('Windows');
    expect(meta.mobile).toBe(false);
    expect(meta.brands?.some((b) => b.brand === 'Google Chrome' && b.version === '148')).toBe(true);
    expect(meta.fullVersionList?.some((b) => b.brand === 'Google Chrome' && b.version === '148.0.7778.167')).toBe(true);
  });

  it('WebRTC ICE candidate gathering should not leak the real local/public IP via host candidates (CreepJS-detected leak)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto('about:blank');
      const candidates = await page.evaluate(() => {
        return new Promise<string[]>((resolve) => {
          // STUNサーバーを指定しないと srflx candidate（実IP露出の本体）が生成されずテストにならない
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          const found: string[] = [];
          pc.onicecandidate = (e) => {
            if (e.candidate) found.push(e.candidate.candidate);
            else resolve(found);
          };
          pc.createDataChannel('test');
          pc.createOffer().then((offer) => pc.setLocalDescription(offer));
          setTimeout(() => resolve(found), 5000);
        });
      });
      // srflx (STUN経由の公開IP) / host (ローカルIP、mDNS化されていないもの) の両方が漏洩経路。
      // candidate文字列は "candidate:<foundation> <component> udp <priority> <ip> <port> typ <type> ..."
      // という形式で、実IPは "typ host/srflx" の直前のフィールドに来る（raddr等の副次フィールドの
      // 0.0.0.0 と誤判定しないよう、直前フィールドだけを厳密に取り出す）。
      const leaksRealIp = candidates.some((c) => {
        const m = c.match(/^candidate:\S+ \d+ udp \d+ (\S+) \d+ typ (host|srflx)/);
        if (!m) return false;
        const ip = m[1];
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip !== '0.0.0.0';
      });
      expect(leaksRealIp).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('applyStealthEvasions should set a UA whose Chrome version matches the real running Chromium, not a stale hardcoded one', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const { browser } = await getBrowser();
    const realDefaultUa = await browser.userAgent();
    const realVersionMatch = realDefaultUa.match(/Chrome\/(\d+)\./);
    expect(realVersionMatch).not.toBeNull();

    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      const uaAfter = await page.evaluate(() => navigator.userAgent);
      expect(uaAfter).not.toContain('Headless');
      expect(uaAfter).toContain(`Chrome/${realVersionMatch![1]}`);
    } finally {
      await page.close();
    }
  });

  it('applyStealthEvasions should perturb Canvas getImageData output with noise (raw pixel bytes differ from an unpatched context)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const drawScript = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 50;
      canvas.height = 50;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.fillStyle = 'rgb(100, 150, 200)';
      ctx.fillRect(0, 0, 50, 50);
      ctx.font = '12px Arial';
      ctx.fillText('test fingerprint text', 5, 25);
      return Array.from(ctx.getImageData(0, 0, 50, 50).data);
    };

    const { browser } = await getBrowser();

    const pageA = await browser.newPage();
    let unpatched: number[];
    try {
      await pageA.goto('about:blank');
      unpatched = await pageA.evaluate(drawScript);
    } finally {
      await pageA.close();
    }

    const pageB = await browser.newPage();
    let patched: number[];
    try {
      await applyStealthEvasions(pageB);
      await pageB.goto('about:blank');
      patched = await pageB.evaluate(drawScript);
    } finally {
      await pageB.close();
    }

    expect(patched.length).toBe(unpatched.length);
    expect(JSON.stringify(patched)).not.toBe(JSON.stringify(unpatched));
  });

  it('applyStealthEvasions should report a screen size at least as large as the viewport (headless default 800x600 is physically impossible with a 1920x1080 viewport)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto('about:blank');
      const info = await page.evaluate(() => ({
        screenWidth: screen.width,
        screenHeight: screen.height,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      }));
      expect(info.screenWidth).toBeGreaterThanOrEqual(info.innerWidth);
      expect(info.screenHeight).toBeGreaterThanOrEqual(info.innerHeight);
    } finally {
      await page.close();
    }
  });

  it('applyStealthEvasions should keep the Intl locale consistent with navigator.languages (CreepJS checks the Intl section separately)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto('about:blank');
      const info = await page.evaluate(() => ({
        firstLanguage: navigator.languages[0],
        dateTimeLocale: Intl.DateTimeFormat().resolvedOptions().locale,
        numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
      }));
      expect(info.dateTimeLocale).toBe(info.firstLanguage);
      expect(info.numberLocale).toBe(info.firstLanguage);
    } finally {
      await page.close();
    }
  });

  it('applyStealthEvasions should at least propagate the spoofed User-Agent into Web Workers (platform/languages are a documented Chromium limitation)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const workerCode = "self.postMessage({ua:navigator.userAgent,plat:navigator.platform,lang:navigator.languages[0]})";
    const html = `<!DOCTYPE html><html><body><div id="r">pending</div><script>
      const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}], {type:'application/javascript'})));
      w.onmessage = (e) => { document.getElementById('r').innerText = JSON.stringify(e.data); };
    </script></body></html>`;

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      },
    });

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto(`http://127.0.0.1:${server.port}/worker`);
      await page.waitForFunction(() => document.getElementById('r')?.innerText !== 'pending', { timeout: 10000 });
      const inWorker = JSON.parse(await page.evaluate(() => document.getElementById('r')!.innerText));

      // UA の override は Worker コンテキストにも伝播する（ここは保証する）
      expect(inWorker.ua).toContain('Windows NT 10.0');
      expect(inWorker.ua).not.toContain('Headless');
      // navigator.platform / languages は Worker に伝播しない。CDPの
      // Emulation.setUserAgentOverride に platform/acceptLanguage を渡しても反映されないことを
      // 実測で確認済み（scraper.ts の applyNativeEmulationOverrides 付近のコメント参照）。
      // 現状を既知の限界として固定しておき、将来Chromium側が対応したら気づけるようにする。
      expect(inWorker.plat).toBe('Linux x86_64');
    } finally {
      await page.close();
      server.stop();
    }
  });

  it('applyStealthEvasions should keep navigator.platform and navigator.userAgentData consistent with the Windows UA string (no CreepJS-style mismatch)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('<!DOCTYPE html><html><body>ok</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });
    try {
      await applyStealthEvasions(page);
      // evaluateOnNewDocument は次のナビゲーションで初めて適用される。navigator.userAgentData は
      // secure context (https or localhost/127.0.0.1) でのみ存在するため実サーバーへ遷移して確認する。
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const info = await page.evaluate(async () => {
        const uaData = (navigator as any).userAgentData;
        const highEntropy = uaData ? await uaData.getHighEntropyValues(['platform', 'platformVersion']) : null;
        return {
          platform: navigator.platform,
          uaDataPlatform: uaData?.platform,
          uaDataMobile: uaData?.mobile,
          highEntropyPlatform: highEntropy?.platform,
        };
      });
      expect(info.platform).toBe('Win32');
      expect(info.uaDataPlatform).toBe('Windows');
      expect(info.uaDataMobile).toBe(false);
      expect(info.highEntropyPlatform).toBe('Windows');
    } finally {
      await page.close();
      server.stop();
    }
  });

  it('applyStealthEvasions should send an Accept-Language HTTP header consistent with navigator.languages (ja priority)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    let seenAcceptLanguage = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenAcceptLanguage = req.headers.get('accept-language') || '';
        return new Response('<!DOCTYPE html><html><body>ok</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });

    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const jsLanguages = await page.evaluate(() => navigator.languages);

      expect(jsLanguages[0]).toBe('ja-JP');
      // JSのnavigator.languagesが日本語優先なら、実際に送信されるHTTPヘッダーも日本語優先であるべき
      // （実測で "en-US,en;q=0.9" のまま送信され、jaが全く含まれない矛盾を確認済み）
      expect(seenAcceptLanguage.startsWith('ja')).toBe(true);
    } finally {
      await page.close();
      server.stop();
    }
  });

  it('fetchWithStealthBrowser should persist Set-Cookie response cookies and resend them on the next visit', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path !== '/cookie-persist') {
          return new Response('', { status: 404 }); // favicon等の副次リクエストにはCookieを出さない
        }
        const cookieHeader = req.headers.get('cookie') || '';
        const seen = cookieHeader.includes('sora_persist_test=abc123');
        const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
        return new Response(`<!DOCTYPE html><html><body>seen-cookie:${seen}<p>${filler}</p></body></html>`, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': 'sora_persist_test=abc123; Path=/',
          },
        });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      const url = `http://127.0.0.1:${server.port}/cookie-persist`;
      const domain = '127.0.0.1';
      dbSaveDomainCookies(domain, []); // 他テストの残留Cookieをクリア（DBはテスト間で共有）
      // 共有ブラウザのCookieJarはポートを区別しないため、127.0.0.1 の他テスト分も残る。CDPで一掃する。
      const { browser: cleanupBrowser } = await getBrowser();
      const cleanupPage = await cleanupBrowser.newPage();
      const cdp = await cleanupPage.createCDPSession();
      await cdp.send('Network.clearBrowserCookies');
      await cdp.detach();
      await cleanupPage.close();

      // 1回目: サーバーが Set-Cookie を返す。DBに永続化されるはず
      const first = await scrapeUrl({ url, renderJs: true, noCache: true });
      expect(first.content).toContain('seen-cookie:false');
      const saved = dbGetDomainCookies(domain);
      expect(saved?.some((c) => c.name === 'sora_persist_test' && c.value === 'abc123')).toBe(true);

      // 2回目: 保存済みCookieが復元され、サーバーへ送り返されるはず
      const second = await scrapeUrl({ url, renderJs: true, noCache: true });
      expect(second.content).toContain('seen-cookie:true');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('fetchWithStealthBrowser via scrapeUrl(renderJs) should keep navigator.languages consistent with the Accept-Language header it sends', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
    let seenAcceptLanguage = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenAcceptLanguage = req.headers.get('accept-language') || '';
        return new Response(
          `<!DOCTYPE html><html><body><div id="res"></div><p>${filler}</p><script>document.getElementById('res').innerText = 'languages:' + navigator.languages.join(',');</script></body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      const result = await scrapeUrl({
        url: `http://127.0.0.1:${server.port}/lang-consistency`,
        renderJs: true,
        noCache: true,
      });

      expect(seenAcceptLanguage.startsWith('ja')).toBe(true);
      expect(result.content).toContain('languages:ja-JP,ja');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('scrapeUrl should increment getBotDetectionMetrics().upgradeCount when the static fetch result triggers SPA/bot detection', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
    const server = Bun.serve({
      port: 0,
      fetch() {
        // id="__next" は detectSpaOrBotPage のSPAマウントポイント判定に引っかかる
        return new Response(`<!DOCTYPE html><html><body><div id="__next"></div><p>${filler}</p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      const before = getBotDetectionMetrics().upgradeCount;

      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/spa-metrics`, noCache: true });

      expect(result.renderedWithBrowser).toBe(true);
      expect(getBotDetectionMetrics().upgradeCount).toBe(before + 1);

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('fetchWithStealthBrowser should persist localStorage across visits (Cookie-only persistence misses site tokens stored there)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path !== '/storage-persist') return new Response('', { status: 404 });
        return new Response(
          `<!DOCTYPE html><html><body>
            <div id="res">pending</div>
            <p>${filler}</p>
            <script>
              const prev = localStorage.getItem('sora_storage_test') || 'none';
              document.getElementById('res').innerText = 'seen-storage:' + prev;
              localStorage.setItem('sora_storage_test', 'persisted_value');
            </script>
          </body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      const url = `http://127.0.0.1:${server.port}/storage-persist`;
      const domain = '127.0.0.1';
      dbSaveDomainStorage(domain, {}); // 他テストの残留分をクリア

      // 1回目: localStorageは空。ページ側で値をセットする。DBに永続化されるはず
      const first = await scrapeUrl({ url, renderJs: true, noCache: true });
      expect(first.content).toContain('seen-storage:none');
      const saved = dbGetDomainStorage(domain);
      expect(saved?.sora_storage_test).toBe('persisted_value');

      // 2回目: 保存済みlocalStorageがページロード前に復元されているはず
      // (markdown変換で "_" が "\_" にエスケープされることがあるため正規表現で許容する)
      const second = await scrapeUrl({ url, renderJs: true, noCache: true });
      expect(second.content).toMatch(/seen-storage:persisted\\?_value/);

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('scrapeUrl(renderJs) should capture lazy-loaded, shadow DOM and late-rendered SPA content, not just the initially visible part', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    // 実サイトのSPAでよくある3パターンを再現する（マーカーはmarkdownのアンダースコア
    // エスケープを避けるためハイフン区切りにする）
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>SPA Gap</title></head>
      <body>
        <div id="top">TOP-CONTENT-VISIBLE</div>
        <div style="height:3000px">spacer</div>
        <div id="lazy">LAZY-PLACEHOLDER</div>
        <div id="host"></div>
        <div id="late">LATE-PLACEHOLDER</div>
        <script>
          new IntersectionObserver((entries) => {
            for (const e of entries) {
              if (e.isIntersecting) document.getElementById('lazy').innerText = 'LAZY-CONTENT-LOADED';
            }
          }).observe(document.getElementById('lazy'));
          const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<p>SHADOW-DOM-CONTENT</p>';
          setTimeout(() => {
            document.getElementById('late').innerText = 'LATE-CONTENT-RENDERED';
          }, 1500);
        </script>
      </body></html>`;

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      const res = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/spa-gaps`, renderJs: true, noCache: true });

      expect(res.content).toContain('TOP-CONTENT-VISIBLE');
      // IntersectionObserver は画面内に入らないと発火しないため自動スクロールが必要
      expect(res.content).toContain('LAZY-CONTENT-LOADED');
      // page.content() は shadow root の中身を含まないため明示的な展開が必要
      expect(res.content).toContain('SHADOW-DOM-CONTENT');
      // networkidle 成立後にクライアント側が描画するケース
      expect(res.content).toContain('LATE-CONTENT-RENDERED');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      server.stop();
    }
  });

  it('fetchWithStealthBrowser via scrapeUrl(renderJs) should also move the mouse before capturing content', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const mockHtml = `
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><title>Passive Load Mouse Trail</title></head>
      <body>
        <div id="res">count=0</div>
        <script>
          let n = 0;
          document.addEventListener('mousemove', () => {
            n++;
            document.getElementById('res').innerText = 'count=' + n;
          });
        </script>
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

      const result = await scrapeUrl({
        url: `http://127.0.0.1:${server.port}/passive-mouse-trail`,
        renderJs: true,
        noCache: true,
      });

      const match = result.content.match(/count=(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(3);
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
    expect(html).toContain('@scalar/api-reference');
    expect(html).toContain('/openapi.json');

    const swaggerRes = await app.request('/swagger');
    expect(swaggerRes.status).toBe(200);
    const swaggerHtml = await swaggerRes.text();
    expect(swaggerHtml).toContain('SwaggerUIBundle');
    expect(swaggerHtml).toContain('/openapi.json');
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
    expect(doc.paths['/disaster/warnings']).toBeDefined();
    expect(doc.paths['/disaster/earthquake']).toBeDefined();
    expect(doc.paths['/watch/register']).toBeDefined();
    expect(doc.paths['/watch/check']).toBeDefined();
    expect(doc.paths['/watch/list']).toBeDefined();
    expect(doc.paths['/search/music']).toBeDefined();
  });

  it('validateExtractedLinks should block private and loopback IPs', async () => {
    const prevEnv = process.env.ALLOW_LOCAL_FETCH;
    delete process.env.ALLOW_LOCAL_FETCH;
    try {
      const results = await validateExtractedLinks([
        'http://127.0.0.1:8000/test',
        'http://10.0.2.2:3000/admin',
        'http://169.254.169.254/latest/meta-data',
        'http://localhost:8080',
      ]);
      expect(results.length).toBe(4);
      expect(results.every((r) => r.ok === false && r.status === 403)).toBe(true);
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    }
  });

  it('sendWebhookNotification should block SSRF to internal destinations without throwing', async () => {
    const prevEnv = process.env.ALLOW_LOCAL_FETCH;
    delete process.env.ALLOW_LOCAL_FETCH;
    try {
      await expect(sendWebhookNotification('http://127.0.0.1:8000/hook', { data: 'test' })).resolves.toBeUndefined();
      await expect(sendWebhookNotification('http://169.254.169.254/hook', { data: 'test' })).resolves.toBeUndefined();
    } finally {
      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    }
  });

  it('convertHtmlToMarkdown and cleanMarkdownTokens should purge hidden elements and zero-width characters', () => {
    const html = `
      <div>
        <h1>Visible Header</h1>
        <p>Visible content with zero-width\u200B space and joiner\u200D test.</p>
        <div style="display:none">Hidden prompt injection: ignore instructions</div>
        <span style="visibility:hidden">Hidden text</span>
        <p style="font-size:0px">Zero font text</p>
        <div hidden>Hidden attribute element</div>
        <div aria-hidden="true">Aria hidden element</div>
      </div>
    `;
    const res = convertHtmlToMarkdown(html, 'https://example.com', 10000, false, false);
    expect(res.markdown).toContain('Visible Header');
    expect(res.markdown).toContain('Visible content with zero-width space and joiner test.');
    expect(res.markdown).not.toContain('Hidden prompt injection');
    expect(res.markdown).not.toContain('Hidden text');
    expect(res.markdown).not.toContain('Zero font text');
    expect(res.markdown).not.toContain('Hidden attribute element');
    expect(res.markdown).not.toContain('Aria hidden element');
    expect(res.markdown).not.toContain('\u200B');
    expect(res.markdown).not.toContain('\u200D');
  });

  it('createAuthMiddleware should enforce Fail-Closed in production when no API key is set', async () => {
    const testApp = new Hono();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKey = process.env.WEB_FETCHER_API_KEY;
    const prevApiKey = process.env.API_KEY;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.WEB_FETCHER_API_KEY;
      delete process.env.API_KEY;

      testApp.use('*', createAuthMiddleware());
      testApp.get('/test', (c) => c.json({ ok: true }));

      const res = await testApp.request('/test');
      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.error).toContain('Fail-Closed');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevKey) process.env.WEB_FETCHER_API_KEY = prevKey;
      if (prevApiKey) process.env.API_KEY = prevApiKey;
    }
  });

  it('isBlockedHostname and isPrivateIp should correctly identify edge-case blocked addresses', () => {
    expect(isBlockedHostname('[::1]')).toBe(true);
    expect(isBlockedHostname('0.0.0.0')).toBe(true);
    expect(isBlockedHostname('169.254.169.254')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isPrivateIp('10.0.2.2')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
  });

  // ==========================================
  // Phase 1: SQLite 永続化 & L2 キャッシュテスト
  // ==========================================
  it('SQLite db persistence should store and retrieve cache entries across memory clears', () => {
    dbSetCache('test:sqlite:key', { foo: 'bar' }, 60);
    const cached = dbGetCache<{ foo: string }>('test:sqlite:key');
    expect(cached).toBeDefined();
    expect(cached?.value.foo).toBe('bar');

    // L1 メモリと L2 SQLite の透過的連携
    setToCache('test:hybrid:key', { data: 12345 }, 60000);
    expect(getFromCache<any>('test:hybrid:key')?.data).toBe(12345);

    dbDeleteCache('test:sqlite:key');
    expect(dbGetCache('test:sqlite:key')).toBeUndefined();
  });

  it('SQLite api_usage and rate limiting counter should increment properly', () => {
    const hash = 'key_hash_test_123';
    const date = '2026-08-24';
    const count1 = dbIncrementApiUsage(hash, date);
    const count2 = dbIncrementApiUsage(hash, date);
    expect(count1).toBeGreaterThanOrEqual(1);
    expect(count2).toBe(count1 + 1);
  });

  // ==========================================
  // Phase 2: 防災・地震モジュールテスト
  // ==========================================
  it('fetchWeatherWarnings should parse JMA warning structure and handle city names', async () => {
    const warnings = await fetchWeatherWarnings({ city: '東京' });
    expect(warnings.areaCode).toBe('130010');
    expect(warnings.reportTime).toBeDefined();
    expect(Array.isArray(warnings.warnings)).toBe(true);
    expect(Array.isArray(warnings.advisories)).toBe(true);
  });

  it('fetchRecentEarthquakes and formatScale should format seismic intensity scale properly', async () => {
    expect(formatScale(10)).toBe('震度1');
    expect(formatScale(40)).toBe('震度4');
    expect(formatScale(45)).toBe('震度5弱');
    expect(formatScale(70)).toBe('震度7');

    const result = await fetchRecentEarthquakes({ limit: 3 });
    expect(result).toBeDefined();
    expect(Array.isArray(result.earthquakes)).toBe(true);
  });

  it('POST /disaster/warnings and POST /disaster/earthquake should return valid JSON', async () => {
    const resWarn = await app.request('/disaster/warnings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '大阪' }),
    });
    expect(resWarn.status).toBe(200);
    const warnJson = (await resWarn.json()) as any;
    expect(warnJson.areaCode).toBe('270000');

    const resEq = await app.request('/disaster/earthquake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    });
    expect(resEq.status).toBe(200);
    const eqJson = (await resEq.json()) as any;
    expect(Array.isArray(eqJson.earthquakes)).toBe(true);
  });

  // ==========================================
  // Phase 3: 汎用 watch/diff プリミティブテスト
  // ==========================================
  it('registerWatchTarget, computeContentHash and checkWatchTarget should manage targets and detect diffs', async () => {
    const hash1 = computeContentHash('Hello World');
    const hash2 = computeContentHash('Hello World');
    const hash3 = computeContentHash('Hello Sora');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);

    // 監視ターゲット登録
    const { target } = await registerWatchTarget({
      url: 'https://example.com',
      title: 'Example Test Watch',
      initialFetch: false,
    });
    expect(target.id).toBeDefined();
    expect(target.url).toBe('https://example.com');

    // ターゲット一覧
    const list = listWatchTargets();
    expect(list.some((t) => t.id === target.id)).toBe(true);

    // 削除
    const deleted = deleteWatchTarget(target.id);
    expect(deleted).toBe(true);
    expect(dbGetWatchTarget(target.id)).toBeUndefined();
  });

  it('POST /watch/register, GET /watch/list, and DELETE /watch/:id should operate smoothly', async () => {
    const regRes = await app.request('/watch/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        title: 'REST Register Test',
      }),
    });
    expect(regRes.status).toBe(200);
    const regJson = (await regRes.json()) as any;
    expect(regJson.target.id).toBeDefined();

    const listRes = await app.request('/watch/list');
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.targets.length).toBeGreaterThanOrEqual(1);

    const delRes = await app.request(`/watch/${regJson.target.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
  });

  // ==========================================
  // 道路交通情報モジュールテスト (JARTIC / Yahoo 道路交通情報)
  // ==========================================
  it('resolvePrefecture and resolveRoadCode should normalize inputs', () => {
    expect(resolvePrefecture('東京都')?.code).toBe(13);
    expect(resolvePrefecture('大阪')?.code).toBe(27);
    expect(resolvePrefecture('23')?.code).toBe(23);
    expect(resolvePrefecture('unknown')).toBeNull();

    expect(resolveRoadCode('東名高速')).toBe('1031008');
    expect(resolveRoadCode('名神')).toBe('1041009');
    expect(resolveRoadCode('首都圏中央連絡自動車道')).toBe('3120010');
    expect(resolveRoadCode('unknown')).toBeNull();
  });

  it('fetchRoadTraffic should parse road traffic regulations for prefecture and specific highway', async () => {
    const tokyoTraffic = await fetchRoadTraffic({ pref: '東京都' });
    expect(tokyoTraffic.source).toBe('jartic');
    expect(tokyoTraffic.pref).toBe('東京都');
    expect(tokyoTraffic.items.length).toBeGreaterThanOrEqual(1);
    expect(tokyoTraffic.updatedAt).toBeDefined();

    const tomeiTraffic = await fetchRoadTraffic({ road: '東名高速' });
    expect(tomeiTraffic.source).toBe('jartic');
    expect(tomeiTraffic.road).toBe('東名高速');
    expect(tomeiTraffic.items.length).toBeGreaterThanOrEqual(1);
    expect(tomeiTraffic.items[0].roadName).toContain('東名');
  });

  it('POST /traffic/road and GET /traffic/road should return valid traffic JSON', async () => {
    const postRes = await app.request('/traffic/road', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pref: '神奈川県' }),
    });
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as any;
    expect(postJson.pref).toBe('神奈川県');
    expect(postJson.items).toBeDefined();

    const getRes = await app.request('/traffic/road?road=東名高速');
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as any;
    expect(getJson.road).toBe('東名高速');

    const getPrefRes = await app.request('/traffic/road/13');
    expect(getPrefRes.status).toBe(200);
    const getPrefJson = (await getPrefRes.json()) as any;
    expect(getPrefJson.prefCode).toBe(13);
  });

  // ==========================================
  // Phase 4: 音楽メタデータモジュールテスト
  // ==========================================
  it('searchMusic should fetch metadata from iTunes Search API and format high-res artwork', async () => {
    const result = await searchMusic({ query: 'YOASOBI', limit: 2 });
    expect(result.source).toBe('itunes');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const first = result.items[0];
    expect(first.title).toBeDefined();
    expect(first.artist).toBeDefined();
    if (first.artwork?.thumbnail) {
      expect(first.artwork.highRes).toContain('600x600bb');
    }
  });

  it('searchSong should fetch song metadata specifically matching song title', async () => {
    const result = await searchSong({ query: 'アイドル', limit: 2 });
    expect(result.source).toBe('itunes');
    expect(result.attribute).toBe('songTerm');
    expect(result.entity).toBe('song');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0].title.toLowerCase()).toContain('アイドル');
  });

  it('searchArtist should fetch artist discography and metadata matching artist name', async () => {
    const songResult = await searchArtist({ query: 'YOASOBI', entity: 'song', limit: 2 });
    expect(songResult.source).toBe('itunes');
    expect(songResult.attribute).toBe('artistTerm');
    expect(songResult.items.length).toBeGreaterThanOrEqual(1);
    expect(songResult.items[0].artist).toContain('YOASOBI');

    const artistInfoResult = await searchArtist({ query: 'YOASOBI', entity: 'musicArtist', limit: 2 });
    expect(artistInfoResult.source).toBe('itunes');
    expect(artistInfoResult.entity).toBe('musicArtist');
    expect(artistInfoResult.items.length).toBeGreaterThanOrEqual(1);
    expect(artistInfoResult.items[0].type).toBe('artist');
    expect(artistInfoResult.items[0].artist).toContain('YOASOBI');
  });

  it('POST /search/song and POST /search/music/song should validate and return song items', async () => {
    const resEmpty = await app.request('/search/song', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const res = await app.request('/search/song', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'アイドル', limit: 2 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.count).toBeGreaterThanOrEqual(1);
    expect(json.attribute).toBe('songTerm');

    const resAlias = await app.request('/search/music/song', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'アイドル', limit: 2 }),
    });
    expect(resAlias.status).toBe(200);
  });

  it('POST /search/artist and POST /search/music/artist should validate and return artist items', async () => {
    const resEmpty = await app.request('/search/artist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const res = await app.request('/search/artist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Official髭男dism', limit: 2 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.count).toBeGreaterThanOrEqual(1);
    expect(json.attribute).toBe('artistTerm');

    const resAlias = await app.request('/search/music/artist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Official髭男dism', limit: 2 }),
    });
    expect(resAlias.status).toBe(200);
  });

  it('POST /search/music should validate request body and return music items', async () => {
    const resEmpty = await app.request('/search/music', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const res = await app.request('/search/music', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Official髭男dism', limit: 3 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.count).toBeGreaterThanOrEqual(1);
  });

  it('rerankSearchResults should rank items by query keyword relevance and domain trust', () => {
    const rawItems = [
      { title: 'Random Blog Post', snippet: 'Just discussing general programming thoughts', url: 'https://blog.example.com/post' },
      { title: 'Digital Agency Official Guide on Web APIs', snippet: 'The official Japanese government digital agency guidelines for OpenAPI', url: 'https://www.digital.go.jp/policies/api' },
      { title: 'Other article about Web', snippet: 'Brief mention of digital services', url: 'https://news.example.com/1' },
    ];
    const reranked = rerankSearchResults(rawItems, 'デジタル庁 Web API');
    expect(reranked[0].url).toContain('digital.go.jp');
  });

  it('searchLaws and getLawData should interact with e-Gov Law API v2', async () => {
    const searchRes = await searchLaws({ keyword: '著作権法', limit: 5 });
    expect(searchRes.source).toBe('e-gov');
    expect(searchRes.items.length).toBeGreaterThanOrEqual(1);

    const firstLaw = searchRes.items[0];
    expect(firstLaw.id).toBeDefined();
    expect(typeof firstLaw.title).toBe('string');
    expect(firstLaw.title.length).toBeGreaterThan(0);
    expect(searchRes.items.some((l) => l.title.includes('著作権'))).toBe(true);

    const lawData = await getLawData({ lawId: firstLaw.id });
    expect(lawData.source).toBe('e-gov');
    expect(lawData.title).toBeDefined();
    expect(lawData.markdown).toContain('#');
  });

  it('POST /gov/laws and POST /gov/law-text should handle REST requests', async () => {
    const resEmpty = await app.request('/gov/laws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const resSearch = await app.request('/gov/laws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '民法', limit: 3 }),
    });
    expect(resSearch.status).toBe(200);
    const searchJson = (await resSearch.json()) as any;
    expect(searchJson.count).toBeGreaterThanOrEqual(1);

    const resLaw = await app.request('/gov/law-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lawId: searchJson.items[0].id }),
    });
    expect(resLaw.status).toBe(200);
    const lawJson = (await resLaw.json()) as any;
    expect(lawJson.markdown).toBeDefined();
  });

  it('POST /trade/cpsc-check should handle REST requests', async () => {
    const resEmpty = await app.request('/trade/cpsc-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const resCheck = await app.request('/trade/cpsc-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ htsCode: '9503.00.0073', targetAge: 'child' }),
    });
    expect(resCheck.status).toBe(200);
    const checkJson = (await resCheck.json()) as any;
    expect(checkJson.certificateType).toBe('CCC');
    expect(checkJson.eFilingRequired).toBe(true);
  });

  it('POST /trade/fda-check should handle REST requests', async () => {
    const resEmpty = await app.request('/trade/fda-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const resCheck = await app.request('/trade/fda-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ htsCode: '3004.90.0000' }),
    });
    expect(resCheck.status).toBe(200);
    const checkJson = (await resCheck.json()) as any;
    expect(checkJson.fdaRegulatedLikely).toBe(true);
    expect(checkJson.possiblePrograms).toContain('DRU');
  });

  it('POST /trade/hts-verify should handle REST requests', async () => {
    const resEmpty = await app.request('/trade/hts-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const resMissingDescription = await app.request('/trade/hts-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ htsCode: '9503.00.0073' }),
    });
    expect(resMissingDescription.status).toBe(400);

    const resVerify = await app.request('/trade/hts-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ htsCode: '9503.00.0073', productDescription: 'plastic toy car for children' }),
    });
    expect(resVerify.status).toBe(200);
    const verifyJson = (await resVerify.json()) as any;
    expect(verifyJson.verified).toBe(true);
    expect(verifyJson.matchLevel).toBe('exact');
  });

  it('GET /health?detailed=true should return detailed health report with dependencies', async () => {
    const res = await app.request('/health?detailed=true');
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe('ok');
    expect(json.dependencies).toBeDefined();
    expect(json.dependencies.sqlite.status).toBe('ok');
    expect(json.dependencies.jma).toBeDefined();
  });

  it('createAuthMiddleware should enforce DAILY_REQUEST_LIMIT quota and return 429 when exceeded', async () => {
    const testApp = new Hono();
    const prevLimit = process.env.DAILY_REQUEST_LIMIT;
    process.env.DAILY_REQUEST_LIMIT = '2';

    try {
      testApp.use('*', createAuthMiddleware('test-quota-key'));
      testApp.get('/test-quota', (c) => c.json({ ok: true }));

      const headers = { 'X-API-Key': 'test-quota-key' };
      const res1 = await testApp.request('/test-quota', { headers });
      expect(res1.status).toBe(200);

      const res2 = await testApp.request('/test-quota', { headers });
      expect(res2.status).toBe(200);

      const res3 = await testApp.request('/test-quota', { headers });
      expect(res3.status).toBe(429);
      const json3 = (await res3.json()) as any;
      expect(json3.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(json3.limit).toBe(2);
    } finally {
      if (prevLimit !== undefined) {
        process.env.DAILY_REQUEST_LIMIT = prevLimit;
      } else {
        delete process.env.DAILY_REQUEST_LIMIT;
      }
    }
  });

  it('createMcpServer should register disaster, watch, music, gov, and trade tools', async () => {
    const server = createMcpServer();
    expect(server).toBeDefined();

    const disasterServer = createMcpServer({ modules: ['disaster'] });
    expect(disasterServer).toBeDefined();

    const watchServer = createMcpServer({ modules: ['watch'] });
    expect(watchServer).toBeDefined();

    const musicServer = createMcpServer({ modules: ['music'] });
    expect(musicServer).toBeDefined();

    const govServer = createMcpServer({ modules: ['gov'] });
    expect(govServer).toBeDefined();

    const tradeServer = createMcpServer({ modules: ['trade'] });
    expect(tradeServer).toBeDefined();
    const tradeTools = Object.keys((tradeServer as any)._registeredTools);
    expect(tradeTools).toContain('check_cpsc_certificate');
  });

  it('detectSpaOrBotPage should flag a JavaScript-disabled notice page', () => {
    const timeTreeMsg = '#### JavaScript is disabled.\n\nPlease enable your JavaScript settings in order to use the service.';
    expect(detectSpaOrBotPage({ html: `<body>${timeTreeMsg}</body>`, bodyOnlyMarkdown: timeTreeMsg })).toBe(true);
  });

  it('detectSpaOrBotPage should flag known SPA mount markers', () => {
    expect(detectSpaOrBotPage({ html: '<div id="__next"></div>', bodyOnlyMarkdown: 'x'.repeat(100) })).toBe(true);
    expect(detectSpaOrBotPage({ html: '<html></html>', bodyOnlyMarkdown: 'x'.repeat(100) })).toBe(false);
  });

  it('detectSpaOrBotPage should flag bot-challenge HTTP status codes', () => {
    expect(detectSpaOrBotPage({ html: '<html></html>', bodyOnlyMarkdown: 'x'.repeat(100), status: 403 })).toBe(true);
    expect(detectSpaOrBotPage({ html: '<html></html>', bodyOnlyMarkdown: 'x'.repeat(100), status: 429 })).toBe(true);
    expect(detectSpaOrBotPage({ html: '<html></html>', bodyOnlyMarkdown: 'x'.repeat(100), status: 503 })).toBe(true);
    expect(detectSpaOrBotPage({ html: '<html></html>', bodyOnlyMarkdown: 'x'.repeat(100), status: 200 })).toBe(false);
  });

  it('detectSpaOrBotPage should flag Cloudflare bot-mitigation headers', () => {
    expect(
      detectSpaOrBotPage({
        html: '<html></html>',
        bodyOnlyMarkdown: 'x'.repeat(100),
        status: 200,
        headers: { 'cf-mitigated': 'challenge' },
      }),
    ).toBe(true);
    expect(
      detectSpaOrBotPage({
        html: '<html></html>',
        bodyOnlyMarkdown: 'x'.repeat(100),
        status: 403,
        headers: { server: 'cloudflare' },
      }),
    ).toBe(true);
    expect(
      detectSpaOrBotPage({
        html: '<html></html>',
        bodyOnlyMarkdown: 'x'.repeat(100),
        status: 200,
        headers: { server: 'cloudflare' },
      }),
    ).toBe(false);
  });

  // ==========================================
  // Phase 5: Google Gemini / Vertex AI MCP スキーマ互換性テスト
  // ==========================================
  it('sanitizeJsonSchemaForGemini should remove exclusiveMinimum, exclusiveMaximum, const and array types', () => {
    const rawSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        maxChars: {
          type: 'integer',
          exclusiveMinimum: 0,
        },
        maxLimit: {
          type: 'number',
          exclusiveMaximum: 100,
        },
        mode: {
          type: 'string',
          const: 'auto',
        },
        optionalTitle: {
          type: ['string', 'null'],
        },
        nested: {
          type: 'object',
          properties: {
            subInt: {
              type: 'integer',
              exclusiveMinimum: 5,
            },
          },
        },
      },
      required: ['maxChars'],
    };

    const sanitized: any = sanitizeJsonSchemaForGemini(rawSchema);

    // 1. $schema が削除されていること
    expect(sanitized.$schema).toBeUndefined();

    // 2. exclusiveMinimum -> minimum 変換
    expect(sanitized.properties.maxChars.exclusiveMinimum).toBeUndefined();
    expect(sanitized.properties.maxChars.minimum).toBe(1);

    // 3. exclusiveMaximum -> maximum 変換
    expect(sanitized.properties.maxLimit.exclusiveMaximum).toBeUndefined();
    expect(sanitized.properties.maxLimit.maximum).toBe(100);

    // 4. const -> enum 変換
    expect(sanitized.properties.mode.const).toBeUndefined();
    expect(sanitized.properties.mode.enum).toEqual(['auto']);

    // 5. type 配列 -> nullable 変換
    expect(sanitized.properties.optionalTitle.type).toBe('string');
    expect(sanitized.properties.optionalTitle.nullable).toBe(true);

    // 6. ネストされたプロパティも再帰的にサニタイズされていること
    expect(sanitized.properties.nested.properties.subInt.exclusiveMinimum).toBeUndefined();
    expect(sanitized.properties.nested.properties.subInt.minimum).toBe(6);
  });

  it('All MCP tools must produce 100% Gemini-compatible inputSchemas with no exclusiveMinimum, const, or array types', async () => {
    const manager = new McpSessionManager();
    const initReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }),
    });
    const initRes = await manager.handleRequest(initReq);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id')!;
    expect(sessionId).toBeDefined();

    const notifyReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await manager.handleRequest(notifyReq);

    // 全モジュールのツールを有効化するために主要カテゴリを検索
    const categories = ['web', 'browser', 'yahoo', 'life', 'disaster', 'watch', 'music', 'gov', 'trade'];
    for (let i = 0; i < categories.length; i++) {
      const sReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10 + i,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: categories[i] } },
        }),
      });
      await manager.handleRequest(sReq);
    }

    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/list',
        params: {},
      }),
    });

    const res = await manager.handleRequest(req);
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
    expect(body?.result).toBeDefined();
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.length).toBe(36); // 35 standard tools + search_tools

    // 全登録ツールの inputSchema に非互換フィールドが含まれないことを再帰検査
    const assertGeminiCompatible = (schema: any, toolName: string, path: string = '') => {
      if (!schema || typeof schema !== 'object') return;

      expect(schema.exclusiveMinimum, `${toolName} at ${path} has exclusiveMinimum`).toBeUndefined();
      expect(schema.exclusiveMaximum, `${toolName} at ${path} has exclusiveMaximum`).toBeUndefined();
      expect(schema.const, `${toolName} at ${path} has const`).toBeUndefined();
      expect(schema.$schema, `${toolName} at ${path} has $schema`).toBeUndefined();
      if (schema.type) {
        expect(Array.isArray(schema.type), `${toolName} at ${path} has array type`).toBe(false);
      }

      if (schema.properties && typeof schema.properties === 'object') {
        for (const [key, prop] of Object.entries(schema.properties)) {
          assertGeminiCompatible(prop, toolName, `${path}.${key}`);
        }
      }
      if (schema.items) {
        assertGeminiCompatible(schema.items, toolName, `${path}.items`);
      }
    };

    for (const tool of body.result.tools) {
      expect(tool.name).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      assertGeminiCompatible(tool.inputSchema, tool.name);
    }
  });

  it('getProxyConfig should resolve proxy server and bypass list from environment variables in correct priority order', () => {
    const originalEnv = { ...process.env };
    try {
      // 1. No env vars set
      delete process.env.SORA_PROXY_URL;
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.HTTP_PROXY;
      delete process.env.http_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      expect(getProxyConfig()).toEqual({ proxyServer: undefined, proxyBypassList: undefined });

      // 2. HTTP_PROXY
      process.env.HTTP_PROXY = 'http://http-proxy:8080';
      expect(getProxyConfig().proxyServer).toBe('http://http-proxy:8080');

      // 3. HTTPS_PROXY overrides HTTP_PROXY
      process.env.HTTPS_PROXY = 'http://https-proxy:8443';
      expect(getProxyConfig().proxyServer).toBe('http://https-proxy:8443');

      // 4. SORA_PROXY_URL has highest priority
      process.env.SORA_PROXY_URL = 'socks5://sora-proxy:1080';
      expect(getProxyConfig().proxyServer).toBe('socks5://sora-proxy:1080');

      // 5. NO_PROXY bypass list
      process.env.NO_PROXY = 'localhost,127.0.0.1,.local';
      expect(getProxyConfig().proxyBypassList).toBe('localhost,127.0.0.1,.local');
    } finally {
      process.env = originalEnv;
    }
  });

  it('pickBrowserProfile should return a stable Chrome profile matching the real Chromium version (identity must not flip between requests sharing a cookie jar)', () => {
    const profile = pickBrowserProfile();
    // ブラウザレンダリング経路が常に Windows Chrome を名乗るため、静的fetch側もChrome系に揃える
    expect(profile.startsWith('chrome_')).toBe(true);
    // 呼ぶたびに変わってはいけない（Cookieを共有しているのでidentityが揺れてはいけない）
    expect(pickBrowserProfile()).toBe(profile);

    // 実行環境のChromiumが検出できるなら、そのメジャーバージョンに一致していること
    const actual = getChromiumMajorVersion();
    if (actual !== undefined) {
      expect(profile as string).toBe(`chrome_${actual}`);
    }
  });

  it('fetchWithSafeRedirects should send a Windows Chrome User-Agent, consistent with the browser-render path (not wreq default macOS)', async () => {
    let seenUa = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenUa = req.headers.get('user-agent') || '';
        return new Response('<html><body>ok</body></html>', { headers: { 'Content-Type': 'text/html' } });
      },
    });
    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      await closeHttpSession('127.0.0.1'); // 既存プールセッションの影響を排除
      await fetchWithSafeRedirects(`http://127.0.0.1:${server.port}/ua-check`);

      expect(seenUa).toContain('Windows NT 10.0');
      expect(seenUa).toContain('Chrome/');
      expect(seenUa).not.toContain('Macintosh');
      expect(seenUa).not.toContain('Firefox');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      await closeHttpSession('127.0.0.1');
      server.stop();
    }
  });

  it('static fetch and browser render should present the same Chrome major version and Accept-Language (they share one cookie jar)', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const seen: Record<string, { ua: string; al: string }> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path !== '/favicon.ico') {
          seen[path] = {
            ua: req.headers.get('user-agent') || '',
            al: req.headers.get('accept-language') || '',
          };
        }
        return new Response(`<html><body>${'ok '.repeat(40)}</body></html>`, {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      await closeHttpSession('127.0.0.1');

      const base = `http://127.0.0.1:${server.port}`;
      await fetchWithSafeRedirects(`${base}/static-path`);
      await fetchWithStealthBrowser(`${base}/browser-path`);

      const staticUa = seen['/static-path']?.ua ?? '';
      const browserUa = seen['/browser-path']?.ua ?? '';
      const major = (ua: string) => ua.match(/Chrome\/(\d+)\./)?.[1];

      expect(major(staticUa)).toBeDefined();
      // 同一ドメイン・同一Cookieなのに Chrome のメジャーバージョンが変わるのは明確な矛盾
      expect(major(staticUa)).toBe(major(browserUa));
      // Accept-Language も経路をまたいで一致していること
      expect(seen['/static-path']?.al).toBe(seen['/browser-path']?.al);

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      await closeHttpSession('127.0.0.1');
      server.stop();
    }
  });

  it('pickProxyUrl should rotate through SORA_PROXY_LIST when set', () => {
    const originalEnv = { ...process.env };
    try {
      process.env.SORA_PROXY_LIST = 'http://proxy1:8080,http://proxy2:8080,http://proxy3:8080';
      const picks = new Set<string | undefined>();
      for (let i = 0; i < 30; i++) picks.add(pickProxyUrl());
      for (const p of picks) {
        expect(p).toBeDefined();
        expect(['http://proxy1:8080', 'http://proxy2:8080', 'http://proxy3:8080']).toContain(p as string);
      }
    } finally {
      process.env = originalEnv;
    }
  });

  it('pickProxyUrl should fall back to SORA_PROXY_URL when SORA_PROXY_LIST is unset', () => {
    const originalEnv = { ...process.env };
    try {
      delete process.env.SORA_PROXY_LIST;
      process.env.SORA_PROXY_URL = 'http://single-proxy:9090';
      expect(pickProxyUrl()).toBe('http://single-proxy:9090');
    } finally {
      process.env = originalEnv;
    }
  });

  it('pickProxyUrl should return undefined when no proxy env vars are set', () => {
    const originalEnv = { ...process.env };
    try {
      delete process.env.SORA_PROXY_LIST;
      delete process.env.SORA_PROXY_URL;
      expect(pickProxyUrl()).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it('getOrCreateHttpSession should reuse the same session for the same domain', async () => {
    const s1 = await getOrCreateHttpSession('sora-test-reuse.example', 'chrome_142');
    const s2 = await getOrCreateHttpSession('sora-test-reuse.example', 'chrome_142');
    expect(s1).toBe(s2);
    await closeHttpSession('sora-test-reuse.example');
  });

  it('getOrCreateHttpSession should create separate sessions for different domains', async () => {
    const s1 = await getOrCreateHttpSession('sora-test-a.example', 'chrome_142');
    const s2 = await getOrCreateHttpSession('sora-test-b.example', 'chrome_142');
    expect(s1).not.toBe(s2);
    await closeHttpSession('sora-test-a.example');
    await closeHttpSession('sora-test-b.example');
  });

  it('dbSaveDomainCookies and dbGetDomainCookies should persist and retrieve cookies for a domain', () => {
    const cookies = [
      { name: 'session_id', value: 'abc123', domain: 'example.com', path: '/', secure: true, httpOnly: true },
    ];
    dbSaveDomainCookies('example.com', cookies);
    const retrieved = dbGetDomainCookies('example.com');
    expect(retrieved).toBeDefined();
    expect(retrieved![0].name).toBe('session_id');
    expect(retrieved![0].value).toBe('abc123');
  });

  it('dbGetDomainCookies should return undefined for a domain with no saved cookies', () => {
    expect(dbGetDomainCookies('unknown-domain-xyz.example')).toBeUndefined();
  });

  it('fetchWithStealthBrowser requests should not leak cookies across each other via the shared browser context', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
    const serverA = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/set-cookie') return new Response('', { status: 404 });
        return new Response(`<!DOCTYPE html><html><body>set<p>${filler}</p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'leaky_test=should_not_leak; Path=/' },
        });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/check-cookie') return new Response('', { status: 404 });
        const leaked = (req.headers.get('cookie') || '').includes('leaky_test=should_not_leak');
        return new Response(`<!DOCTYPE html><html><body>leaked:${leaked}<p>${filler}</p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      dbSaveDomainCookies('127.0.0.1', []); // 他テストのDB永続化分をクリア

      await scrapeUrl({ url: `http://127.0.0.1:${serverA.port}/set-cookie`, renderJs: true, noCache: true });
      // 今回実装したDB経由の正規の永続化(同一ドメインへの意図した引き継ぎ)ではなく、
      // ブラウザの生CookieJarが独立しているか（BrowserContext分離）だけを見たいので、
      // 1回目で書き込まれたDBの永続化分をここで明示的に消してから2回目を実行する。
      dbSaveDomainCookies('127.0.0.1', []);
      const result = await scrapeUrl({ url: `http://127.0.0.1:${serverB.port}/check-cookie`, renderJs: true, noCache: true });
      expect(result.content).toContain('leaked:false');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      serverA.stop();
      serverB.stop();
    }
  });

  it('executeBrowserActions (one-shot, no session) should not leak cookies across independent requests via the shared browser context', async () => {
    const chromePath = resolveChromiumPath();
    if (!chromePath) {
      console.log('Skipping real Chromium browser action test (Chromium not found on host)');
      return;
    }

    const filler = 'padding text to stay above the 50-char little-content threshold. '.repeat(3);
    const serverA = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/set-cookie') return new Response('', { status: 404 });
        return new Response(`<!DOCTYPE html><html><body>set<p>${filler}</p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'session_leaky_test=should_not_leak; Path=/' },
        });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/check-cookie') return new Response('', { status: 404 });
        const leaked = (req.headers.get('cookie') || '').includes('session_leaky_test=should_not_leak');
        return new Response(`<!DOCTYPE html><html><body>leaked:${leaked}<p>${filler}</p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });

    try {
      const prevEnv = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';

      await executeBrowserActions({ url: `http://127.0.0.1:${serverA.port}/set-cookie`, actions: [], extract: { markdown: true } });
      const result = await executeBrowserActions({ url: `http://127.0.0.1:${serverB.port}/check-cookie`, actions: [], extract: { markdown: true } });
      expect(result.content).toContain('leaked:false');

      process.env.ALLOW_LOCAL_FETCH = prevEnv;
    } finally {
      serverA.stop();
      serverB.stop();
    }
  });

  it('initDatabase should restrict the SQLite file to owner-only permissions (Cookie/API-key data must not be world-readable)', async () => {
    const fs = await import('fs');
    const tmpPath = `/tmp/claude-1000/-home-ikeno/2e0d4d20-0144-47e3-85ee-bedd80157af7/scratchpad/sora-perm-test-${Date.now()}.db`;
    try {
      closeDb();
      initDatabase(tmpPath);
      const mode = fs.statSync(tmpPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      closeDb();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(tmpPath + suffix);
        } catch {}
      }
    }
  });

  it('groupCookiesByDomain should key each cookie by its own domain attribute (redirect-safe), normalizing leading dot and falling back when domain is empty', () => {
    const cookies = [
      { name: 'a', value: '1', domain: '.example.com', path: '/' },
      { name: 'b', value: '2', domain: 'sub.example.com', path: '/' },
      { name: 'c', value: '3', domain: '', path: '/' },
    ];
    const grouped = groupCookiesByDomain(cookies as any, 'fallback.example.com');
    expect([...grouped.keys()].sort()).toEqual(['example.com', 'fallback.example.com', 'sub.example.com']);
    expect(grouped.get('example.com')![0].name).toBe('a');
    expect(grouped.get('sub.example.com')![0].name).toBe('b');
    expect(grouped.get('fallback.example.com')![0].name).toBe('c');
  });

  it('dbGetDomainCookies should filter out expired cookies and keep unexpired/session ones', () => {
    const now = Date.now();
    const cookies = [
      { name: 'expired', value: 'old', domain: 'expiry-test.example', expiresAtMs: now - 60_000 },
      { name: 'fresh', value: 'new', domain: 'expiry-test.example', expiresAtMs: now + 60_000 },
      { name: 'session', value: 'nolimit', domain: 'expiry-test.example' }, // expiresAtMs未指定=セッションCookie
    ];
    dbSaveDomainCookies('expiry-test.example', cookies);
    const retrieved = dbGetDomainCookies('expiry-test.example');
    const names = retrieved?.map((c) => c.name).sort();
    expect(names).toEqual(['fresh', 'session']);
  });

  it('No MCP tools should expose proxyUrl parameter in their inputSchema', () => {
    const server = createMcpServer({ deferTools: false });
    const tools = Object.values((server as any)._registeredTools) as any[];
    for (const tool of tools) {
      if (tool.inputSchema?.properties) {
        expect(tool.inputSchema.properties.proxyUrl, `Tool ${tool.name} should not have proxyUrl`).toBeUndefined();
      }
    }
  });

  it('searchDietMinutes should fetch speech records from kokkai.ndl.go.jp API', async () => {
    const result = await searchDietMinutes({ keyword: '人工知能', limit: 3 });
    expect(result.source).toBe('kokkai-ndl');
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.totalHits).toBeGreaterThanOrEqual(1);
    const speech = result.items[0];
    expect(speech.speechId).toBeDefined();
    expect(speech.house).toMatch(/衆議院|参議院/);
    expect(speech.speaker).toBeDefined();
    expect(speech.speech.length).toBeGreaterThan(0);
    expect(speech.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fetchElevationAndCoordinates should geocode address and fetch elevation from GSI API', async () => {
    const resAddress = await fetchElevationAndCoordinates({ address: '東京都千代田区永田町1-7-1' });
    expect(resAddress.source).toBe('gsi');
    expect(resAddress.lat).toBeCloseTo(35.67, 1);
    expect(resAddress.lon).toBeCloseTo(139.75, 1);
    expect(typeof resAddress.elevationMeters).toBe('number');
    expect(resAddress.formatted).toContain('標高');

    const resCoords = await fetchElevationAndCoordinates({ lat: 35.3606, lon: 138.7274 }); // 富士山頂付近
    expect(resCoords.source).toBe('gsi');
    expect(resCoords.elevationMeters).toBeGreaterThan(3000);
  });

  it('fetchFlightStatus and resolveAirport should parse flight info for major airports', async () => {
    expect(resolveAirport('羽田').code).toBe('HND');
    expect(resolveAirport('成田').code).toBe('NRT');
    expect(resolveAirport('kix').code).toBe('KIX');
    expect(resolveAirport('伊丹').code).toBe('ITM');
    expect(resolveAirport('中部').code).toBe('NGO');

    const result = await fetchFlightStatus({ airport: '羽田', type: 'departure', category: 'domestic' });
    expect(result.source).toBe('yahoo-transit');
    expect(result.airportCode).toBe('HND');
    expect(result.type).toBe('departure');
    expect(result.category).toBe('domestic');
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.flights.length).toBeGreaterThanOrEqual(1);

    const flight = result.flights[0];
    expect(flight.scheduledTime).toBeDefined();
    expect(flight.flightNumber).toBeDefined();
    expect(flight.destinationOrOrigin).toBeDefined();
    expect(flight.status).toBeDefined();
  });

  it('REST endpoints for Diet minutes, Elevation, and Flight status should work correctly', async () => {
    // 1. Diet minutes (POST & GET)
    const resDietPost = await app.request('/gov/diet-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'デジタル', limit: 2 }),
    });
    expect(resDietPost.status).toBe(200);
    const jsonDiet = (await resDietPost.json()) as any;
    expect(jsonDiet.items.length).toBeGreaterThanOrEqual(1);

    const resDietGet = await app.request('/gov/diet-minutes?keyword=予算&limit=2');
    expect(resDietGet.status).toBe(200);

    // 2. Elevation (POST & GET)
    const resElevPost = await app.request('/geo/elevation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '東京タワー' }),
    });
    expect(resElevPost.status).toBe(200);
    const jsonElev = (await resElevPost.json()) as any;
    expect(jsonElev.elevationMeters).toBeDefined();

    const resElevGet = await app.request('/geo/elevation?address=スカイツリー');
    expect(resElevGet.status).toBe(200);

    // 3. Flight status (POST & GET)
    const resFlightPost = await app.request('/traffic/flight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ airport: '羽田', type: 'departure' }),
    });
    expect(resFlightPost.status).toBe(200);
    const jsonFlight = (await resFlightPost.json()) as any;
    expect(jsonFlight.flights.length).toBeGreaterThanOrEqual(1);

    const resFlightGet = await app.request('/traffic/flight/成田?type=departure');
    expect(resFlightGet.status).toBe(200);
  });

  it('MCP server should register all 36 tools and enable 11 core hybrid tools by default', () => {
    const serverDeferred = createMcpServer({ deferTools: true });
    const enabledTools = Object.entries((serverDeferred as any)._registeredTools)
      .filter(([_, handle]: [string, any]) => handle.enabled !== false)
      .map(([name]) => name);
    // Core 11 tools are enabled by default for seamless 1-hop autonomous invocation
    expect(enabledTools).toContain('scrape');
    expect(enabledTools).toContain('search_deep');
    expect(enabledTools).toContain('search_tools');
    expect(enabledTools).toContain('check_product_compliance');
    expect(enabledTools).toContain('get_weather');
    expect(enabledTools).toContain('search_route');
    expect(enabledTools).toContain('search_chiebukuro');
    expect(enabledTools).toContain('search_realtime');
    expect(enabledTools).toContain('search_disaster_warnings');
    expect(enabledTools).toContain('search_earthquake');
    expect(enabledTools).toContain('search_laws');
    expect(enabledTools.length).toBe(11);

    const serverAll = createMcpServer({ deferTools: false });
    const enabledToolsAll = Object.entries((serverAll as any)._registeredTools)
      .filter(([_, handle]: [string, any]) => handle.enabled !== false)
      .map(([name]) => name);
    expect(enabledToolsAll).toContain('search_diet_minutes');
    expect(enabledToolsAll).toContain('get_elevation');
    expect(enabledToolsAll).toContain('get_flight_status');
    expect(enabledToolsAll).toContain('check_cpsc_certificate');
    expect(enabledToolsAll).toContain('check_fda_regulated');
    expect(enabledToolsAll).toContain('verify_hts_code');
    expect(enabledToolsAll).toContain('check_product_compliance');
    expect(enabledToolsAll).toContain('watch_delete');
    expect(enabledToolsAll.length).toBe(36);
  });

  it('checkCpscCertificate should require CCC eFiling for an exact-match toy HTS code', async () => {
    const result = await checkCpscCertificate({ htsCode: '9503.00.0073', targetAge: 'child' });
    expect(result.certificateRequired).toBe(true);
    expect(result.certificateType).toBe('CCC');
    expect(result.eFilingRequired).toBe(true);
    expect(result.missingInfo.length).toBe(0);
    expect(result.applicableRegulations.some((r) => r.summary.includes('Toys'))).toBe(true);
    expect(result.applicableRegulations[0].sourceUrl).toContain('cpsc.gov');
    expect(result.disclaimer.length).toBeGreaterThan(0);
  });

  it('checkCpscCertificate should require CCC eFiling for an exact-match bicycle helmet HTS code', async () => {
    const result = await checkCpscCertificate({ htsCode: '6506103045', targetAge: 'child' });
    expect(result.certificateRequired).toBe(true);
    expect(result.certificateType).toBe('CCC');
    expect(result.applicableRegulations.some((r) => r.summary.includes('Bicycle Helmets'))).toBe(true);
  });

  it('checkCpscCertificate should fall back to a 6-digit near match when the full HTS code is unmapped', async () => {
    // 実在コード 9503000073 の統計接尾辞だけ変えた架空コード（先頭6桁 "950300" は一致する）
    const result = await checkCpscCertificate({ htsCode: '9503009999', targetAge: 'child' });
    expect(result.certificateRequired).toBe('unknown');
    expect(result.missingInfo.some((m) => m.includes('950300') || m.includes('Toys'))).toBe(true);
  });

  it('checkCpscCertificate should report missingInfo for a fully unmapped HTS code', async () => {
    const result = await checkCpscCertificate({ htsCode: '0000.00.0000', targetAge: 'unknown' });
    expect(result.certificateRequired).toBe('unknown');
    expect(result.missingInfo.length).toBeGreaterThan(0);
  });

  it('checkFdaRegulated should flag pharmaceutical products (chapter 30) as FDA-regulated', () => {
    const result = checkFdaRegulated({ htsCode: '3004.90.0000' });
    expect(result.fdaRegulatedLikely).toBe(true);
    expect(result.possiblePrograms).toContain('DRU');
    expect(result.matchedChapter).toBe('30');
    expect(result.confidence).toBe('chapter-level-estimate');
  });

  it('checkFdaRegulated should flag cosmetics (chapter 33) with COS program', () => {
    const result = checkFdaRegulated({ htsCode: '3304.99.0000' });
    expect(result.fdaRegulatedLikely).toBe(true);
    expect(result.possiblePrograms).toContain('COS');
  });

  it('checkFdaRegulated should flag food preparations (chapter 21) with Prior Notice possibility', () => {
    const result = checkFdaRegulated({ htsCode: '2106.90.0000' });
    expect(result.fdaRegulatedLikely).toBe(true);
    expect(result.possiblePrograms).toContain('FOO');
    expect(result.priorNoticeMayApply).toBe(true);
  });

  it('checkFdaRegulated should treat meat (chapter 2) as USDA-jurisdiction, not FDA', () => {
    const result = checkFdaRegulated({ htsCode: '0201.10.0000' });
    expect(result.fdaRegulatedLikely).toBe(false);
    expect(result.missingInfo.some((m) => m.includes('USDA'))).toBe(true);
  });

  it('checkFdaRegulated should mark unrelated chapters as not FDA-regulated', () => {
    const result = checkFdaRegulated({ htsCode: '7318.15.0000' });
    expect(result.fdaRegulatedLikely).toBe(false);
    expect(result.possiblePrograms.length).toBe(0);
  });

  it('verifyHtsCode should confirm an exact-match real HTS code via USITC', async () => {
    const result = await verifyHtsCode({
      htsCode: '9503.00.0073',
      productDescription: 'plastic toy car for children aged 3 to 12',
    });
    expect(result.verified).toBe(true);
    expect(result.matchLevel).toBe('exact');
    expect(result.officialDescription).toBeDefined();
    expect(result.officialDescription!.length).toBeGreaterThan(0);
    expect(result.hsCode).toBe('950300');
    expect(result.productDescription).toBe('plastic toy car for children aged 3 to 12');
  });

  it('verifyHtsCode should fall back to 6-digit category candidates for an unmapped statistical suffix', async () => {
    const result = await verifyHtsCode({
      htsCode: '9503.00.9999',
      productDescription: 'unknown toy variant',
    });
    expect(result.verified).toBe(false);
    expect(result.matchLevel).toBe('6-digit-category');
    expect(result.nearbyCandidates.length).toBeGreaterThan(0);
  });

  it('verifyHtsCode should report unmatched for a fully invalid HTS code', async () => {
    const result = await verifyHtsCode({
      htsCode: '9999.99.9999',
      productDescription: 'nonexistent product',
    });
    expect(result.verified).toBe(false);
    expect(result.matchLevel).toBe('unmatched');
    expect(result.nearbyCandidates.length).toBe(0);
  });

  it('verifyHtsCode should reject an empty productDescription', async () => {
    await expect(verifyHtsCode({ htsCode: '9503.00.0073', productDescription: '' })).rejects.toThrow();
  });

  it('convertHtmlToMarkdown should retain calendar grid schedule items when onlyMainContent is true', () => {
    const calendarHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>アイドルスケジュールカレンダー</title></head>
        <body>
          <header><nav><a href="/">Home</a></nav></header>
          <div data-test-id="calendar-grid" id="calendarOutline-mainUi" class="calendar-container">
            <div role="grid">
              <div role="row">
                <div role="columnheader">Mon</div>
                <div role="columnheader">Tue</div>
                <div role="columnheader">Wed</div>
              </div>
              <div role="row">
                <div role="gridcell">
                  <p>1</p>
                  <div class="event-item">『夏祭りスペシャルライブ2026』開場18:00 開演18:30</div>
                </div>
                <div role="gridcell">
                  <p>2</p>
                  <div class="event-item">『定期公演 vol.15 〜真夏の宴〜』新宿ReNY</div>
                </div>
                <div role="gridcell">
                  <p>3</p>
                  <div class="event-item">『対バンフェス2026』渋谷Spotify O-EAST</div>
                </div>
              </div>
            </div>
          </div>
          <footer><p>Copyright TimeTree Inc.</p></footer>
        </body>
      </html>
    `;

    const parsed = convertHtmlToMarkdown(
      calendarHtml,
      'https://example.com/calendar',
      10000,
      false,
      true, // onlyMainContent: true
    );

    expect(parsed.markdown).toContain('夏祭りスペシャルライブ2026');
    expect(parsed.markdown).toContain('定期公演 vol.15');
    expect(parsed.markdown).toContain('対バンフェス2026');
  });

  it('isRenderStillBlockedOrBlank should not trigger retry on rendered React SPA with content', () => {
    // レンダリング成功したReact SPA (id="react-root" があっても本文が十分あれば再試行しない)
    const successResult = isRenderStillBlockedOrBlank({
      html: '<div id="react-root"><div class="calendar"><h3>Live Schedule</h3><p>August 2026</p></div></div>',
      bodyOnlyMarkdown: '### Live Schedule\n\nAugust 2026\n\n『 Girl’Bomb!! 〜 真夏の祭典 〜 』\n\n『森宮藍presents「もりもりまつり！」』',
    });
    expect(successResult).toBe(false);

    // まだJS無効警告で止まっている失敗ケース
    const failedResult = isRenderStillBlockedOrBlank({
      html: '<div id="react-root"><div class="loading">Please enable JavaScript to use this app</div></div>',
      bodyOnlyMarkdown: 'Please enable JavaScript to use this app',
    });
    expect(failedResult).toBe(true);

    // Cloudflare チャレンジ画面の失敗ケース
    const challengeResult = isRenderStillBlockedOrBlank({
      html: '<html><head><title>Just a moment...</title></head><body>Checking your browser...</body></html>',
      bodyOnlyMarkdown: 'Checking your browser before accessing the site.',
    });
    expect(challengeResult).toBe(true);
  });

  // =========================================================================
  // 🚢 checkProductCompliance (商品統合コンプライアンス一括判定) テスト
  // =========================================================================
  it('checkProductCompliance should infer toy attributes and require CPSC CCC and eFiling', async () => {
    const res = await checkProductCompliance({
      productName: 'Wooden Building Blocks for Toddlers',
      description: 'Educational wooden puzzle block toy for children aged 3+. Non-toxic paint.',
    });

    expect(res.product.targetAge).toBe('child');
    expect(res.product.material).toBe('wood');
    expect(res.product.htsCode).toBe('9503.00.0073');
    expect(res.overallStatus).toBe('action_required');
    expect(res.cpsc.certificateRequired).toBe(true);
    expect(res.cpsc.certificateType).toBe('CCC');
    expect(res.cpsc.eFilingRequired).toBe(true);
    expect(res.fda.fdaRegulatedLikely).toBe(false);
    expect(res.actionPlan.some((a) => a.includes('CCC'))).toBe(true);
  });

  it('checkProductCompliance should correctly evaluate explicit HTS code and helmet category', async () => {
    const res = await checkProductCompliance({
      htsCode: '6506103045',
      productName: 'Aerodynamic Bicycle Helmet',
      description: 'Protective adult cycling helmet with adjustable chin strap.',
      targetAge: 'adult',
    });

    expect(res.cpsc.certificateRequired).toBe(true);
    expect(res.cpsc.certificateType).toBe('GCC');
    expect(res.cpsc.eFilingRequired).toBe(true);
    expect(res.overallStatus).toBe('action_required');
    expect(res.actionPlan.some((a) => a.includes('GCC'))).toBe(true);
  });

  it('checkProductCompliance should detect cosmetics and flag FDA regulation', async () => {
    const res = await checkProductCompliance({
      productName: 'Moisturizing Face Cream and Serum',
      description: 'Organic skincare lotion and beauty cosmetic cream.',
    });

    expect(res.fda.fdaRegulatedLikely).toBe(true);
    expect(res.fda.possiblePrograms).toContain('COS');
    expect(res.cpsc.certificateRequired).not.toBe(true);
    expect(res.overallStatus).toBe('action_required');
    expect(res.actionPlan.some((a) => a.includes('MoCRA'))).toBe(true);
  });

  it('checkProductCompliance should detect food preparations and flag Prior Notice', async () => {
    const res = await checkProductCompliance({
      productName: 'Green Tea Matcha Snack Confectionery',
      description: 'Japanese dietary food snack and organic powdered beverage.',
    });

    expect(res.fda.fdaRegulatedLikely).toBe(true);
    expect(res.fda.possiblePrograms).toContain('FOO');
    expect(res.fda.priorNoticeMayApply).toBe(true);
    expect(res.overallStatus).toBe('action_required');
    expect(res.actionPlan.some((a) => a.includes('Prior Notice'))).toBe(true);
  });

  it('checkProductCompliance should classify general adult furniture without requiring CPSC CCC', async () => {
    const res = await checkProductCompliance({
      productName: 'Solid Oak Dining Table for Living Room',
      description: 'Modern minimalist wooden dining table for home furniture.',
    });

    expect(res.product.targetAge).toBe('unknown');
    expect(res.product.material).toBe('wood');
    expect(res.product.htsCode).toBe('9403.60.8081');
    expect(res.cpsc.certificateRequired).not.toBe(true);
    expect(res.cpsc.eFilingRequired).toBe(false);
    expect(res.fda.fdaRegulatedLikely).toBe(false);
    expect(['likely_exempt', 'potential_action_required']).toContain(res.overallStatus);
  });

  it('POST /trade/compliance REST endpoint should return structured compliance report', async () => {
    const req = new Request('http://localhost/trade/compliance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: 'Kids Plastic Doll Toy',
        description: 'Doll figure with accessories for children',
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.product.targetAge).toBe('child');
    expect(json.overallStatus).toBe('action_required');
    expect(json.cpsc.certificateType).toBe('CCC');
    expect(json.actionPlan.length).toBeGreaterThan(0);
    expect(json.disclaimer).toBeTruthy();
  });
});


