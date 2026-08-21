import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@hono/mcp';
import { z } from 'zod';
import {
  scrapeUrl,
  callYahooMcp,
  integratedSearch,
} from './scraper.js';

export function createMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'web-fetcher',
    version: '1.0.0',
  });

  // Tool 1: scrape
  mcpServer.tool(
    'scrape',
    '指定した URL の Web ページをスクレイピングし、記事本文を Markdown 化してメタデータ（title, ogImage, description 等）とともに返却します。SPA サイトは自動で Chromium レンダリングにエスカレーションされます。',
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
        .describe(
          '静的フェッチのみに限定し、Chromium ブラウザレンダリングをスキップするかどうか (デフォルト: false)',
        ),
    },
    async ({ url, maxChars, fastOnly }) => {
      try {
        const result = await scrapeUrl({ url, maxChars, fastOnly });
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

  // Tool 2: search_web
  mcpServer.tool(
    'search_web',
    'Yahoo Japan Web 検索を実行し、指定キーワードの上位検索結果（タイトル・概要スニペット・URL）を取得します。',
    {
      query: z.string().min(1).describe('検索キーワード'),
    },
    async ({ query }) => {
      try {
        const mcpRes = await callYahooMcp('yahoo_web_search', { query });
        const content = mcpRes?.content?.[0]?.text || '[]';
        return {
          content: [{ type: 'text', text: content }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Web search error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 3: search_realtime
  mcpServer.tool(
    'search_realtime',
    'Yahoo Japan リアルタイム検索を実行し、X (旧 Twitter) の最新ツイートおよび画像・リンク情報を取得します。',
    {
      query: z.string().min(1).describe('検索キーワード'),
    },
    async ({ query }) => {
      try {
        const mcpRes = await callYahooMcp('yahoo_realtime_search', { query });
        const content = mcpRes?.content?.[0]?.text || '[]';
        return {
          content: [{ type: 'text', text: content }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Realtime search error: ${err?.message || err}` }],
        };
      }
    },
  );

  // Tool 4: search_deep
  mcpServer.tool(
    'search_deep',
    'Firecrawl 互換の統合深層検索。Web検索の実行、上位サイト本文の自動スクレイピング（Markdown化）、およびリアルタイム検索結果を一度にまとめて取得します。',
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
    },
    async ({
      query,
      limit = 3,
      scrapeContent = true,
      includeRealtime = true,
      maxChars = 30000,
    }) => {
      try {
        const result = await integratedSearch({
          query,
          limit,
          scrapeContent,
          includeRealtime,
          maxChars,
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

  return mcpServer;
}

export function createMcpTransport(): StreamableHTTPTransport {
  return new StreamableHTTPTransport({
    enableJsonResponse: true,
    strictAcceptHeader: false,
  });
}
