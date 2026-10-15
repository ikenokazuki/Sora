import { z } from 'zod';
import { checkAllWatchTargets, checkWatchTarget, deleteWatchTarget, listWatchTargets, registerWatchTarget } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 👁️ Category 6: Watch & Diff Monitoring (モジュール: 'watch') */
export function registerWatchTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 19: watch_register (監視ターゲット登録) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'watch_register',
    'watch',
    '【Webページ差分監視登録】Web ページ（CSS セレクタで一部に限定も可）を監視対象に登録し、初回のハッシュを記録します。チケット当落・再販・お知らせの検知に利用します。以後の確認は watch_check。返却: { target: { id, url, title, selector, interval_seconds }, initialResult?, initialError? }',
    {
      url: z.string().url().describe('監視対象の Web ページ URL (例: "https://example.com/status")'),
      title: z.string().optional().describe('監視ターゲットの識別用タイトル (例: "チケット当落発表")'),
      selector: z.string().optional().describe('ピンポイントで監視する CSS セレクタ (例: "#status")'),
      webhookUrl: z.string().url().optional().describe('差分検知時に通知する Webhook URL'),
      intervalSeconds: z.number().int().min(1).max(604_800).optional().describe('監視インターバル目安 (秒, デフォルト: 3600, 上限: 604800)').meta({ default: 3600 }),
    },
    async (opts) => {
      try {
        const result = await registerWatchTarget(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Watch register error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['Web監視登録', '差分監視', '更新通知', 'URL監視'] },
  );

  // Tool 20: watch_check (差分スキャン実行) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'watch_check',
    'watch',
    '【Webページ差分スキャン実行】登録した監視対象を取得し直し、前回との差分を確認します。id を省略すると全件を確認します。差分があれば登録した Webhook に通知します。返却: id 指定時は { targetId, url, changed, diffSummary?, snapshotSnippet?, checkedAt, webhookSent? }、省略時はその配列',
    {
      id: z.string().optional().describe('特定の監視ターゲット ID (省略時は全登録ターゲットを一括スキャン)'),
    },
    async ({ id }) => {
      try {
        const result = id ? await checkWatchTarget(id) : await checkAllWatchTargets();
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Watch check error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['Web監視チェック', '更新確認', '差分取得'] },
  );

  // Tool 21: watch_list (監視ターゲット一覧) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'watch_list',
    'watch',
    '【Webページ監視ターゲット一覧】登録済みの監視対象と、最終確認の時刻・ハッシュを一覧します。返却: [{ id, url, title?, selector?, interval_seconds, last_checked_at?, last_hash? }]',
    {},
    async () => {
      try {
        const result = listWatchTargets();
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Watch list error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['Web監視一覧', '登録確認', 'ターゲット一覧'] },
  );

  // Tool: watch_delete (監視ターゲット削除) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'watch_delete',
    'watch',
    '【Webページ監視ターゲット削除】指定 ID の監視対象を削除し、以後の監視を止めます。ID は watch_list で確認できます。返却: { success, id }',
    {
      id: z.string().min(1).describe('削除する監視ターゲットのID'),
    },
    async ({ id }) => {
      try {
        const deleted = deleteWatchTarget(id);
        return {
          content: [{ type: 'text', text: toolJson({ success: deleted, id }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Watch delete error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['Web監視削除', 'ターゲット削除', '監視解除'] },
  );
}
