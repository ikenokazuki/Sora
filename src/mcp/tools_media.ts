import { z } from 'zod';
import { inspectImage } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 📷 Category 9: Media & Vision (モジュール: 'media') */
export function registerMediaTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool: inspect_image (画像取得 & マルチモーダル視覚入力 Base64 返却) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'inspect_image',
    'media',
    '【画像視覚解析・マルチモーダル入力】WebページやSNS投稿内の重要画像URL（チラシ、時刻表、表、図等）を取得し、MCP ImageContent（Base64）として直接AIに視覚入力します。※単なるアイキャッチや装飾画像には呼び出さず、テキスト回答に不可欠な画像に限定してください。返却: ImageContent',
    {
      url: z.string().url().describe('読み取り対象の画像URL (https://...)'),
    },
    async (opts) => {
      try {
        const result = await inspectImage(opts);
        return {
          content: [
            {
              type: 'image',
              data: result.imageContent.data,
              mimeType: result.imageContent.mimeType,
            },
            {
              type: 'text',
              text: result.markdown || `Image loaded: ${result.url}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Image inspection error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['画像', 'チラシ', 'タイムテーブル', '告知', 'ポスター', '写真', 'スクリーンショット', '視覚', 'inspect', 'image', 'media'] },
  );
}
