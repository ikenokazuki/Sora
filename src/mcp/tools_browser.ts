import { z } from 'zod';
import { executeBrowserActions } from '../scraper.js';
import { BrowserActionStepSchema } from '../types.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🤖 Category 2: Browser Actions & Automation (モジュール: 'browser') */
export function registerBrowserTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, serverTenantId } = context;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'browser_action',
    'browser',
    '【対話型ブラウザ自動操作】Chromium 実ブラウザを用いて、クリック・フォーム入力・キー押下・スクロール・待機・JavaScript実行・スクリーンショット取得などの対話的操作を順次実行します（対話・動的操作・レンダリングが必須なケース）。単純な静的ページの本文抽出は scrape、Web検索・調査は search_deep / search_web を使用してください。返却: { success, url, sessionId?, markdown?, screenshot?, html?, actionOutputs?: [{ step, type, result?, error? }], error? }',
    {
      url: z.string().url().optional().describe('操作対象の Web ページ URL (新規開始時に指定、既存セッション継続時は省略可能)'),
      sessionId: z.string().optional().describe('既存の対話セッションID (前回の操作に続けて同じタブで操作する場合に指定)'),
      ownerToken: z.string().optional().describe('マルチターン対話セッションの所有者検証トークン'),
      createSession: z.boolean().optional().describe('新しい対話セッションを作成し、次回以降も状態を維持するか (デフォルト: false)').meta({ default: false }),
      closeSession: z.boolean().optional().describe('指定したセッションを終了してブラウザリソースを解放するか (デフォルト: false)').meta({ default: false }),
      actions: z.array(BrowserActionStepSchema).optional().describe('順次実行するブラウザアクションの配列'),
      extract: z
        .object({
          markdown: z.boolean().optional().describe('操作後のページ本文を Markdown で抽出するか (デフォルト: true)').meta({ default: true }),
          html: z.boolean().optional().describe('操作後の生 HTML を抽出するか (デフォルト: false)').meta({ default: false }),
          screenshot: z.boolean().optional().describe('操作後の画面スクリーンショット（Base64 PNG）を取得するか (デフォルト: false)').meta({ default: false }),
          screenshotFullPage: z.boolean().optional().describe('フルページスクリーンショットにするか (デフォルト: true)').meta({ default: true }),
          clipSelector: z.string().optional().describe('特定要素のみを切り抜く CSS セレクタ'),
          maxChars: z.number().optional().describe('最大抽出文字数 (デフォルト: 30000)').meta({ default: 30000 }),
        })
        .optional()
        .describe('操作完了後に抽出するデータ指定'),
      timeout: z.number().optional().describe('全体のタイムアウト時間 (ミリ秒, デフォルト: 30000)').meta({ default: 30000 }),
    },
    async (opts) => {
      try {
        const result = await executeBrowserActions({ ...opts, tenantId: serverTenantId });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Browser action error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['ブラウザ操作', 'クリック', '入力', 'スクリーンショット', 'Stealth Chromium', 'セッション'] },
  );
}
