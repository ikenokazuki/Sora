import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@hono/mcp';
import { z } from 'zod';
import {
  scrapeUrl,
  callYahooMcp,
  searchYahooWeb,
  integratedSearch,
  mapSiteUrl,
  crawlSiteUrl,
  fetchRealtimeTrends,
  filterByDomains,
  searchYahooImage,
  searchYahooVideo,
  searchYahooNews,
  searchYahooChiebukuro,
  getSuggestedKeywords,
  searchTransitRoute,
  fetchWeatherForecast,
} from './scraper.js';

export type GhostFetchModule = 'web' | 'yahoo' | 'life';

export interface McpServerOptions {
  modules?: (GhostFetchModule | 'all')[];
}

/** モジュールが有効化されているかを判定 */
export function isModuleActive(mod: GhostFetchModule, explicitModules?: (GhostFetchModule | 'all')[]): boolean {
  if (explicitModules && explicitModules.length > 0) {
    if (explicitModules.includes('all')) return true;
    return explicitModules.includes(mod);
  }
  const envVal = process.env.ENABLED_MODULES?.toLowerCase().trim();
  if (!envVal || envVal === 'all' || envVal === '*') return true;
  const activeList = envVal.split(',').map((s) => s.trim());
  return activeList.includes(mod) || activeList.includes('all');
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const mcpServer = new McpServer({
    name: 'GhostFetch',
    version: '2.0.0',
  });

  const shouldEnableWeb = isModuleActive('web', options?.modules);
  const shouldEnableYahoo = isModuleActive('yahoo', options?.modules);
  const shouldEnableLife = isModuleActive('life', options?.modules);

  // =========================================================================
  // 🌐 Category 1: Core Web & Crawling (モジュール: 'web')
  // =========================================================================
  if (shouldEnableWeb) {
    // Tool 1: scrape (単一 URL / PDF スクレイプ)
    mcpServer.tool(
      'scrape',
      '指定した URL の Web ページまたは PDF をスクレイピングし、記事本文をクリーンな Markdown に変換して返却します。動的・SPA サイトは自動で Stealth Chromium でレンダリングされます。',
      {
        url: z.string().url().describe('スクレイピング対象の完全な URL (http/https)'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe('抽出する最大文字数 (デフォルト: 30000)'),
        mode: z
          .enum(['auto', 'fast', 'browser'])
          .optional()
          .describe('スクレイプ動作モード: "auto" (スマート自動判定, デフォルト), "fast" (静的フェッチ最速限定), "browser" (Stealth Chromium JS完全実行)'),
        fastOnly: z
          .boolean()
          .optional()
          .describe('【互換用】静的フェッチのみに限定するか (mode: "fast" と同等)'),
        renderJs: z
          .boolean()
          .optional()
          .describe('【互換用】Stealth Chromium で JS 完全実行するか (mode: "browser" と同等)'),
        extractHighlights: z
          .boolean()
          .optional()
          .describe('クエリに関連する重要文（ハイライト）を自動抽出して付与するか (デフォルト: false)'),
        query: z
          .string()
          .optional()
          .describe('ハイライト抽出に使用するキーワード・検索文'),
        proxyUrl: z
          .string()
          .optional()
          .describe('経由する HTTP/HTTPS/SOCKS5 プロキシ URL (例: "http://user:pass@host:port")'),
      },
      async ({ url, maxChars, mode, fastOnly, renderJs, extractHighlights, query, proxyUrl }) => {
        try {
          const result = await scrapeUrl({ url, maxChars, mode, fastOnly, renderJs, extractHighlights, query, proxyUrl });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Scrape error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 2: search_deep (超高精度 統合検索)
    mcpServer.tool(
      'search_deep',
      '【超高精度 統合検索】Web 検索を実行し、上位 Web サイトの本文を並行スクレイピング＋リアルタイム最新情報（X）を一括取得して LLM の回答生成に最適な形式で返却します。',
      {
        query: z.string().min(1).describe('検索キーワード'),
        limit: z.number().int().min(1).max(10).optional().describe('スクレイピングする上位結果の件数 (デフォルト: 3)'),
        scrapeContent: z.boolean().optional().describe('上位結果のページ本文を Markdown で取得するか (デフォルト: true)'),
        includeRealtime: z.boolean().optional().describe('リアルタイム速報（Xの生の声）を含めるか (デフォルト: true)'),
        maxChars: z.number().int().positive().max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
        includeDomains: z.array(z.string()).optional().describe('検索結果を絞り込むドメインリスト'),
        excludeDomains: z.array(z.string()).optional().describe('除外するドメインリスト'),
      },
      async ({ query, limit, scrapeContent, includeRealtime, maxChars, includeDomains, excludeDomains }) => {
        try {
          const result = await integratedSearch({
            query,
            limit,
            scrapeContent,
            includeRealtime,
            maxChars,
            includeDomains,
            excludeDomains,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 3: map_site (サイトマップ探索)
    mcpServer.tool(
      'map_site',
      '指定 URL のサイトマップ (sitemap.xml) またはページ内リンクを探索し、サイト内の URL 一覧を抽出します。ドメイン全体のページ構成把握に最適です。',
      {
        url: z.string().url().describe('探索対象の Web サイト URL (例: "https://example.com")'),
        limit: z.number().int().min(1).max(500).optional().describe('取得する最大 URL 件数 (デフォルト: 100)'),
      },
      async ({ url, limit }) => {
        try {
          const result = await mapSiteUrl({ url, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Map site error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 4: crawl_site (サイト内再帰クロール)
    mcpServer.tool(
      'crawl_site',
      '指定 URL を起点として同一ドメイン配下の Web ページを再帰的に巡回（クロール）し、各ページの Markdown 本文を一括収集します。ドキュメントサイト等のまとめ読みに最適です。',
      {
        url: z.string().url().describe('クロール開始 URL (例: "https://example.com/docs")'),
        maxPages: z.number().int().min(1).max(20).optional().describe('巡回する最大ページ数 (デフォルト: 5)'),
        maxChars: z.number().int().positive().max(50_000).optional().describe('1ページあたりの最大文字数 (デフォルト: 15000)'),
      },
      async ({ url, maxPages, maxChars }) => {
        try {
          const result = await crawlSiteUrl({ url, maxPages, maxChars });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Crawl site error: ${err?.message || err}` }],
          };
        }
      },
    );
  }

  // =========================================================================
  // 🇯🇵 Category 2: Yahoo! JAPAN Services (モジュール: 'yahoo')
  // =========================================================================
  if (shouldEnableYahoo) {
    // Tool 5: search_web (Yahoo Japan Web 検索)
    mcpServer.tool(
      'search_web',
      'Yahoo! JAPAN Web 検索を実行し、タイトル・概要スニペット・URL を取得します。期間指定（24h/1週間/1年）や特定ドメインの絞り込み・除外が可能です。',
      {
        query: z.string().min(1).describe('検索キーワード'),
        includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメインリスト (例: ["natalie.mu", "oricon.co.jp"])'),
        excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメインリスト'),
        updated: z.enum(['all', 'day', 'week', 'year']).optional().describe('期間指定: "all"(指定なし), "day"(24時間以内), "week"(1週間以内), "year"(1年以内)'),
      },
      async ({ query, includeDomains, excludeDomains, updated }) => {
        try {
          const result = await searchYahooWeb({ query, includeDomains, excludeDomains, updated });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 6: search_image (Yahoo 画像検索)
    mcpServer.tool(
      'search_image',
      'Yahoo! JAPAN 画像検索を実行し、画像の URL・サムネイル・寸法（幅/高さ）・元ページ URL を取得します。',
      {
        query: z.string().min(1).describe('画像検索キーワード'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooImage({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Image search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 7: search_video (Yahoo 動画検索)
    mcpServer.tool(
      'search_video',
      'Yahoo! JAPAN 動画検索を実行し、YouTube 等の動画 URL・タイトル・再生時間・サムネイルを取得します。',
      {
        query: z.string().min(1).describe('動画検索キーワード'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooVideo({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Video search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 8: search_news (Yahoo ニュース検索)
    mcpServer.tool(
      'search_news',
      'Yahoo! ニュース検索を実行し、最新の報道記事（タイトル・サマリー・配信メディア・配信日時・記事 URL）を取得します。',
      {
        query: z.string().min(1).describe('ニュース検索キーワード'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooNews({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `News search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 9: search_chiebukuro (Yahoo 知恵袋検索)
    mcpServer.tool(
      'search_chiebukuro',
      'Yahoo! 知恵袋の Q&A 検索を実行し、質問タイトル・本文スニペット・回答数・解決ステータス（解決済/受付中）を取得します。人々の悩みやリアルな体験談の調査に最適です。',
      {
        query: z.string().min(1).describe('知恵袋検索キーワード'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooChiebukuro({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Chiebukuro search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 10: suggest_keywords (サジェスト / キーワード補完)
    mcpServer.tool(
      'suggest_keywords',
      'Yahoo! JAPAN のキーワード補完サジェストを取得し、指定語句に関連する入力候補・よく一緒に検索されるキーワードを返します。',
      {
        query: z.string().min(1).describe('検索語句プレフィックス'),
        limit: z.number().int().min(1).max(30).optional().describe('取得件数 (デフォルト: 10)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await getSuggestedKeywords({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Suggest error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 11: search_realtime (Yahoo リアルタイム検索)
    mcpServer.tool(
      'search_realtime',
      'Yahoo! リアルタイム検索を実行し、X (旧 Twitter) 上の最新の生の声・ポスト一覧（投稿者・本文・投稿日時・メディア・URL）を取得します。',
      {
        query: z.string().min(1).describe('リアルタイム検索キーワード'),
      },
      async ({ query }) => {
        try {
          const result = await callYahooMcp('search_realtime', { query });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Realtime search error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 12: search_trend (Yahoo トレンド急上昇)
    mcpServer.tool(
      'search_trend',
      'Yahoo! リアルタイム検索の「急上昇トレンドワード」ランキング（現在バズっているホットな話題 20 件）を取得します。',
      {
        limit: z.number().int().min(1).max(50).optional().describe('取得するトレンド件数 (デフォルト: 20)'),
      },
      async ({ limit }) => {
        try {
          const result = await fetchRealtimeTrends(limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Trend search error: ${err?.message || err}` }],
          };
        }
      },
    );
  }

  // =========================================================================
  // 🗾 Category 3: Japan Daily Life & Transit (モジュール: 'life')
  // =========================================================================
  if (shouldEnableLife) {
    // Tool 13: search_route (Yahoo 乗換案内)
    mcpServer.tool(
      'search_route',
      'Yahoo! 乗換案内を利用し、日本全国の鉄道・新幹線・路線バス・高速バス・フェリーの最適ルート、所要時間、乗換回数、運賃（IC/きっぷ）を検索します。',
      {
        from: z.string().min(1).describe('出発駅・バス停・施設名 (例: "新宿", "東京駅")'),
        to: z.string().min(1).describe('到着駅・バス停・施設名 (例: "横浜", "京都")'),
        via: z.array(z.string()).max(3).optional().describe('経由駅リスト (最大3駅, 例: ["品川"])'),
        date: z.string().regex(/^\d{8}$/).optional().describe('検索日 (YYYYMMDD形式, 例: "20260821")'),
        time: z.string().regex(/^\d{4}$/).optional().describe('検索時刻 (HHMM形式, 例: "0930")'),
        timeType: z.enum(['departure', 'arrival', 'first_train', 'last_train']).optional()
          .describe('時刻指定タイプ: "departure"(出発時刻), "arrival"(到着時刻), "first_train"(始発), "last_train"(終電)'),
        ticket: z.enum(['ic', 'cash']).optional().describe('運賃タイプ: "ic"(IC運賃), "cash"(きっぷ運賃)'),
        seatPreference: z.enum(['non_reserved', 'reserved', 'green']).optional()
          .describe('座席指定: "non_reserved"(自由席), "reserved"(指定席), "green"(グリーン車)'),
        walkSpeed: z.enum(['fast', 'slightly_fast', 'slightly_slow', 'slow']).optional()
          .describe('歩く速度'),
        sortBy: z.enum(['time', 'transfer', 'fare']).optional()
          .describe('並び順: "time"(早い順), "transfer"(乗り換え少ない順), "fare"(安い順)'),
        useAirline: z.boolean().optional().describe('空路を使う (デフォルト: true)'),
        useShinkansen: z.boolean().optional().describe('新幹線を使う (デフォルト: true)'),
        useExpress: z.boolean().optional().describe('有料特急を使う (デフォルト: true)'),
        useHighwayBus: z.boolean().optional().describe('高速バスを使う (デフォルト: true)'),
        useLocalBus: z.boolean().optional().describe('路線バスを使う (デフォルト: true)'),
        useFerry: z.boolean().optional().describe('フェリーを使う (デフォルト: true)'),
      },
      async (opts) => {
        try {
          const result = await searchTransitRoute(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Transit route error: ${err?.message || err}` }],
          };
        }
      },
    );

    // Tool 14: get_weather (日本の天気予報 - 気象庁公式オープンデータ直結)
    mcpServer.tool(
      'get_weather',
      '気象庁公式オープンデータ直結による日本全国の天気予報を取得します。全国 1,805 市区町村名（例: "天童市", "軽井沢", "箱根", "浦安", "別府", "石垣島"）または都道府県名・地点IDから、今日・明日・明後日の天気、風・波、予想気温、降水確率、気象台概況文を返します。',
      {
        city: z.string().min(1).describe('市区町村名または都道府県名（例: "天童市", "軽井沢", "箱根", "浦安", "東京", "大阪", "福岡", "那覇"）、もしくは6桁の地点ID（例: "130010"）'),
        days: z.number().int().min(1).max(3).optional().describe('取得する予報日数 (1〜3日, デフォルト: 3)'),
      },
      async ({ city, days }) => {
        try {
          const result = await fetchWeatherForecast({ city, days });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Weather forecast error: ${err?.message || err}` }],
          };
        }
      },
    );
  }

  return mcpServer;
}

export function createMcpTransport(options?: any) {
  return new StreamableHTTPTransport(options);
}
