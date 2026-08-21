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

export function createMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'web-fetcher',
    version: '1.1.0',
  });

  // Tool 1: scrape (単一 URL / PDF スクレイプ)
  mcpServer.tool(
    'scrape',
    '指定した URL の Web ページまたは PDF をスクレイピングし、記事本文を Markdown 化して返却します。SPA サイトは自動で Chromium レンダリングにエスカレーションされます。',
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

  // Tool 2: search_web (Yahoo Japan Web 検索)
  mcpServer.tool(
    'search_web',
    'Yahoo Japan Web 検索を実行し、指定キーワードの上位検索結果（タイトル・概要スニペット・URL）を取得します。ドメイン絞り込みや期間指定（24h/1week/1year）も可能です。',
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
          content: [{ type: 'text', text: `Web search error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 3: search_realtime (Yahoo Japan リアルタイム検索)
  mcpServer.tool(
    'search_realtime',
    'Yahoo Japan リアルタイム検索を実行し、X (旧 Twitter) の最新ツイートおよび画像・リンク情報を取得します。各アイテムには source: "x" が付与されます。',
    {
      query: z.string().min(1).describe('検索キーワード'),
    },
    async ({ query }) => {
      try {
        const mcpRes = await callYahooMcp('yahoo_realtime_search', { query });
        const content = mcpRes?.content?.[0]?.text || '[]';
        let enrichedText = content;
        try {
          const json = JSON.parse(content);
          if (json && Array.isArray(json.items)) {
            json.items = json.items.map((item: any) => ({ source: 'x' as const, ...item }));
            json.source = 'x';
            enrichedText = JSON.stringify(json, null, 2);
          }
        } catch {}
        return {
          content: [{ type: 'text', text: enrichedText }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Realtime search error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 4: search_deep (Firecrawl / Tavily 互換統合深層検索)
  mcpServer.tool(
    'search_deep',
    'Firecrawl / Tavily 互換の統合深層検索。Web検索＋上位サイト本文自動スクレイピング（Markdown化）＋リアルタイム検索を一度に取得します。',
    {
      query: z.string().min(1).describe('検索キーワード'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('本文を取得する検索上位件数 (デフォルト: 3, 最大: 10)'),
      scrapeContent: z
        .boolean()
        .optional()
        .describe('上位サイトの本文をスクレイピングして含めるか (デフォルト: true)'),
      includeRealtime: z
        .boolean()
        .optional()
        .describe('リアルタイム検索結果を含めるか (デフォルト: true)'),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe('各ページの最大本文文字数 (デフォルト: 30000)'),
      includeDomains: z.array(z.string()).optional().describe('絞り込むドメインリスト'),
      excludeDomains: z.array(z.string()).optional().describe('除外するドメインリスト'),
      updated: z.enum(['all', 'day', 'week', 'year']).optional().describe('期間指定: "all", "day", "week", "year"'),
      proxyUrl: z.string().optional().describe('経由するプロキシ URL'),
      extractHighlights: z.boolean().optional().describe('クエリ関連ハイライトを抽出するか'),
    },
    async ({
      query,
      limit = 3,
      scrapeContent = true,
      includeRealtime = true,
      maxChars = 30000,
      includeDomains,
      excludeDomains,
      updated,
      proxyUrl,
      extractHighlights,
    }) => {
      try {
        const result = await integratedSearch({
          query,
          limit,
          scrapeContent,
          includeRealtime,
          maxChars,
          includeDomains,
          excludeDomains,
          updated,
          proxyUrl,
          extractHighlights,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Deep search error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 5: map_site (サイトマップ & URL マッピング)
  mcpServer.tool(
    'map_site',
    '指定した Web サイトの sitemap.xml や内部リンクを探索し、サイト内に存在する URL 一覧（サイトマップ）を高速抽出します。',
    {
      url: z.string().url().describe('探索対象のベース URL'),
      limit: z.number().int().min(1).max(500).optional().describe('取得する最大 URL 件数 (デフォルト: 100)'),
      includeSubdomains: z.boolean().optional().describe('サブドメインも含めるか (デフォルト: false)'),
      proxyUrl: z.string().optional().describe('経由するプロキシ URL'),
    },
    async ({ url, limit = 100, includeSubdomains = false, proxyUrl }) => {
      try {
        const result = await mapSiteUrl({ url, limit, includeSubdomains, proxyUrl });
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

  // Tool 6: crawl_site (サブページ再帰的クロール)
  mcpServer.tool(
    'crawl_site',
    '指定した URL 配下のページを再帰的にクロールし、複数ページの Markdown 本文を一括収集します。',
    {
      url: z.string().url().describe('クロール開始 URL'),
      maxPages: z.number().int().min(1).max(20).optional().describe('最大取得ページ数 (デフォルト: 5, 最大: 20)'),
      maxDepth: z.number().int().min(1).max(5).optional().describe('探索する最大リンク深度 (デフォルト: 2)'),
      maxChars: z.number().int().positive().max(100_000).optional().describe('各ページの最大本文文字数 (デフォルト: 15000)'),
      proxyUrl: z.string().optional().describe('経由するプロキシ URL'),
    },
    async ({ url, maxPages = 5, maxDepth = 2, maxChars = 15000, proxyUrl }) => {
      try {
        const result = await crawlSiteUrl({ url, maxPages, maxDepth, maxChars, proxyUrl });
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

  // Tool 7: search_trend (X / Yahoo リアルタイム急上昇トレンド分析)
  mcpServer.tool(
    'search_trend',
    'Yahoo リアルタイム検索の最新トレンド（急上昇キーワードランキング）を取得します。',
    {
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
    },
    async ({ limit = 20 }) => {
      try {
        const result = await fetchRealtimeTrends(limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Search trend error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 8: search_image (Yahoo Japan 画像検索)
  mcpServer.tool(
    'search_image',
    'Yahoo! JAPAN 画像検索を実行し、指定キーワードに関連する画像のタイトル・画像URL・サムネイル・ソース元ページを取得します。',
    {
      query: z.string().min(1).describe('検索キーワード'),
      limit: z.number().int().min(1).max(20).optional().describe('取得件数 (デフォルト: 20, 最大: 20)'),
      page: z.number().int().min(1).optional().describe('ページ番号 (デフォルト: 1)'),
    },
    async ({ query, limit, page }) => {
      try {
        const result = await searchYahooImage({ query, limit, page });
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

  // Tool 9: search_video (Yahoo Japan 動画検索)
  mcpServer.tool(
    'search_video',
    'Yahoo! JAPAN 動画検索を実行し、指定キーワードに関連する動画のタイトル・動画URL・再生時間・配信元・サムネイルを取得します。',
    {
      query: z.string().min(1).describe('検索キーワード'),
      limit: z.number().int().min(1).max(20).optional().describe('取得件数 (デフォルト: 20, 最大: 20)'),
      page: z.number().int().min(1).optional().describe('ページ番号 (デフォルト: 1)'),
    },
    async ({ query, limit, page }) => {
      try {
        const result = await searchYahooVideo({ query, limit, page });
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

  // Tool 10: search_news (Yahoo ニュース検索)
  mcpServer.tool(
    'search_news',
    'Yahoo!ニュース検索を実行し、最新ニュース記事のタイトル・概要・配信社・公開日時・記事URL・サムネイルを取得します。最大60件を一括取得可能です。',
    {
      query: z.string().min(1).describe('検索キーワード'),
      limit: z.number().int().min(1).max(60).optional().describe('取得件数 (デフォルト: 10, 最大: 60)'),
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

  // Tool 11: search_chiebukuro (Yahoo 知恵袋検索)
  mcpServer.tool(
    'search_chiebukuro',
    'Yahoo!知恵袋を検索し、質問タイトル・回答数・解決ステータス・投票受付中か・カテゴリ等を取得します。日本のリアルな口コミ・Q&A情報が得られます。',
    {
      query: z.string().min(1).describe('検索キーワード'),
      limit: z.number().int().min(1).max(10).optional().describe('取得件数 (デフォルト: 10, 最大: 10)'),
      page: z.number().int().min(1).optional().describe('ページ番号 (デフォルト: 1)'),
      status: z.enum(['all', 'open', 'vote', 'solved']).optional().describe('質問ステータス: "all"(すべて), "open"(回答受付中), "vote"(投票受付中), "solved"(解決済み)'),
    },
    async ({ query, limit, page, status }) => {
      try {
        const result = await searchYahooChiebukuro({ query, limit, page, status });
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

  // Tool 12: suggest_keywords (Yahoo サジェスト・キーワード補完)
  mcpServer.tool(
    'suggest_keywords',
    'Yahoo! JAPAN のオートコンプリートサジェストを取得し、入力キーワードに対する関連検索ワード・補完候補を返します。ユーザーが実際に使う検索ワードの発見に有用です。',
    {
      query: z.string().min(1).describe('補完対象のキーワード（部分入力可）'),
      limit: z.number().int().min(1).max(20).optional().describe('取得件数 (デフォルト: 10, 最大: 20)'),
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
          content: [{ type: 'text', text: `Suggest keywords error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 13: search_route (電車乗換案内)
  mcpServer.tool(
    'search_route',
    '日本国内の電車乗換案内。出発駅から到着駅への最適ルート・所要時間・乗り換え回数・運賃（IC/きっぷ）を検索します。経由駅指定（最大3駅）、出発/到着/始発/終電指定、新幹線・特急・バス利用の有無も指定可能。駅名は日本語（漢字・かな）で指定してください。',
    {
      from: z.string().min(1).describe('出発駅名（日本語: 例「東京」「新宿」）'),
      to: z.string().min(1).describe('到着駅名（日本語: 例「横浜」「渋谷」）'),
      via: z.array(z.string()).optional().describe('経由駅名の配列（最大3駅: 例 ["表参道"]）'),
      year: z.number().optional().describe('出発年 (例: 2026)'),
      month: z.number().optional().describe('出発月 (1-12)'),
      day: z.number().optional().describe('出発日 (1-31)'),
      hour: z.number().optional().describe('出発時刻の時 (0-23)'),
      minute: z.number().optional().describe('出発時刻の分 (0-59)'),
      timeType: z.enum(['departure', 'arrival', 'first_train', 'last_train', 'unspecified']).optional()
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

  // Tool 14: get_weather (日本の天気予報)
  mcpServer.tool(
    'get_weather',
    '日本全国各地の今日・明日・明後日の天気予報、詳細（風・波）、予想気温、降水確率、天気概況文を取得します。都市名（例「東京」「大阪」「福岡」「札幌」「名古屋」）または 6桁の地点ID（例「130010」）を指定できます。',
    {
      city: z.string().min(1).describe('都市名または都道府県名（例: "東京", "大阪", "福岡", "札幌", "名古屋", "那覇"）、もしくは6桁の地点ID（例: "130010"）'),
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

  return mcpServer;
}

export function createMcpTransport(options?: any) {
  return new StreamableHTTPTransport(options);
}
