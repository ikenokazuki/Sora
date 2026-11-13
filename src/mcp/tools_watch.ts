import { z } from 'zod';
import { checkAllWatchTargets, checkWatchTarget, deleteWatchTarget, listWatchTargets, registerWatchTarget } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';
import { notUrl, onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 👁️ Category 6: Watch & Diff Monitoring (モジュール: 'watch') */
export function registerWatchTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, serverTenantId } = context;
  // Tool 19: watch (Webページの差分監視。action で登録・確認・一覧・削除) - DEFERRED
  const WATCH_USAGE = '使い方: action で選ぶ（register: url（必須）・title・selector・webhookUrl で登録。check: id の対象を確認、id を省くと全件。list: 引数なし。delete: id（必須）の対象を削除）。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る
  const actionIs = (action: string) => `action が ${action} のとき`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'watch',
    'watch',
    '【Webページ差分監視】Web ページ（CSS セレクタで一部に限定も可）の変化を監視します。チケット当落・再販・お知らせの検知に利用します。action で選ぶ。register: url を監視対象に登録し、初回のハッシュを記録。check: 取得し直して前回との差分を確認し、差分があれば登録した Webhook に通知（id を省くと全件）。list: 登録済みの対象と、最終確認の時刻・ハッシュの一覧。delete: id の対象を削除し、以後の監視を止める（id は list で確認）。返却: register は { target: { id, url, title, selector }, initialResult?, initialError? }、check は { targetId, url, changed, diffSummary?, snapshotSnippet?, checkedAt, webhookSent? }（id を省くとその配列）、list は [{ id, url, title?, selector?, last_checked_at?, last_hash? }]、delete は { success, id }',
    {
      action: z.enum(['register', 'check', 'list', 'delete']).describe('操作: "register" (登録), "check" (差分の確認), "list" (一覧), "delete" (削除)'),
      url: z.string().trim().optional().describe('監視対象の Web ページ URL (例: "https://example.com/status")。register のときだけ (必須)'),
      title: z.string().optional().describe('監視ターゲットの識別用タイトル (例: "チケット当落発表")。register のときだけ'),
      selector: z.string().optional().describe('ピンポイントで監視する CSS セレクタ (例: "#status")。register のときだけ'),
      webhookUrl: z.string().trim().optional().describe('差分検知時に通知する Webhook URL。register のときだけ'),
      id: z.string().optional().describe('監視ターゲット ID。check では省略すると全登録ターゲットを一括スキャン。delete では必須'),
    },
    async (args) => {
      const { action, url, title, selector, webhookUrl, id } = args;
      const mode = actionIs(action);
      const invalid = onlyForMode(mode, [actionIs('register')], args, ['url', 'title', 'selector', 'webhookUrl'], WATCH_USAGE)
        ?? onlyForMode(mode, [actionIs('check'), actionIs('delete')], args, ['id'], WATCH_USAGE)
        ?? (action === 'register' && !url ? `${mode}は url が必要です。${WATCH_USAGE}` : undefined)
        ?? (action === 'delete' && !id ? `${mode}は id が必要です。${WATCH_USAGE}` : undefined)
        ?? notUrl(args, ['url', 'webhookUrl'], WATCH_USAGE);
      if (invalid) return usageError(invalid);
      // 応答とエラーの文は、統合前の 4 ツールのまま（REST の 4 ルートと同じサービス）
      try {
        const result = action === 'register'
          ? await registerWatchTarget({ url: url!, title, selector, webhookUrl: webhookUrl || undefined, tenantId: serverTenantId })
          : action === 'check'
            ? (id ? await checkWatchTarget(id, serverTenantId) : await checkAllWatchTargets(serverTenantId))
            : action === 'list'
              ? listWatchTargets(serverTenantId)
              : { success: deleteWatchTarget(id!, serverTenantId), id };
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Watch ${action} error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['Web監視登録', '差分監視', '更新通知', 'URL監視', 'Web監視チェック', '更新確認', '差分取得', 'Web監視一覧', '登録確認', 'ターゲット一覧', 'Web監視削除', 'ターゲット削除', '監視解除', 'watch_register', 'watch_check', 'watch_list', 'watch_delete'] },
  );
}
