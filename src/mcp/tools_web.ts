import { z } from 'zod';
import { crawlSiteUrl, integratedSearch, mapSiteUrl, scrapeBatchUrls, scrapeUrl } from '../scraper.js';
import { formatCompactScrapeResult } from '../response_cleaner.js';
import { SEARCH_WEB_INPUT_SHAPE, searchWebWithFormats } from '../search_web_formats.js';
import { serializeIntegratedSearchMcpResponse } from '../integrated_search_host_response.js';
import { ANNOTATE_TEMPORAL_FIELD, INTEGRATED_SEARCH_INPUT_SHAPE, MAP_SINCE_DESCRIPTION, MAP_UNTIL_DESCRIPTION, SCRAPE_BATCH_MAX_CHARS, SCRAPE_HEADERS_FIELD, SCRAPE_INCLUDE_MEDIA_FIELD, SCRAPE_MASK_PII_FIELD, SCRAPE_MODE_FIELD, SCRAPE_RESPONSE_MODE_FIELD, ScrapeFormatSchema } from '../types.js';
import { SocialPlatformSchema } from '../services/country_intel/types.js';
import { errorMessage } from '../errors.js';
import { defaultXDetailProvider, fetchXPostDetail } from '../services/x_detail.js';
import { registerTool, toolJson } from './registry.js';
import { exactlyOne, onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🌐 Category 1: Core Web & Crawling (モジュール: 'web') */
export function registerWebTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, serverTenantId, options } = context;
  // Tool 1: scrape (URL / PDF スクレイプ。urls で一括並行) - CORE (defaultEnabled: true)
  const SCRAPE_USAGE = '使い方: 1 ページは url、複数ページ（最大 20 件）は urls。concurrency・webhookUrl は urls のとき、fullPage・keepDataImages は url のときだけ。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。引数の mode（auto・fast・browser）と紛れないよう、入力の形で言う
  const WITH_URL = 'url を指定したとき';
  const WITH_URLS = 'urls を指定したとき';
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'scrape',
    'web',
    '【URL・PDF本文抽出】Webページ・PDFの本文をクリーンなMarkdownで取得（既知URLの精読・本文抽出）。urls で最大20件を並行取得。動的・SPAサイトの描画待機、イベント構造化、テーブル2D正規化に対応。候補URL探索は search_web / search_deep、サイト巡回は crawl_site、対話操作は browser_action。返却: { url, title, content, highlights?, tables?, events? }',
    {
      url: z.string().url().optional().describe('スクレイピング対象の完全な URL (http/https) (例: "https://example.com/article")。url か urls のどちらか 1 つ'),
      urls: z.array(z.string().url()).min(1).max(20).optional().describe('複数ページを一括取得するときの URL 配列 (最大 20 件)。ドメインごとの間隔を守りながら並行取得する。応答は { total, successful, failed, results, errors } で、results は入力の順ではなく、取得が終わった順'),
      concurrency: z.number().int().min(1).max(5).optional().describe('urls の並行フェッチワーカー数 (デフォルト: 3, 最大: 5)').meta({ default: 3 }),
      webhookUrl: z.string().url().optional().describe('urls の取得完了時に、応答と同じ整形後の結果を 1 回だけ通知する Webhook URL (非同期)'),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe(`抽出する最大文字数 (デフォルト: 30000)。urls のときは 1 ページあたりで、${SCRAPE_BATCH_MAX_CHARS} まで`).meta({ default: 30000 }),
      mode: SCRAPE_MODE_FIELD,
      formats: z.array(ScrapeFormatSchema)
        .optional()
        .describe('取得するコンテンツ形式: "markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables" (デフォルト: ["markdown"])').meta({ default: ['markdown'] }),
      fullPage: z
        .boolean()
        .optional()
        .describe('スクリーンショット撮影時にページ最下部までフルページ撮影するか (デフォルト: true)。url のときだけ').meta({ default: true }),
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
        .describe('base64 インライン画像を Markdown 内で置換せず保持するか (デフォルト: false, [画像: alt] に軽量化)。url のときだけ').meta({ default: false }),
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
    async (args) => {
      // 引数の mode（auto・fast・browser）とは別。url か urls かで決まる
      const toolMode = args.urls ? WITH_URLS : WITH_URL;
      // 既定値は、上のスキーマの .meta({ default }) と同じ値
      const invalid = exactlyOne(args, ['url', 'urls'], SCRAPE_USAGE)
        ?? onlyForMode(toolMode, [WITH_URLS], args, ['concurrency', 'webhookUrl'], SCRAPE_USAGE, { concurrency: 3 })
        ?? onlyForMode(toolMode, [WITH_URL], args, ['fullPage', 'keepDataImages'], SCRAPE_USAGE, { fullPage: true, keepDataImages: false });
      if (invalid) return usageError(invalid);
      // スキーマは url のときの上限（100000）まで通す。urls のときは、REST の /scrape/batch と同じ上限
      if (toolMode === WITH_URLS && (args.maxChars ?? 0) > SCRAPE_BATCH_MAX_CHARS) {
        return usageError(`urls のときの maxChars は ${SCRAPE_BATCH_MAX_CHARS} までです（いま: ${args.maxChars}）。${SCRAPE_USAGE}`);
      }
      const { url, urls, concurrency, webhookUrl, fullPage, keepDataImages, ...common } = args;
      const { verbose } = common;
      if (urls) {
        try {
          const result = await scrapeBatchUrls({ ...common, urls, tenantId: serverTenantId, concurrency, webhookUrl });
          const formattedResults = result.results?.map((r) => formatCompactScrapeResult(r, { verbose })) ?? [];
          return { content: [{ type: 'text', text: toolJson({ ...result, results: formattedResults }, verbose) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Batch scrape error: ${errorMessage(err) || err}` }] };
        }
      }
      try {
        const result = await scrapeUrl({ ...common, url: url!, tenantId: serverTenantId, fullPage: fullPage ?? true, keepDataImages });
        const formatted = formatCompactScrapeResult(result, { verbose });
        return { content: [{ type: 'text', text: toolJson(formatted, verbose) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Scrape error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['スクレイプ', 'Web抽出', 'URL', 'Markdown', 'PDF', '記事本文', 'scrape_batch', '一括スクレイプ', '一括取得', '複数URL', '並行取得', 'バッチ'] },
  );

  // Tool 2: search_deep (超高精度 統合検索・本文一括取得) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_deep',
    'web',
    '【万能深層Web検索・包括調査】Web検索＋上位サイト本文の自動スクレイピング＋Xリアルタイム速報を一括取得し、深層エビデンス駆動リランキングで根拠のあるソースを上位にする（Web+X統合深層調査）。最新事実、ライブ・公演日程、新製品・発売日、営業時間、人物動向等の包括調査に。返却量は responseMode（既定 evidence / full）。候補URL探索は search_web、既知URLの精読は scrape。返却: { query, count, schedule?, results: [{ url, title, markdown?, highlights? }], realtime?, contextSufficiency? }',
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

  // Tool 3: crawl_site (サイト内再帰クロール。listOnly で URL 一覧だけ) - DEFERRED
  const CRAWL_USAGE = '使い方: 本文を巡回するなら listOnly を省く（maxPages・maxChars・includePatterns などが効く）。URL の一覧だけなら listOnly: true（limit・since・until が効く）。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
  const LIST_ONLY_TRUE = 'listOnly: true のとき';
  const LIST_ONLY_OFF = 'listOnly が無い（false を含む）とき';
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'crawl_site',
    'web',
    '【同一サイト内再帰巡回・URL一覧】指定 URL を起点として同一ドメイン配下の Web ページを再帰的に巡回（クロール）し、複数ページの Markdown 本文を一括収集します（同一サイトの複数ページ巡回）。ドキュメントサイト等のまとめ読みに最適です。listOnly: true なら本文を取らず、サイトマップ (sitemap.xml) またはページ内リンクからサイト内の URL 一覧だけを高速抽出します。単一ページの取得は scrape、動的対話操作は browser_action を使用してください。返却: { url, baseUrl, count, totalPages, pages: [{ url, title, content }] }。listOnly は { url, links, count, source }',
    {
      url: z.string().url().describe('クロール開始 URL、または URL 一覧を探索するサイトの URL (例: "https://example.com/docs")'),
      listOnly: z.boolean().optional().describe('true なら本文を取らず、サイトマップ (sitemap.xml) かページ内リンクから URL 一覧だけを返す (デフォルト: false)').meta({ default: false }),
      limit: z.number().int().min(1).max(1000).optional().describe('listOnly のとき、取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)。since・until で絞ってから件数で切る').meta({ default: 200 }),
      since: z.string().optional().describe(`listOnly のとき: ${MAP_SINCE_DESCRIPTION}`),
      until: z.string().optional().describe(`listOnly のとき: ${MAP_UNTIL_DESCRIPTION}`),
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
    async (args) => {
      const mode = args.listOnly === true ? LIST_ONLY_TRUE : LIST_ONLY_OFF;
      // 既定値は、上のスキーマの .meta({ default }) と同じ値
      const invalid = onlyForMode(mode, [LIST_ONLY_TRUE], args, ['limit', 'since', 'until'], CRAWL_USAGE, { limit: 200 })
        ?? onlyForMode(mode, [LIST_ONLY_OFF], args, ['maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'responseMode', 'annotateTemporal', 'highlightMaxCount', 'includeMedia'], CRAWL_USAGE, { maxPages: 10, maxChars: 15000, formats: ['markdown'], responseMode: 'full', annotateTemporal: false, includeMedia: true });
      if (invalid) return usageError(invalid);
      const { url, listOnly, limit, since, until, ...crawl } = args;
      if (listOnly) {
        try {
          return { content: [{ type: 'text', text: toolJson(await mapSiteUrl({ url, limit, since, until })) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Crawl site (listOnly) error: ${errorMessage(err) || err}` }] };
        }
      }
      try {
        return { content: [{ type: 'text', text: toolJson(await crawlSiteUrl({ ...crawl, url, tenantId: serverTenantId })) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Crawl site error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['クロール', 'サイト巡回', '再帰巡回', '全ページ取得', 'まとめ読み', 'ドメイン探索', '一括収集', 'map_site', 'サイトマップ', 'URL一覧', 'サイト構造', 'リンク収集'] },
  );

  // Tool 5: search_web (基本 Web 検索 + optional requested-format extraction) - CORE
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_web',
    'web',
    '【万能Web検索・候補探索】ニュース、イベント日程、発売日、営業時間、公式告知などの候補URLと概要スニペットを高速探索（URL/スニペット探索）。formats 指定で上位結果の本文や指定形式も同じ呼び出しで返す。深層調査は search_deep、既知URLの精読は scrape。返却: { count, items: [{ title, url, snippet, markdown? }] }',
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
    '【公開SNS投稿検索】Weiboのキーワード新着検索と、Threads/Instagram/Facebookの公開投稿の発見＋本文取得。追加費用・ログイン不要。Xは対象外（search_realtime を使う）。返却: { status, platform, query, searchMode, items: [{ id, url, author, text, textKind, publishedAt, timeStatus, inRequestedWindow, method, metrics, comments }], matchedInWindow, unknownTime, excluded, failures }。status が partial/unavailable なら failures を確認、empty は一致なし。',
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
  // Tool 5c: fetch_social_post (既知SNS投稿の取得。X は statusId でも) - CORE
  // Weibo のコメントの既定の件数（説明・既定値の比較・ハンドラで補う値）
  const COMMENT_LIMIT_DEFAULT = 10;
  const SOCIAL_FETCH_USAGE = '使い方: 投稿の url（X・Weibo・Threads・Instagram・Facebook）。X は statusId でも可。commentLimit は X 以外のときだけ。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
  const X_POST = 'X の投稿を指定したとき';
  const OTHER_POST = 'X 以外の投稿を指定したとき';
  const isXUrl = (url: string): boolean => {
    try {
      return /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  };
  const xDetail = options?.xDetailProvider ?? defaultXDetailProvider;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'fetch_social_post',
    'web',
    '【既知SNS投稿の取得】X/Weibo/Threads/Instagram/Facebookの公開投稿URL（Xは statusId でも可）から本文・日時・反応を取得。Weiboは長文・人気コメントも補完（Metaのコメントは対象外）。返却: { status, post?: { url, author, text, publishedAt, metrics, comments }, failures }。Xは { found, statusId, detail }',
    {
      url: z.string().optional().describe('公開投稿URL（X・Weibo・Threads・Instagram・Facebook）。X は search_realtime で見つけた 1 件の全文・投稿日時・メディアを FxTwitter 経由で取得（ID 突合検証済みのみ返し、未検証の推測は返さない）。url か statusId のどちらかは必須'),
      statusId: z.string().optional().describe('X 投稿の数値ステータスID (例: "2100871827090501852")。url の代わりに指定可。X だけ'),
      commentLimit: z.number().int().min(0).max(20).optional().describe(`Weiboコメント取得件数 (デフォルト: ${COMMENT_LIMIT_DEFAULT}, Metaでは無視)。X 以外のときだけ`).meta({ default: COMMENT_LIMIT_DEFAULT }),
    },
    async (args) => {
      if (!args.url && !args.statusId) return usageError(`url・statusId のどちらかを指定してください。${SOCIAL_FETCH_USAGE}`);
      const mode = !args.url || isXUrl(args.url) ? X_POST : OTHER_POST;
      // 既定値は、上のスキーマの .meta({ default }) と同じ値
      const invalid = onlyForMode(mode, [X_POST], args, ['statusId'], SOCIAL_FETCH_USAGE)
        ?? onlyForMode(mode, [OTHER_POST], args, ['commentLimit'], SOCIAL_FETCH_USAGE, { commentLimit: COMMENT_LIMIT_DEFAULT });
      if (invalid) return usageError(invalid);
      if (mode === X_POST) {
        try {
          const result = await fetchXPostDetail({ statusId: args.statusId, url: args.url }, xDetail);
          if (!result.found) return { isError: true, content: [{ type: 'text', text: `X post not found: ${result.reason}` }] };
          return { content: [{ type: 'text', text: toolJson(result) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `X post fetch error: ${errorMessage(err) || err}` }] };
        }
      }
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
        const result = await svc.fetch({ url: args.url!, commentLimit: args.commentLimit ?? COMMENT_LIMIT_DEFAULT }, { signal, deadlineAt: Date.now() + 30000 });
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Social fetch error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['SNS', 'Weibo', '微博', 'Threads', 'Instagram', 'Facebook', '投稿取得', 'コメント', 'fetch_x_post', 'X', 'ツイート', 'ポスト', '全文', 'ステータス', 'status'] },
  );
}
