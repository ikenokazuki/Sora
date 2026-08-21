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
      fastOnly: z
        .boolean()
        .optional()
        .describe('静的フェッチのみに限定し、Chromium ブラウザレンダリングをスキップするかどうか (デフォルト: false)'),
      renderJs: z
        .boolean()
        .optional()
        .describe('JavaScript を完全実行してページを描画するか (Headless Chromium Stealth モード強制実行, デフォルト: false)'),
      extractHighlights: z
        .boolean()
        .optional()
        .describe('クエリに関連する重要文（ハイライト）を自動抽出して付与するか (デフォルト: false)'),
      query: z
        .string()
        .optional()
        .describe('ハイライト抽出に使用するキーワード・検索文'),
    },
    async ({ url, maxChars, fastOnly, renderJs, extractHighlights, query }) => {
      try {
        const result = await scrapeUrl({ url, maxChars, fastOnly, renderJs, extractHighlights, query });
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
    },
    async ({ url, limit = 100, includeSubdomains = false }) => {
      try {
        const result = await mapSiteUrl({ url, limit, includeSubdomains });
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
    },
    async ({ url, maxPages = 5, maxDepth = 2, maxChars = 15000 }) => {
      try {
        const result = await crawlSiteUrl({ url, maxPages, maxDepth, maxChars });
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

  return mcpServer;
}

export function createMcpTransport(options?: any) {
  return new StreamableHTTPTransport(options);
}
