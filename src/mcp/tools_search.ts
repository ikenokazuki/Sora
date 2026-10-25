import { z } from 'zod';
import { formatToolMatches, type ToolMatch } from './tool_search.js';
import { searchCatalog } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** search_tools: 追加ツールの検索と動的有効化（メタツール）。常に登録する。 */
export function registerToolSearch(context: ToolRegistrationContext, enabled: Record<string, boolean>): void {
  const { mcpServer, toolCatalog, sessionActivated } = context;
  // =========================================================================
  // 🔍 Category 10: Tool Discovery & Dynamic Activation (メタツール) - CORE (defaultEnabled: true)
  // =========================================================================
  mcpServer.tool(
    'search_tools',
    '【追加ツール検索・動的有効化】現在 tools/list に表示されていないSoraの追加ツールをキーワードで検索し、' +
      '一致したツールを現在のセッションで有効化します。すでに tools/list に表示されているツールは直接実行してください。' +
      '荷物追跡（track_package）やフライト情報（get_flight_status）、音楽詳細、国会会議録など、初期状態で非表示の追加機能を使う際に使用します。' +
      '見つからない場合は該当モジュールが無効か利用不可です。返却: 有効化したツールの一覧（テキスト）',
    {
      query: z.string().describe('検索キーワードまたはカテゴリ名（例: "荷物追跡", "ヤマト", "佐川", "郵便", "UPS", "音楽", "国会", "trade", "life"）'),
      detail: z.enum(['names', 'summary', 'schema']).optional().describe('names=名前とカテゴリのみ / summary=説明の要約（既定） / schema=入力スキーマ付き（最大8件）'),
      activate: z.boolean().optional().describe('false なら有効化せずに調べるだけ（既定 true）'),
    },
    async ({ query, detail, activate }) => {
      const matches = searchCatalog(toolCatalog, query);
      const found: ToolMatch[] = matches.map((entry) => {
        if (activate === false) return { entry, newlyEnabled: false };
        sessionActivated.add(entry.name);
        const newlyEnabled = !entry.handle.enabled;
        if (newlyEnabled) {
          entry.handle.enable();
          entry.compatibilityHandle?.enable();
        }
        return { entry, newlyEnabled };
      });

      if (found.length === 0) {
        const activeCategories: string[] = [];
        if (enabled.web) activeCategories.push('web (一括/クロール)');
        if (enabled.browser) activeCategories.push('browser (操作)');
        if (enabled.yahoo) activeCategories.push('yahoo (知恵袋/画像/動画/ニュース/リアルタイム/トレンド)');
        if (enabled.life) activeCategories.push('life (天気/乗換/荷物追跡)');
        if (enabled.disaster) activeCategories.push('disaster (道路交通/警報/地震)');
        if (enabled.watch) activeCategories.push('watch (Web監視)');
        if (enabled.music) activeCategories.push('music (楽曲/歌手)');
        if (enabled.gov) activeCategories.push('gov (法令)');
        if (enabled.trade) activeCategories.push('trade (輸出/HTS/CPSC/FDA)');
        if (enabled.media) activeCategories.push('media (画像検査)');
        if (enabled.lyrics) activeCategories.push('lyrics (歌詞・自己責任)');
        if (enabled.youtube) activeCategories.push('youtube (YouTube の字幕・説明文)');

        const categoryText = activeCategories.length > 0
          ? `\n現在有効なカテゴリ: ${activeCategories.join(', ')}`
          : '';

        return {
          content: [
            {
              type: 'text',
              text: `"${query}" に一致する追加ツールは見つかりませんでした。\n該当機能のサーバーモジュールが無効化・利用不可となっている可能性があります。${categoryText}`,
            },
          ],
        };
      }

      return { content: [{ type: 'text', text: formatToolMatches(found, { detail, activate }) }] };
    },
  );
}
