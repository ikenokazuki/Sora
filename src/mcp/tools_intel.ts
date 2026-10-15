import { z } from 'zod';
import { COUNTRY_INTEL_TOPICS, type CountryContextReport, CountryContextReportSchema, IntelSocialInputSchema } from '../services/country_intel/types.js';
import { ContextUpdatesSchema, EvidencePageSchema } from '../services/country_intel/detail.js';
import { registerStructuredTool, toolJson } from './registry.js';

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
      topics: z.array(z.enum(COUNTRY_INTEL_TOPICS)).optional().describe('対象トピック (politics, economy, disasters 等)'),
      period: z.enum(['7d', '30d', '90d']).optional().default('30d').describe('調査期間 (デフォルト: "30d")'),
      includeSocial: z.boolean().optional().default(false).describe('SNS投稿観測を含めるか (日本はYahooリアルタイムの日本語投稿も取得。地域・言語の不足は明示)'),
      social: IntelSocialInputSchema.optional().describe('SNS観測条件 (platforms/queries/urls/lookbackHours)'),
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
  registerStructuredTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_country_context',
    'intel',
    '【国地域レポートの再取得】research_country_context が返した contextId で、保存済みのレポートを取得します（再調査はしません）。返却: CountryContextReport',
    {
      contextId: z.string().min(1).describe('コンテキストID'),
    },
    CountryContextReportSchema,
    async (opts) => {
      try {
        const { getPersistedCountryContext } = await import('../services/country_intel/report.js');
        const result = getPersistedCountryContext(opts.contextId) as CountryContextReport | undefined;
        if (!result) return { isError: true, content: [{ type: 'text', text: 'Country context not found: ' + opts.contextId }] };
        const text = toolJson(result);
        return { content: [{ type: 'text', text }], structuredContent: result as never };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国地域', 'コンテキスト', 'context', 'スナップショット'] },
  );
  registerStructuredTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_country_context_evidence',
    'intel',
    '【国地域レポートの根拠取得】contextId のレポートの根拠（原文の抜粋・構造化データ）をページ単位で取得します。evidenceIds で個別に指定し、省略時は nextCursor で順に走査します。レポートに属さない ID は拒否します。返却: { contextId, items: [{ evidenceId, providerId, sourceRecordUrl, resolvedTitle?, blocks, publishedAt? }], totalStored, nextCursor? }',
    {
      contextId: z.string().min(1).describe('コンテキストID'),
      evidenceIds: z.array(z.string()).optional().describe('根拠ID一覧 (省略時はページ走査)'),
      cursor: z.string().optional().describe('次ページカーソル'),
      limit: z.number().int().min(1).max(100).optional().describe('取得件数 (1〜100, デフォルト: 40)').meta({ default: 40 }),
    },
    EvidencePageSchema,
    async (opts) => {
      try {
        const { getEvidencePage } = await import('../services/country_intel/db.js');
        const result = getEvidencePage(opts.contextId, { ids: opts.evidenceIds, cursor: opts.cursor, limit: opts.limit });
        const text = toolJson(result);
        return { content: [{ type: 'text', text }], structuredContent: result as never };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国地域', '根拠', 'evidence', '原文', '詳細'] },
  );
  registerStructuredTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_country_context_updates',
    'intel',
    '【国地域レポートの差分取得】contextId のレポートについて、前回以降の根拠の追加・訂正・削除・取得障害を取得します。前回の nextCursor を cursor に渡すと続きから取得します。返却: { contextId, changes: [{ id, observedAt, changeKind, evidenceId?, summary? }], nextCursor? }',
    {
      contextId: z.string().min(1).describe('コンテキストID'),
      cursor: z.string().optional().describe('差分カーソル'),
    },
    ContextUpdatesSchema,
    async (opts) => {
      try {
        const { getContextUpdates } = await import('../services/country_intel/db.js');
        const result = getContextUpdates(opts.contextId, opts.cursor);
        const text = toolJson(result);
        return { content: [{ type: 'text', text }], structuredContent: result as never };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['国地域', '更新', '差分', 'updates'] },
  );
}
