import { randomUUID } from 'node:crypto';
import { resolveRegion } from './region.js';
import { deduplicateEvidenceWithRemap } from './evidence.js';
import { extractEvent, type IntelEventDraft } from './event_extract.js';
import type { EvidenceDetail } from './detail.js';
import { clusterEvents } from './event_cluster.js';
import { assembleSituation, buildActualWindows, buildCoverage, buildForeignRelations, buildJapanView } from './context.js';
import { buildMetricObservations } from './metric_builder.js';
import { deriveIntelligenceSignal } from '../intelligence/signals.js';
import { buildContentView } from '../intelligence/domains/content.js';
import { buildMarketingView } from '../intelligence/domains/marketing.js';
import { buildTravelView } from '../intelligence/domains/travel.js';
import { buildFinanceView } from '../intelligence/domains/finance.js';
import type { IntelligenceSignal } from '../intelligence/types.js';
import { planCountryResearchPass1, planCountryResearchPass2 } from './query_planner.js';
import { runProviderPass, type AcquiredItem, type CountryIntelProvider, type EnrichBudget, type ProviderCache } from './provider_registry.js';
import type { ProviderRun } from './types.js';
import { getCountryContext, getVerifiedCountrySources, queryBaselineObservations, saveCountryContext, saveEvidenceDetails, saveMetricObservations } from './db.js';
import { buildDomainContext, evidenceToFacts } from './domain_details.js';
import { classifyRegionLink, isQueryTargeted, type RegionLink } from './region_link.js';
import { articleBlocks, type ScrapedArticle } from './providers/official_web.js';
import { verifyCountrySource } from './source_registry.js';
import {
  CountryContextRequestSchema,
  CountryContextReportSchema,
  type ActualWindow,
  type CountryContextReport,
  type CountryContextRequest,
  type CountryEvidence,
  type IntelEvent,
  type CountrySource,
  type Limitation,
  type RegionIdentity,
  type SituationSection,
} from './types.js';

export interface ResearchDependencies {
  providers?: readonly CountryIntelProvider[];
  sources?: readonly CountrySource[];
  now?: () => Date;
  cache?: ProviderCache | null;
  timeoutMs?: number;
  /** リクエスト全体の締め切りms。既定 29000。超過後は新規取得を開始しない。 */
  deadlineMs?: number;
  /** 本文補完の取得器。未指定時は本文未取得として明記する。 */
  scrapeArticle?: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>;
  /** 本文補完の予算。既定は最大12件・同時3件・1件4秒・1件12000字・合計120000字。 */
  enrich?: EnrichBudget;
  /** pass1 で発見した candidate の検証器。未指定時は availability check のみ。 */
  sourceVerifier?: (source: CountrySource) => Promise<CountrySource>;
}

const RUN_SEVERITY: Record<ProviderRun['status'], number> = {
  error: 5,
  rate_limited: 4,
  unavailable: 3,
  partial: 2,
  success: 1,
};

/** pass 別の run を provider 単位に集約する。件数は加算し、状態は深刻な方を残す。 */
export function mergeProviderRuns(runs: readonly ProviderRun[]): ProviderRun[] {
  const byProvider = new Map<string, ProviderRun[]>();
  for (const run of runs) {
    const list = byProvider.get(run.provider) ?? [];
    list.push(run);
    byProvider.set(run.provider, list);
  }
  return [...byProvider.values()].map((group) => {
    if (group.length === 1) return group[0];
    const worst = group.reduce((left, right) =>
      RUN_SEVERITY[right.status] > RUN_SEVERITY[left.status] ? right : left);
    return {
      provider: group[0].provider,
      startedAt: group.map((run) => run.startedAt).sort()[0],
      finishedAt: group.map((run) => run.finishedAt ?? run.startedAt).sort().at(-1),
      status: worst.status,
      itemCount: group.reduce((sum, run) => sum + run.itemCount, 0),
      coverage: [...new Set(group.flatMap((run) => run.coverage ?? []))],
      latencyMs: group.reduce((sum, run) => sum + (run.latencyMs ?? 0), 0),
      ...(worst.errorCode ? { errorCode: worst.errorCode } : {}),
    };
  });
}

export function getPersistedCountryContext(contextId: string): CountryContextReport | undefined {
  return getCountryContext(contextId);
}

/** 空文字の query / topics は未指定とみなす (空値を送るクライアントの許容)。 */
export function normalizeCountryRequest(rawRequest: CountryContextRequest): CountryContextRequest {
  const raw = rawRequest as unknown as Record<string, unknown>;
  const query = typeof raw.query === 'string' && raw.query.trim().length === 0 ? undefined : raw.query;
  let topics = raw.topics;
  if (Array.isArray(topics)) {
    const kept = topics.filter((topic) => typeof topic === 'string' && topic.trim().length > 0);
    topics = kept.length > 0 ? kept : undefined;
  }
  return { ...(raw as object), query, topics } as CountryContextRequest;
}

function indicatorsFromStructuredData(data: Record<string, unknown> | undefined): { label: string; value: string }[] {
  if (!data) return [];
  const indicators: { label: string; value: string }[] = [];
  for (const [label, value] of Object.entries(data)) {
    if (/url$/i.test(label) || value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (text) indicators.push({ label, value: text.slice(0, 200) });
    } else if (Array.isArray(value)) {
      const parts = value.filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number').map(String);
      if (parts.length > 0) indicators.push({ label, value: parts.join(', ').slice(0, 200) });
    }
    if (indicators.length >= 8) break;
  }
  return indicators;
}

export function attachEventIndicators(
  events: IntelEvent[],
  details: readonly EvidenceDetail[],
): IntelEvent[] {
  const detailByEvidence = new Map<string, EvidenceDetail>();
  for (const detail of details) {
    if (!detailByEvidence.has(detail.evidenceId)) detailByEvidence.set(detail.evidenceId, detail);
  }
  return events.map((event) => {
    const detail = event.evidenceIds
      .map((id) => detailByEvidence.get(id))
      .find((found): found is EvidenceDetail => found?.structuredData !== undefined);
    const indicators = detail ? indicatorsFromStructuredData(detail.structuredData) : undefined;
    return indicators && indicators.length > 0 ? { ...event, indicators } : event;
  });
}

/**
 * イベント化の対象を選ぶ。未分類（other）は落とす。対象地域と無関係・
 * 判定材料不足（unrelated/unknown）はイベントにしない。候補は残す。
 */
export function filterRegionRelevantDrafts(
  drafts: IntelEventDraft[],
  links: ReadonlyMap<string, RegionLink>,
): IntelEventDraft[] {
  return drafts.filter((draft) => {
    if (draft.type === 'other') return false;
    const link = links.get(draft.evidenceId);
    return link === 'direct' || link === 'related' || link === 'candidate';
  });
}

function eventTimeBounds(
  event: IntelEvent,
  details: ReadonlyMap<string, EvidenceDetail>,
): { start?: number; end?: number } {
  let start: number | undefined;
  let end: number | undefined;
  const consider = (value: string | undefined, isEnd?: boolean): void => {
    if (!value) return;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return;
    if (isEnd) end = end === undefined ? parsed : Math.max(end, parsed);
    else start = start === undefined ? parsed : Math.min(start, parsed);
  };
  for (const id of event.evidenceIds) {
    const detail = details.get(id);
    consider(detail?.occurredAt ?? event.occurredAt);
    consider(detail?.updatedAt, true);
  }
  consider(event.occurredAt);
  return { ...(start !== undefined ? { start } : {}), ...(end ?? start !== undefined ? { end: end ?? start } : {}) };
}

/**
 * 要求期間との重なりで絞る。期間前に始まり期間内も継続した災害は保持する。
 * 期間外の終了済みイベントは落とす。日時不明は保持する。
 */
export function filterEventsByWindow(
  events: IntelEvent[],
  details: ReadonlyMap<string, EvidenceDetail>,
  from: string,
  to: string,
): IntelEvent[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return events;
  return events.filter((event) => {
    const { start, end } = eventTimeBounds(event, details);
    if (start === undefined) return true;
    return (end ?? start) >= fromMs && start <= toMs;
  });
}

export interface EnrichmentOutcome {
  attempted: number;
  upgraded: number;
  failed: number;
  skippedBudget: number;
  unavailable: boolean;
  truncatedDetails: number;
  omittedDetails: number;
}

const DEFAULT_ENRICH_BUDGET = {
  maxItems: 12,
  concurrency: 3,
  perItemMs: 4000,
  maxCharsPerItem: 12000,
  totalChars: 120000,
} as const;

/**
 * 抜粋・見出しだけの詳細を本文で補完する。予算超過・失敗は数えて返す。
 * キャッシュ共有物の破壊を避けるため detail は複製して更新する。
 */
export async function enrichDetailsWithArticles(
  details: EvidenceDetail[],
  links: ReadonlyMap<string, RegionLink>,
  scrape: ((url: string, signal: AbortSignal) => Promise<ScrapedArticle>) | undefined,
  budget: EnrichBudget,
  remainingMs: () => number,
): Promise<{ details: EvidenceDetail[]; outcome: EnrichmentOutcome }> {
  const maxItems = budget.maxItems ?? DEFAULT_ENRICH_BUDGET.maxItems;
  const concurrency = Math.max(1, budget.concurrency ?? DEFAULT_ENRICH_BUDGET.concurrency);
  const perItemMs = budget.perItemMs ?? DEFAULT_ENRICH_BUDGET.perItemMs;
  const maxCharsPerItem = budget.maxCharsPerItem ?? DEFAULT_ENRICH_BUDGET.maxCharsPerItem;
  const totalChars = budget.totalChars ?? DEFAULT_ENRICH_BUDGET.totalChars;
  const rank = (link: RegionLink | undefined): number =>
    link === 'direct' ? 0 : link === 'related' ? 1 : link === 'candidate' ? 2 : 3;
  const candidates = details
    .filter((detail) => detail.contentKind !== 'extracted_text'
      && (rank(links.get(detail.evidenceId)) <= 2))
    .sort((left, right) => rank(links.get(left.evidenceId)) - rank(links.get(right.evidenceId)))
    .slice(0, Math.max(0, maxItems));
  const outcome: EnrichmentOutcome = {
    attempted: 0, upgraded: 0, failed: 0, skippedBudget: 0,
    unavailable: !scrape, truncatedDetails: 0, omittedDetails: 0,
  };
  if (!scrape) {
    outcome.skippedBudget = candidates.length;
    return { details, outcome };
  }
  const upgraded = new Map(details.map((detail) => [detail.evidenceId, detail]));
  let usedChars = 0;
  let cursor = 0;
  const fetchOne = async (): Promise<void> => {
    while (cursor < candidates.length) {
      if (remainingMs() < 500 || usedChars >= totalChars) {
        outcome.skippedBudget += candidates.length - cursor;
        cursor = candidates.length;
        return;
      }
      const target = candidates[cursor];
      cursor += 1;
      outcome.attempted += 1;
      try {
        const timeout = AbortSignal.timeout(Math.max(500, Math.min(perItemMs, remainingMs())));
        const scraped = await scrape(target.sourceRecordUrl, timeout);
        const markdown = scraped.markdown ?? scraped.content;
        if (!markdown) {
          outcome.failed += 1;
          continue;
        }
        const split = articleBlocks(markdown, maxCharsPerItem);
        if (split.blocks.length === 0) {
          outcome.failed += 1;
          continue;
        }
        const chars = split.blocks.reduce((sum, block) => sum + block.text.length, 0);
        usedChars += chars;
        if (split.truncated) outcome.truncatedDetails += 1;
        upgraded.set(target.evidenceId, {
          ...target, contentKind: 'extracted_text', blocks: split.blocks, contentTruncated: split.truncated,
        });
        outcome.upgraded += 1;
      } catch {
        outcome.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => fetchOne()));
  return { details: [...upgraded.values()], outcome };
}

export async function researchCountryContext(
  rawRequest: CountryContextRequest,
  dependencies: ResearchDependencies = {},
): Promise<CountryContextReport> {
  const request = CountryContextRequestSchema.parse(normalizeCountryRequest(rawRequest));
  const nowDate = dependencies.now?.() ?? new Date();
  const region = resolveRegion(request.region);
  const providers = dependencies.providers ?? [];
  const capabilities = providers.map((provider) => ({ id: provider.id, areas: [...provider.areas] }));
  const verifySource = dependencies.sourceVerifier ?? ((source) => verifyCountrySource(source));
  const runOptions = {
    // 広域取得は開始から最大15秒。残り時間が短い場合は前倒しで切り上げる。
    timeoutMs: Math.min(dependencies.timeoutMs ?? 10_000, 15_000),
    noCache: request.noCache,
    cache: dependencies.cache ?? null,
  };
  const deadlineMs = dependencies.deadlineMs ?? 29_000;
  const deadline = Date.now() + Math.max(0, deadlineMs);
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  // Pass 1: 広域収集 → evidence 正規化・source candidate 発見。
  const pass1Plan = {
    request,
    region,
    pass1: planCountryResearchPass1(request, region, capabilities),
    pass2: [],
    limits: { maxPass1Queries: 12 as const, maxPass2Queries: 8 as const, maxItemsPerQuery: 100 as const },
  };
  const pass1 = await runProviderPass(pass1Plan, 1, providers, runOptions);

  // pass1 で発見した candidate を検証する。availability_only は candidate のまま。
  const discovered = pass1.items.flatMap((wrapped) => (wrapped.item.source ? [wrapped.item.source] : []));
  const newlyVerified: CountrySource[] = [];
  for (const candidate of discovered) {
    if (remainingMs() <= 0) break;
    if (candidate.verificationStatus === 'verified') {
      newlyVerified.push(candidate);
      continue;
    }
    try {
      const checked = await verifySource(candidate);
      if (checked.verificationStatus === 'verified' && checked.verificationBasis !== 'availability_only') {
        newlyVerified.push(checked);
      }
    } catch {}
  }

  // Pass 2: 検証済み source (今回 + 過去の地域 source + 依存注入) のみで深掘りする。
  const storedVerified = getVerifiedCountrySources(region.id);
  const injectedVerified = (dependencies.sources ?? []).filter((source) => source.verificationStatus === 'verified');
  const pass2Queries = planCountryResearchPass2(request, region, capabilities, {
    verifiedSources: [...newlyVerified, ...storedVerified, ...injectedVerified],
  });
  const pass2Plan = { ...pass1Plan, pass1: [], pass2: pass2Queries };
  // 追加検索は残り時間以内に収める。残り1秒は応答生成用に確保する。
  runOptions.timeoutMs = Math.min(runOptions.timeoutMs, Math.max(50, remainingMs() - 1000));
  const pass2 = await runProviderPass(pass2Plan, 2, providers, runOptions);

  const mergedItems: AcquiredItem[] = [...pass1.items, ...pass2.items];
  const mergedRuns: ProviderRun[] = mergeProviderRuns([...pass1.runs, ...pass2.runs]);
  const acquisition = { items: mergedItems, runs: mergedRuns };

  const periodDays = request.period === '7d' ? 7 : request.period === '90d' ? 90 : 30;
  const windowFrom = new Date(nowDate.getTime() - periodDays * 86_400_000).toISOString();
  const windowTo = nowDate.toISOString();

  // 重複排除と同時に旧ID→代表IDの対応を作る。参照統一に使う。
  const { evidence: deduped, remap } = deduplicateEvidenceWithRemap(
    acquisition.items.flatMap((wrapped) => (wrapped.item.evidence ? [wrapped.item.evidence] : [])),
  );
  const queriesByProvider = new Map<string, { query: string }[]>();
  for (const query of [...pass1Plan.pass1, ...pass2Queries]) {
    const list = queriesByProvider.get(query.providerId) ?? [];
    list.push(query);
    queriesByProvider.set(query.providerId, list);
  }
  const canonicalWrapped = new Map<string, AcquiredItem>();
  for (const wrapped of acquisition.items) {
    const itemEvidence = wrapped.item.evidence;
    const itemDetail = wrapped.item.detail;
    const key = itemEvidence ? remap.get(itemEvidence.id) : itemDetail?.evidenceId;
    if (key && !canonicalWrapped.has(key)) canonicalWrapped.set(key, wrapped);
  }
  // 取得経路・地域関連を証拠に付与する。重複排除で失わない。
  const links = new Map<string, RegionLink>();
  const evidence: CountryEvidence[] = deduped.map((item) => {
    const source = canonicalWrapped.get(item.id);
    const providerId = source?.providerId ?? 'unknown';
    const providerQueries = queriesByProvider.get(providerId) ?? [];
    const targeted = isQueryTargeted(providerQueries, region);
    const classified = classifyRegionLink(item, region, targeted);
    links.set(item.id, classified.link);
    const providerDef = providers.find((provider) => provider.id === providerId);
    return {
      ...item,
      acquisition: {
        providerId,
        ...(source?.item.detail?.providerItemId ? { providerItemId: source.item.detail.providerItemId } : {}),
        ...(providerQueries[0] ? { query: providerQueries[0].query } : {}),
        queryTargetedRegion: targeted,
        ...(providerDef?.collectionWindowDays !== undefined
          ? { collectionScope: '~' + String(providerDef.collectionWindowDays) + 'd' }
          : {}),
      },
      regionLink: classified.link,
      regionLinkReasons: classified.reasons,
    };
  });
  const polls = acquisition.items.flatMap((wrapped) => (wrapped.item.poll ? [wrapped.item.poll] : []));
  const calendar = acquisition.items.flatMap((wrapped) => (wrapped.item.calendar ? [wrapped.item.calendar] : []));
  const temporalMetrics = acquisition.items.flatMap((wrapped) => (wrapped.item.metric ? [wrapped.item.metric] : []));
  const sources = acquisition.items.flatMap((wrapped) => (wrapped.item.source ? [wrapped.item.source] : []));

  // 詳細は代表IDへ寄せて重複を除く。構造化日時はイベント抽出に渡す。
  const detailByEvidence = new Map<string, EvidenceDetail>();
  for (const wrapped of acquisition.items) {
    const detail = wrapped.item.detail;
    if (!detail) continue;
    const canonical = remap.get(detail.evidenceId) ?? detail.evidenceId;
    if (!detailByEvidence.has(canonical)) detailByEvidence.set(canonical, { ...detail, evidenceId: canonical });
  }
  const drafts = evidence
    .map((item) => {
      const detail = detailByEvidence.get(item.id);
      return extractEvent(
        item,
        region,
        nowDate,
        detail ? { occurredAt: detail.occurredAt, updatedAt: detail.updatedAt } : undefined,
      );
    })
    .filter((draft): draft is NonNullable<typeof draft> => draft !== undefined);
  const clustered = clusterEvents(filterRegionRelevantDrafts(drafts, links), evidence, [...detailByEvidence.values()]);
  const windowed = filterEventsByWindow(clustered, detailByEvidence, windowFrom, windowTo);
  // 主要イベントは地域関連の確認済み（direct/related）だけ。候補は件数に混ぜない。
  const relevantEvents = windowed.filter((event) =>
    event.evidenceIds.some((id) => links.get(id) === 'direct' || links.get(id) === 'related'),
  );
  const keyEvents = attachEventIndicators(relevantEvents, [...detailByEvidence.values()]);
  const elections = keyEvents.filter((event) => event.type === 'election');
  const foreignRelations = buildForeignRelations(keyEvents, polls, temporalMetrics, evidence);
  const japan = buildJapanView(foreignRelations);

  // 各 provider が実際に取得した evidence のみ紐付ける。他者の借用は禁止。
  const evidenceByProviderArea: Record<string, readonly string[]> = {};
  for (const wrapped of acquisition.items) {
    const ids: string[] = [];
    if (wrapped.item.evidence) ids.push(remap.get(wrapped.item.evidence.id) ?? wrapped.item.evidence.id);
    if (wrapped.item.detail) ids.push(remap.get(wrapped.item.detail.evidenceId) ?? wrapped.item.detail.evidenceId);
    if (wrapped.item.calendar) ids.push(wrapped.item.calendar.id);
    if (ids.length === 0) continue;
    for (const area of wrapped.areas) {
      const key = `${wrapped.providerId}:${area}`;
      evidenceByProviderArea[key] = [...(evidenceByProviderArea[key] ?? []), ...ids];
    }
  }
  // 記事以外の統計・カレンダーも対応する証拠として評価する。
  const extraCoverageIds = acquisition.items.flatMap((wrapped) => [
    ...(wrapped.item.detail ? [remap.get(wrapped.item.detail.evidenceId) ?? wrapped.item.detail.evidenceId] : []),
    ...(wrapped.item.calendar ? [wrapped.item.calendar.id] : []),
  ]);
  const coverage = buildCoverage(acquisition.runs, evidence, evidenceByProviderArea, extraCoverageIds);
  const mixedOutcome =
    acquisition.runs.some((run) => run.status === 'success' || run.status === 'partial') &&
    acquisition.runs.some((run) => run.status === 'unavailable' || run.status === 'rate_limited' || run.status === 'error');
  if (coverage.overall === 'limited' && mixedOutcome && evidence.length > 0) {
    coverage.overall = 'partial';
  }

  const situation = assembleSituation(keyEvents, evidence, request.period);

  // 分野横断で使える metric 観測 → signal → domain view。推奨・評価は含めない。
  // 指標は地域関連の確認済みだけから作る。候補は件数に混ぜない。祝日は該当日のみ数える。
  const relevantIds = new Set(
    [...links].filter(([, link]) => link === 'direct' || link === 'related').map(([id]) => id),
  );
  const fromMs = Date.parse(windowFrom);
  const toMs = Date.parse(windowTo);
  const calendarsInWindow = calendar.filter((entry) => {
    const parsed = Date.parse(entry.date);
    return Number.isFinite(parsed) && parsed >= fromMs && parsed <= toMs;
  });
  const observations = buildMetricObservations(keyEvents, acquisition.items, {
    regionId: region.id,
    window: request.period,
    observedAt: nowDate.toISOString(),
  }, calendarsInWindow, relevantIds);
  saveMetricObservations(observations.map((observation) => ({
    regionId: observation.regionId,
    metricKey: observation.metricKey,
    metricKind: observation.metricKind,
    window: observation.window,
    observedAt: observation.observedAt,
    currentValue: observation.currentValue,
    origin: observation.origin,
    providerIds: observation.providerIds,
    evidenceIds: observation.evidenceIds,
  })));
  const signals: IntelligenceSignal[] = observations.map((observation) =>
    deriveIntelligenceSignal({
      metricKey: observation.metricKey,
      regionId: observation.regionId,
      value: observation.currentValue,
      window: observation.window,
      observedAt: observation.observedAt,
      origin: observation.origin,
      evidenceIds: observation.evidenceIds,
      providerIds: observation.providerIds,
      coverage: coverage.overall,
      baselineSamples: queryBaselineObservations(
        observation.regionId,
        observation.metricKey,
        observation.window,
      ).map((stored) => stored.currentValue),
    }),
  );
  const domainInput = { regionId: region.id, signals, coverage: coverage.overall };
  const domains = {
    content: buildContentView(domainInput),
    marketing: buildMarketingView(domainInput),
    travel: buildTravelView(domainInput),
    finance: buildFinanceView(domainInput),
  };

  const contextId = randomUUID();
  // 本文補完は残り時間で。本文は同じレスポンス内の evidenceDetails に載せる。
  const enriched = await enrichDetailsWithArticles(
    [...detailByEvidence.values()],
    links,
    dependencies.scrapeArticle,
    dependencies.enrich ?? {},
    remainingMs,
  );
  const finalDetails = enriched.details;
  const finalDetailById = new Map(finalDetails.map((detail) => [detail.evidenceId, detail]));
  // 補完後の本文を factors 生成にも反映する。旧IDは代表IDへ寄せる。
  // キャッシュ共有物の破壊を避けるため複製する。
  const enrichedItems = mergedItems.map((wrapped) => {
    const oldId = wrapped.item.detail?.evidenceId;
    if (!oldId) return wrapped;
    const upgraded = finalDetailById.get(remap.get(oldId) ?? oldId);
    return upgraded ? { ...wrapped, item: { ...wrapped.item, detail: upgraded } } : wrapped;
  });
  // 参照を代表IDへ統一する。重複排除で消えたIDの参照は残さない。
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const facts = evidenceToFacts(enrichedItems)
    .map((fact) => ({ ...fact, evidenceIds: fact.evidenceIds.map((id) => remap.get(id) ?? id) }))
    .filter((fact) => fact.evidenceIds.length > 0 && fact.evidenceIds.every((id) => evidenceById.has(id)));
  const limitations: Limitation[] = acquisition.runs
    .filter((run) => run.status !== 'success')
    .map((run) => ({
      code: run.status === 'rate_limited' ? 'rate_limited' : run.status === 'error' ? 'provider_error' : 'provider_unavailable',
      area: (run.coverage ?? []).join(',') || 'general',
      providerId: run.provider,
      message: run.provider + ' ' + run.status + (run.errorCode ? ' ' + run.errorCode : ''),
      evidenceIds: [],
    }));
  // 未要求の SNS と要求済みだが未構成・失敗の SNS を区別する。
  if (!request.includeSocial) {
    limitations.push({
      code: 'social_not_requested', area: 'social',
      message: 'social observations were not requested (includeSocial=false)', evidenceIds: [],
    });
  }
  if (enriched.outcome.unavailable && enriched.outcome.skippedBudget > 0) {
    limitations.push({
      code: 'article_enrichment_unavailable', area: 'general',
      message: 'article body fetcher is not configured; ' + String(enriched.outcome.skippedBudget) + ' excerpt-only details left unenriched',
      evidenceIds: [],
    });
  }
  const succeeded = acquisition.runs.some((run) => run.status === 'success' || run.status === 'partial');
  const runFailed = acquisition.runs.some((run) => run.status === 'unavailable' || run.status === 'rate_limited' || run.status === 'error');
  // 要求期間のコピーではなく取得元の実収集範囲から期間を作る。
  const actualWindows: ActualWindow[] = buildActualWindows(
    windowFrom,
    windowTo,
    acquisition.runs,
    acquisition.runs.map((run) => ({
      provider: run.provider,
      status: run.status,
      ...(providers.find((provider) => provider.id === run.provider)?.collectionWindowDays !== undefined
        ? { collectionWindowDays: providers.find((provider) => provider.id === run.provider)?.collectionWindowDays }
        : {}),
    })),
    periodDays,
  );
  // 初回応答に同梱する詳細。参照元があるものだけに絞る。
  const referencedIds = new Set([
    ...keyEvents.flatMap((event) => event.evidenceIds),
    ...facts.flatMap((fact) => fact.evidenceIds),
    ...calendar.flatMap((entry) => entry.evidenceId ? [entry.evidenceId] : []),
  ]);
  const evidenceDetails = finalDetails.filter((detail) => referencedIds.has(detail.evidenceId));
  enriched.outcome.omittedDetails = finalDetails.length - evidenceDetails.length;
  const report = CountryContextReportSchema.parse({
    contextId,
    region,
    asOf: nowDate.toISOString(),
    situation,
    elections,
    calendar,
    foreignRelations,
    japan,
    polls,
    keyEvents,
    temporalMetrics,
    signals,
    domains,
    providerCoverage: acquisition.runs,
    coverage,
    evidence,
    evidenceDetails,
    enrichment: { ...enriched.outcome },
    schemaVersion: '3',
    domainContext: {
      general: buildDomainContext('general', facts, limitations, keyEvents, links),
      content: buildDomainContext('content', facts, limitations, keyEvents, links),
      marketing: buildDomainContext('marketing', facts, limitations, keyEvents, links),
      finance: buildDomainContext('finance', facts, limitations, keyEvents, links),
      tourism: buildDomainContext('tourism', facts, limitations, keyEvents, links),
      travel: buildDomainContext('travel', facts, limitations, keyEvents, links),
    },
    limitations,
    refreshState: { state: !runFailed && succeeded ? 'complete' : succeeded ? 'partial' : 'pending', refreshId: contextId },
    actualWindows,
  } satisfies CountryContextReport);

  saveCountryContext(report, {
    providerRuns: acquisition.runs,
    evidence,
    events: keyEvents,
    polls,
    calendar,
    sources,
  });
  saveEvidenceDetails(contextId, finalDetails);
  return report;
}
