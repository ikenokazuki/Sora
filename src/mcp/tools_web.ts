import { z } from 'zod';
import { crawlSiteUrl, integratedSearch, mapSiteUrl, scrapeBatchUrls, scrapeUrl } from '../scraper.js';
import { formatCompactScrapeResult } from '../response_cleaner.js';
import { SEARCH_WEB_INPUT_SHAPE, searchWebWithFormats } from '../search_web_formats.js';
import { serializeIntegratedSearchMcpResponse } from '../integrated_search_host_response.js';
import { ANNOTATE_TEMPORAL_FIELD, INTEGRATED_SEARCH_INPUT_SHAPE, SCRAPE_BATCH_INPUT_SHAPE, SCRAPE_HEADERS_FIELD, SCRAPE_INCLUDE_MEDIA_FIELD, SCRAPE_MASK_PII_FIELD, SCRAPE_MODE_FIELD, SCRAPE_RESPONSE_MODE_FIELD, ScrapeFormatSchema } from '../types.js';
import { SocialPlatformSchema } from '../services/country_intel/types.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🌐 Category 1: Core Web & Crawling (モジュール: 'web') */
export function registerWebTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, serverTenantId } = context;
  // Tool 1: scrape (単一 URL / PDF スクレイプ) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'scrape',
    'web',
    '【単一URL・PDF本文抽出】既知 URL の Web ページまたは PDF の本文をクリーンな Markdown で取得します（既知URLの精読・本文抽出）。動的・SPA サイトの描画待機、イベント構造化、テーブル2D正規化に対応。候補URL探索は search_web / search_deep、サイト全体巡回は crawl_site、対話操作は browser_action。返却: { url, title, content, highlights?, tables?, events? }',
    {
      url: z.string().url().describe('スクレイピング対象の完全な URL (http/https) (例: "https://example.com/article")'),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe('抽出する最大文字数 (デフォルト: 30000)').meta({ default: 30000 }),
      mode: SCRAPE_MODE_FIELD,
      formats: z.array(ScrapeFormatSchema)
        .optional()
        .describe('取得するコンテンツ形式: "markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables" (デフォルト: ["markdown"])。screenshot はブラウザで撮り、mode "fast" では撮れずに warnings が付く').meta({ default: ['markdown'] }),
      fullPage: z
        .boolean()
        .optional()
        .default(true)
        .describe('スクリーンショット撮影時にページ最下部までフルページ撮影するか (デフォルト: true)'),
      responseMode: SCRAPE_RESPONSE_MODE_FIELD,
      stripLinks: z
        .boolean()
        .optional()
        .describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化し、LLM トークンを削減するか (デフォルト: false)').meta({ default: false }),
      maskPii: SCRAPE_MASK_PII_FIELD,
      query: z
        .string()
        .optional()
        .describe('ハイライト抽出に使用するキーワード・検索文'),
      onlyMainContent: z
        .boolean()
        .optional()
        .describe('記事本文のみを抽出するか (デフォルト: true)。false にするとナビゲーションやヘッダー/フッターも含めて抽出').meta({ default: true }),
      headers: SCRAPE_HEADERS_FIELD,
      verbose: z
        .boolean()
        .optional()
        .describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)').meta({ default: false }),
      keepDataImages: z
        .boolean()
        .optional()
        .describe('base64 インライン画像を Markdown 内で置換せず保持するか (デフォルト: false, [画像: alt] に軽量化)').meta({ default: false }),
      includeMedia: SCRAPE_INCLUDE_MEDIA_FIELD,
      annotateTemporal: ANNOTATE_TEMPORAL_FIELD,
      highlightMaxCount: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('ハイライトの件数。省略時は上位 3 件に、合計約 1,600 字に収まる節を足し（8 件まで）、拾えていない検索語を含む節も 1 つ足す。指定するとその件数まで'),
    },
    async ({ url, maxChars, mode, formats, fullPage, responseMode, stripLinks, maskPii, query, onlyMainContent, headers, verbose, keepDataImages, includeMedia, annotateTemporal, highlightMaxCount }) => {
      try {
        const result = await scrapeUrl({ url, tenantId: serverTenantId, maxChars, mode, formats, fullPage, responseMode, stripLinks, maskPii, query, onlyMainContent, headers, verbose, keepDataImages, includeMedia, annotateTemporal, highlightMaxCount });
        const formatted = formatCompactScrapeResult(result, { verbose });
        return {
          content: [
            {
              type: 'text',
              text: toolJson(formatted, verbose),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Scrape error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['スクレイプ', 'Web抽出', 'URL', 'Markdown', 'PDF', '記事本文'] },
  );

  // Tool 1.5: scrape_batch (複数 URL 一括並行スクレイプ) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'scrape_batch',
    'web',
    '【複数 URL 一括並行スクレイプ】複数の既知 URL を、ドメインごとの間隔を守りながら並行スクレイプし、各ページの本文を Markdown で一括取得します。1件だけなら scrape、同一サイトの巡回は crawl_site。返却: { total, successful, failed, results: [{ url, title, content }], errors: [{ url, error }] }。results は入力の順ではなく、取得が終わった順',
    SCRAPE_BATCH_INPUT_SHAPE,
    async ({ urls, concurrency, maxChars, mode, formats, headers, query, responseMode, stripLinks, maskPii, webhookUrl, onlyMainContent, verbose, annotateTemporal, highlightMaxCount, includeMedia }) => {
      try {
        const result = await scrapeBatchUrls({ urls, tenantId: serverTenantId, concurrency, maxChars, mode, formats, headers, query, responseMode, stripLinks, maskPii, webhookUrl, onlyMainContent, verbose, annotateTemporal, highlightMaxCount, includeMedia });
        const formattedResults = result.results?.map((r) => formatCompactScrapeResult(r, { verbose })) ?? [];
        return {
          content: [
            {
              type: 'text',
              text: toolJson({ ...result, results: formattedResults }, verbose),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Batch scrape error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['一括スクレイプ', '一括取得', '複数URL', '並行取得', 'バッチ'] },
  );

  // Tool 2: search_deep (超高精度 統合検索・本文一括取得) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_deep',
    'web',
    '【万能深層Web検索・包括調査】Web検索＋上位サイト本文自動スクレイピング＋Xリアルタイム速報を一括取得し、深層エビデンス駆動リランキングで回答根拠のあるソースを最上位化します（Web+X統合深層調査）。最新事実、ライブ・公演日程、新製品・発売日、営業時間、人物動向等の包括調査に使用します。返却量は responseMode（既定 evidence / full）で選べます。候補URL探索は search_web、既知URLの精読は scrape。返却: { query, count, schedule?, results: [{ url, title, markdown?, highlights? }], realtime?, contextSufficiency? }',
    INTEGRATED_SEARCH_INPUT_SHAPE,
    async ({ query, limit, scrapeContent, adaptiveScrape, scrapeBudget, includeRealtime, realtimeSort, realtimeFocus, realtimeAnchor, realtimeLimit, officialAccountId, maxChars, includeMedia, noCache, includeDomains, excludeDomains, updated, formats, onlyMainContent, verbose, annotateTemporal, highlightMaxCount, responseMode, maxTotalChars, scrapeDeadlineMs, videos }) => {
      try {
        const result = await integratedSearch({
          query,
          tenantId: serverTenantId,
          limit,
          scrapeContent,
          adaptiveScrape,
          scrapeBudget,
          scrapeDeadlineMs,
          videos,
          includeRealtime,
          realtimeSort,
          realtimeFocus,
          realtimeAnchor,
          realtimeLimit,
          officialAccountId,
          maxChars,
          noCache,
          includeDomains,
          excludeDomains,
          updated,
          formats,
          onlyMainContent,
          verbose,
          annotateTemporal,
          highlightMaxCount,
          includeMedia,
        });
        return {
          content: [{
            type: 'text',
            text: serializeIntegratedSearchMcpResponse(result, {
              responseMode,
              explicitFormats: formats,
              verbose,
              maxTotalChars,
              includeMedia,
            }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['深層検索', '統合検索', 'Web検索', '本文取得', 'X速報', 'スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報', 'deep_search', 'deep-search', 'deep search'] },
  );

  // Tool 3: map_site (サイトマップ探索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'map_site',
    'web',
    '【サイトマップ探索】指定 URL のサイトマップ (sitemap.xml) またはページ内リンクを探索し、サイト内の URL 一覧を高速抽出します。ドメイン全体のページ構成把握に最適です。本文が必要なら crawl_site / scrape_batch。返却: { url, links, count, source }',
    {
      url: z.string().url().describe('探索対象の Web サイト URL (例: "https://example.com")'),
      limit: z.number().int().min(1).max(1000).optional().describe('取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)').meta({ default: 200 }),
      since: z.string().optional().describe('指定した日付・日時以降に更新されたページのみを抽出するフィルタ (例: "2026-08-01", "2026-01-01T00:00:00Z")'),
      until: z.string().optional().describe('指定日時以前に更新された URL のみ抽出するフィルタ'),
    },
    async ({ url, limit, since, until }) => {
      try {
        const result = await mapSiteUrl({ url, limit, since, until });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Map site error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['サイトマップ', 'URL一覧', 'サイト構造', 'リンク収集'] },
  );

  // Tool 4: crawl_site (サイト内再帰クロール) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'crawl_site',
    'web',
    '【同一サイト内再帰巡回】指定 URL を起点として同一ドメイン配下の Web ページを再帰的に巡回（クロール）し、複数ページの Markdown 本文を一括収集します（同一サイトの複数ページ巡回）。ドキュメントサイト等のまとめ読みに最適です。単一ページの取得は scrape、動的対話操作は browser_action を使用してください。返却: { url, baseUrl, count, totalPages, pages: [{ url, title, content }] }',
    {
      url: z.string().url().describe('クロール開始 URL (例: "https://example.com/docs")'),
      maxPages: z.number().int().min(1).max(50).optional().describe('巡回する最大ページ数 (デフォルト: 10, 最大: 50)').meta({ default: 10 }),
      maxChars: z.number().int().min(1).max(50_000).optional().describe('1ページあたりの最大文字数 (デフォルト: 15000)').meta({ default: 15000 }),
      includePatterns: z.array(z.string()).optional().describe('クロール対象を絞り込むワイルドカードパターン一覧 (例: ["/docs/**", "/guide/*"])'),
      excludePatterns: z.array(z.string()).optional().describe('クロールから除外するワイルドカードパターン一覧 (例: ["/tag/**", "*.pdf"])'),
      formats: z.array(ScrapeFormatSchema).optional().describe('取得するコンテンツ形式 (デフォルト: ["markdown"])').meta({ default: ['markdown'] }),
      query: z.string().optional().describe('巡回ページからハイライトを抽出するキーワード'),
      responseMode: SCRAPE_RESPONSE_MODE_FIELD,
      annotateTemporal: ANNOTATE_TEMPORAL_FIELD,
      highlightMaxCount: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('ハイライトの件数。省略時は上位 3 件に、合計約 1,600 字に収まる節を足し（8 件まで）、拾えていない検索語を含む節も 1 つ足す。指定するとその件数まで'),
      includeMedia: SCRAPE_INCLUDE_MEDIA_FIELD,
    },
    async ({ url, maxPages, maxChars, includePatterns, excludePatterns, formats, query, responseMode, annotateTemporal, highlightMaxCount, includeMedia }) => {
      try {
        const result = await crawlSiteUrl({ url, tenantId: serverTenantId, maxPages, maxChars, includePatterns, excludePatterns, formats, query, responseMode, annotateTemporal, highlightMaxCount, includeMedia });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Crawl site error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['クロール', 'サイト巡回', '再帰巡回', '全ページ取得', 'まとめ読み', 'ドメイン探索', '一括収集'] },
  );

  // Tool 5: search_web (基本 Web 検索 + optional requested-format extraction) - CORE
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_web',
    'web',
    '【万能Web検索・候補探索】ニュース、イベント日程、発売日、営業時間、公式告知などの候補URLと概要スニペットを高速探索します（URL/スニペット探索）。formats を指定すると上位結果を追加スクレイプし、本文や指定形式を同じ呼び出しで返します（同一呼出での本文抽出）。深層調査は search_deep、既知URLの精読は scrape。返却: { count, items: [{ title, url, snippet, markdown? }] }',
    SEARCH_WEB_INPUT_SHAPE,
    async (options) => {
      try {
        const result = await searchWebWithFormats(options);
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Search error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['Web検索','検索','URL一覧','Google検索','Yahoo検索','イベント検索','告知検索','スケジュール','Markdown'] },
  );
  // Tool 5b: search_social_posts (公開SNS投稿検索: Weibo新着 / Meta公開投稿)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_social_posts',
    'web',
    '【公開SNS投稿検索】Weiboのキーワード新着検索、Threads/Instagram/Facebookの公開投稿の発見＋本文取得を行います。追加費用・ログイン不要。Xの投稿は対象外のため search_realtime を使ってください。返却: { status, platform, query, searchMode, items: [{ id, url, author, text, textKind, publishedAt, timeStatus, inRequestedWindow, method, metrics, comments }], matchedInWindow, unknownTime, excluded, failures }。status が partial/unavailable の場合は failures を確認し、empty は一致なしの意味です。',
    {
      platform: SocialPlatformSchema.describe('対象SNS'),
      query: z.string().min(1).max(500).describe('検索語（現地語推奨）'),
      limit: z.number().int().min(1).max(30).optional().default(10).describe('取得件数 (デフォルト: 10, 最大: 30)'),
      lookbackHours: z.number().int().min(1).max(2160).optional().default(24).describe('遡及時間 (デフォルト: 24, 最大: 2160)。Weiboは期間外を除外、Metaは索引期間の目安＋本文日時で再判定'),
    },
    async ({ platform, query, limit, lookbackHours }) => {
      try {
        const { createSocialService } = await import('../services/social/index.js');
        const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('../services/social/transport.js');
        const svc = createSocialService({
          weiboHttp: createProdWeiboHttp(),
          sessionOpener: createProdSessionOpener(),
          metaHttp: createProdMetaHttp(),
          metaBrowser: createProdMetaBrowser(),
          webSearch: createProdWebSearch(),
        });
        const signal = AbortSignal.timeout(55000);
        const result = await svc.search({ platform, query, limit: limit ?? 10, lookbackHours: lookbackHours ?? 24 }, { signal, deadlineAt: Date.now() + 55000 });
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Social search error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['SNS', 'Weibo', '微博', 'Threads', 'Instagram', 'Facebook', '投稿検索', 'ソーシャル'] },
  );
  // Tool 5c: fetch_social_post (既知SNS投稿の取得)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'fetch_social_post',
    'web',
    '【既知SNS投稿の取得】Weibo/Threads/Instagram/Facebookの公開投稿URLから本文・日時・反応を取得します。Weiboは長文・人気コメントの補完に対応（Metaのコメントは対象外）。Xの投稿は対象外のため fetch_x_post を使ってください。返却: { status, post?: { url, author, text, publishedAt, metrics, comments }, failures }',
    {
      url: z.string().min(1).describe('公開投稿URL'),
      commentLimit: z.number().int().min(0).max(20).optional().default(10).describe('Weiboコメント取得件数 (デフォルト: 10, Metaでは無視)'),
    },
    async ({ url, commentLimit }) => {
      try {
        const { createSocialService } = await import('../services/social/index.js');
        const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('../services/social/transport.js');
        const svc = createSocialService({
          weiboHttp: createProdWeiboHttp(),
          sessionOpener: createProdSessionOpener(),
          metaHttp: createProdMetaHttp(),
          metaBrowser: createProdMetaBrowser(),
          webSearch: createProdWebSearch(),
        });
        const signal = AbortSignal.timeout(30000);
        const result = await svc.fetch({ url, commentLimit: commentLimit ?? 10 }, { signal, deadlineAt: Date.now() + 30000 });
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Social fetch error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['SNS', 'Weibo', '微博', 'Threads', 'Instagram', 'Facebook', '投稿取得', 'コメント'] },
  );
}
