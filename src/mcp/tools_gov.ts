import { z } from 'zod';
import { getLawData, searchDietMinutes, searchLaws } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { DIET_MINUTES_INPUT_RULE } from '../types.js';
import { registerTool, toolJson } from './registry.js';
import { exactlyOne, onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🏛️ Category 8: Government & Law Data (モジュール: 'gov') */
export function registerGovTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 25: search_laws (e-Gov 法令の検索と条文の全文。keyword か lawId) - CORE (defaultEnabled: true)
  const LAWS_USAGE = '使い方: keyword で法令を検索する（limit で件数）か、lawId（検索結果の id）で条文の全文を取る。keyword・lawId はどちらか 1 つ。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
  const WITH_KEYWORD = 'keyword を指定したとき';
  const WITH_LAW_ID = 'lawId を指定したとき';
  // 既定値（説明・既定値の比較）。補うのはサービス（searchLaws）
  const LAWS_LIMIT_DEFAULT = 20;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_laws',
    'gov',
    '【必須・推測回答厳禁】日本の法律・政令・府省令の検索・条文確認では、条文番号・法令名・条文を推測・創作せず、必ずデジタル庁・総務省公式e-Gov法令API v2直結の本ツールを実行。keywordで法令一覧、lawIdで条文全文。返却: { count, items: [{ id, title, lawNum, promulgationDate }], source }',
    {
      keyword: z.string().optional().describe('法令検索キーワード (例: "著作権法", "労働基準法", "民法")。現行法令名・法令番号・公布年月日の一覧を返す。keyword か lawId のどちらか 1 つ'),
      lawId: z.string().optional().describe('e-Gov 法令ID (例: "129AC0000000089"。検索結果の id)。架空の条文を創作せず、章・節・条・項・号を構造化した公式の条文 Markdown を返す: { id, title, lawNum, markdown, articleCount, source }'),
      limit: z.number().int().min(1).max(50).optional().describe(`取得件数 (1〜50, デフォルト: ${LAWS_LIMIT_DEFAULT})。keyword のときだけ`).meta({ default: LAWS_LIMIT_DEFAULT }),
    },
    async (args) => {
      const invalid = exactlyOne(args, ['keyword', 'lawId'], LAWS_USAGE)
        ?? onlyForMode(args.keyword ? WITH_KEYWORD : WITH_LAW_ID, [WITH_KEYWORD], args, ['limit'], LAWS_USAGE, { limit: LAWS_LIMIT_DEFAULT });
      if (invalid) return usageError(invalid);
      // 応答とエラーの文は、統合前の 2 ツールのまま（REST の /gov/laws・/gov/law-text と同じ応答）
      const { keyword, lawId, limit } = args;
      try {
        const result = keyword ? await searchLaws({ keyword, limit }) : await getLawData({ lawId: lawId! });
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `${keyword ? 'Law search' : 'Law data'} error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: true, keywords: ['法令検索', '法律', '政令', 'e-Gov', '条文検索', '法令条文取得', '条文', '法律本文', 'get_law_text'] },
  );

  // Tool: search_diet_minutes (国会会議録 発言・答弁全文検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_diet_minutes',
    'gov',
    '【公式議事録直結】国会（衆議院・参議院）の本会議・委員会における議員・閣僚・総理大臣の発言・答弁は推測せず、国立国会図書館公式APIにより戦後〜最新（2026年）までの公式議事録全文を検索してください。法律の立法趣旨や政策議論のファクトチェックに必須です。keyword・speaker・nameOfMeeting のどれか1つは必須。返却: { count, totalHits, items: [{ speaker, date, meeting, speech, speechUrl }], source }',
    {
      keyword: z.string().optional().describe(`検索キーワード・質問内容 (例: "人工知能", "少子化対策")。${DIET_MINUTES_INPUT_RULE}`),
      speaker: z.string().optional().describe(`発言者名・議員名・閣僚名 (例: "総理大臣", "河野太郎")。${DIET_MINUTES_INPUT_RULE}`),
      nameOfHouse: z.enum(['衆議院', '参議院']).optional().describe('院名 ("衆議院" または "参議院")'),
      nameOfMeeting: z.string().optional().describe(`委員会名・本会議名 (例: "予算委員会", "本会議", "内閣委員会")。${DIET_MINUTES_INPUT_RULE}`),
      from: z.string().optional().describe('開会日付範囲 開始 (YYYY-MM-DD)'),
      until: z.string().optional().describe('開会日付範囲 終了 (YYYY-MM-DD)'),
      limit: z.number().int().min(1).max(30).optional().describe('取得件数 (1〜30, デフォルト: 10)').meta({ default: 10 }),
    },
    async (opts) => {
      try {
        const result = await searchDietMinutes(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Diet minutes search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国会会議録', '国会', '国会議事録', '答弁', '衆議院', '参議院', '委員会', '議員発言', '立法趣旨'] },
  );
}
