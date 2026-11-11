import { z } from 'zod';
import { COUNTRY_INTEL_TOPICS, type CountryContextReport, CountryContextReportSchema, IntelSocialInputSchema } from '../services/country_intel/types.js';
import { ContextUpdatesSchema, EvidencePageSchema } from '../services/country_intel/detail.js';
import { registerStructuredTool, toolJson } from './registry.js';
import { onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🌍 Category 9: Country & Region Intelligence (モジュール: 'intel') */
export function registerIntelTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, options } = context;
  registerStructuredTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'research_country_context',
    'intel',
    '【国地域インテリジェンス・証拠基盤】指定した国・地域の政治・経済・安全・災害・保健・旅行・カレンダー・世論調査を分野横断で取得します。初回応答は代表証拠、全件はcontextIdで参照可能。評価・推奨は含めません。限界: 一部証拠は公表日時なし、SNSは対象言語・範囲限定、未観測範囲の明示は呼出元が確認すること。本ツール単独で判断の十分性を保証しない。調査手順はリソース sora-skill://sora-deep-research を読む。返却: CountryContextReport',
    {
      region: z.string().min(1).describe('国・地域名またはコード (例: "South Korea", "KR", "台湾")'),
      query: z.string().optional().describe('追加の調査クエリ'),
      topics: z.array(z.enum(COUNTRY_INTEL_TOPICS)).optional().describe('ニュース検索の分野語 (economy, politics, tourism, health, disasters) にだけ効く。証拠・節は絞らない'),
      period: z.enum(['7d', '30d', '90d']).optional().default('30d').describe('イベントの時間の範囲にだけ効く (ニュース検索は7日固定。デフォルト: "30d")'),
      includeSocial: z.boolean().optional().default(false).describe('SNS投稿観測を含めるか (日本はYahooリアルタイムの日本語投稿も取得。地域・言語の不足は明示)'),
      social: IntelSocialInputSchema.optional().describe('SNS観測条件 (platforms/queries/urls/lookbackHours)。渡すと includeSocial は true になる'),
      noCache: z.boolean().optional().default(false).describe('キャッシュをバイパスするか'),
      verbose: z.boolean().optional().default(false).describe('全件の詳細出力を要求するか (既定は分野別の代表証拠)'),
    },
    CountryContextReportSchema,
    async (opts) => {
      try {
        const research = options?.intelResearch ?? (async (request: unknown) => {
          const { researchCountryWithDefaults } = await import('../services/country_intel/runtime.js');
          return researchCountryWithDefaults(request as never);
        });
        const result = (await research(opts)) as CountryContextReport;
        const text = toolJson(result, opts.verbose);
        return { content: [{ type: 'text', text }], structuredContent: result as never };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: 'text', text: `Country intelligence error: ${err instanceof Error ? err.message : err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国地域', 'カントリー', 'country', '地域情勢', '海外情勢', 'intel', 'intelligence', 'コンテキスト'] },
  );
  // Tool: get_country_context (保存したレポート・根拠・差分。part で選ぶ) - DEFERRED
  // part ごとの取得。応答とエラーの文は、統合前の 3 ツールのまま（REST の 3 ルートと同じサービス）。
  // 応答の形は part ごとに違うので、SDK の出力の検査は contextId だけにし、part の形はここで確かめる（旧ツールの outputSchema と同じ検査）
  type PartArgs = { contextId: string; evidenceIds?: string[]; cursor?: string; limit?: number };
  const PARTS = {
    report: { schema: CountryContextReportSchema, run: async ({ contextId }: PartArgs) => (await import('../services/country_intel/report.js')).getPersistedCountryContext(contextId) },
    evidence: { schema: EvidencePageSchema, run: async ({ contextId, evidenceIds, cursor, limit }: PartArgs) => (await import('../services/country_intel/db.js')).getEvidencePage(contextId, { ids: evidenceIds, cursor, limit }) },
    updates: { schema: ContextUpdatesSchema, run: async ({ contextId, cursor }: PartArgs) => (await import('../services/country_intel/db.js')).getContextUpdates(contextId, cursor) },
  };
  const CONTEXT_USAGE = '使い方: contextId（必須）を part で選んで取得する（report（既定）: 保存したレポート。evidence: 根拠をページ単位で。evidenceIds で個別に、省けば cursor・limit で順に。updates: 前回以降の差分。cursor で続きから）。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る
  const partIs = (part: string) => `part が ${part} のとき`;
  registerStructuredTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_country_context',
    'intel',
    '【国地域レポートの再取得】research_country_context が返した contextId で、保存済みのレポートを取得します（再調査はしません）。part で選ぶ。report（既定）: レポート全体。evidence: 根拠（原文の抜粋・構造化データ）をページ単位で取得します。evidenceIds で個別に指定し、省略時は nextCursor で順に走査します。レポートに無い ID は missingIds で返し、limit を超えたら nextCursor で続きます。updates: 前回以降の根拠の追加・訂正・削除・取得障害。前回の nextCursor を cursor に渡すと続きから取得します。返却: report は CountryContextReport、evidence は { contextId, items: [{ evidenceId, providerId, sourceRecordUrl, resolvedTitle?, blocks, publishedAt? }], totalStored, missingIds?, nextCursor? }、updates は { contextId, changes: [{ id, observedAt, changeKind, evidenceId?, summary? }], nextCursor? }',
    {
      contextId: z.string().min(1).describe('コンテキストID'),
      part: z.enum(['report', 'evidence', 'updates']).optional().describe('取得するもの: "report" (保存したレポート), "evidence" (根拠のページ), "updates" (前回以降の差分)').meta({ default: 'report' }),
      evidenceIds: z.array(z.string()).optional().describe('根拠ID一覧 (REST の ids に当たる。省略時はページ走査)。evidence のときだけ'),
      cursor: z.string().optional().describe('前回の nextCursor (evidence は次ページ、updates は差分の続き)。evidence か updates のときだけ'),
      limit: z.number().int().min(1).max(100).optional().describe('取得件数 (1〜100, デフォルト: 40)。evidence のときだけ').meta({ default: 40 }),
    },
    z.looseObject({ contextId: z.string() }),
    async (args) => {
      const part = args.part ?? 'report';
      const mode = partIs(part);
      const invalid = onlyForMode(mode, [partIs('evidence')], args, ['evidenceIds', 'limit'], CONTEXT_USAGE, { limit: 40 })
        ?? onlyForMode(mode, [partIs('evidence'), partIs('updates')], args, ['cursor'], CONTEXT_USAGE);
      if (invalid) return usageError(invalid);
      try {
        const result = await PARTS[part].run(args);
        if (!result) return { isError: true, content: [{ type: 'text', text: 'Country context not found: ' + args.contextId }] };
        const checked = PARTS[part].schema.safeParse(result);
        if (!checked.success) throw new Error(`invalid ${part} payload: ${checked.error.message}`);
        return { content: [{ type: 'text', text: toolJson(result) }], structuredContent: result as never };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国地域', 'コンテキスト', 'context', 'スナップショット', '根拠', 'evidence', '原文', '詳細', '更新', '差分', 'updates', 'get_country_context_evidence', 'get_country_context_updates'] },
  );
}
