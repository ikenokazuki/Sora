import { z } from 'zod';
import { getLawData, searchDietMinutes, searchLaws } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🏛️ Category 8: Government & Law Data (モジュール: 'gov') */
export function registerGovTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 25: search_laws (e-Gov キーワード法令検索) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_laws',
    'gov',
    '【必須・推測回答厳禁】日本の法律・政令・府省令の検索・調査では、学習知識で条文番号や法令名を推測せず、必ずデジタル庁・総務省公式e-Gov法令API v2直結の本ツールを実行してください。現行法令名、法令番号、公布年月日の一覧を取得します。返却: { count, items: [{ id, title, lawNum, promulgationDate }], source }',
    {
      keyword: z.string().min(1).describe('法令検索キーワード (例: "著作権法", "労働基準法", "民法")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
    },
    async (opts) => {
      try {
        const result = await searchLaws(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Law search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['法令検索', '法律', '政令', 'e-Gov', '条文検索'] },
  );

  // Tool 26: get_law_text (e-Gov 法令条文詳細取得) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_law_text',
    'gov',
    '【公式条文直結・創作厳禁】日本の法令条文の確認では、架空の条文・条項を創作（法律ハルシネーション）せず、必ず本ツールで公式e-Govの正確な条文Markdownを取得してください。章・節・条・項・号が正確に構造化された本文を返します。返却: { id, title, lawNum, markdown, articleCount, source }',
    {
      lawId: z.string().min(1).describe('e-Gov 法令ID (例: "129AC0000000089")'),
    },
    async (opts) => {
      try {
        const result = await getLawData(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Law data error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['法令条文取得', '条文', 'e-Gov', '法律本文'] },
  );

  // Tool: search_diet_minutes (国会会議録 発言・答弁全文検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_diet_minutes',
    'gov',
    '【公式議事録直結】国会（衆議院・参議院）の本会議・委員会における議員・閣僚・総理大臣の発言・答弁は推測せず、国立国会図書館公式APIにより戦後〜最新（2026年）までの公式議事録全文を検索してください。法律の立法趣旨や政策議論のファクトチェックに必須です。返却: { count, totalHits, items: [{ speaker, date, meeting, speech, speechUrl }], source }',
    {
      keyword: z.string().optional().describe('検索キーワード・質問内容 (例: "人工知能", "少子化対策")'),
      speaker: z.string().optional().describe('発言者名・議員名・閣僚名 (例: "総理大臣", "河野太郎")'),
      nameOfHouse: z.enum(['衆議院', '参議院']).optional().describe('院名 ("衆議院" または "参議院")'),
      nameOfMeeting: z.string().optional().describe('委員会名・本会議名 (例: "予算委員会", "本会議", "内閣委員会")'),
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
