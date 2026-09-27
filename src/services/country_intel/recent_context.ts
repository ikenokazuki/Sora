import type { EvidenceDetail } from './detail.js';
import type { AcquiredItem } from './provider_registry.js';
import type { CountryEvidence, Limitation, ProviderRun, RecentContext, RecentReport, RecentSourceState, RecentTopic, RegionIdentity } from './types.js';
/** 話題リスト系。取得時刻が観測時刻であり、投稿時刻ではない。 */
export const HOT_CONTEXT_PROVIDERS: readonly string[] = ['weibo_hot', 'zhihu_hot', 'toutiao_hot'];
/** 記事系。publishedAt を持つ証拠を年齢付きで載せる。 */
export const ARTICLE_CONTEXT_PROVIDERS: readonly string[] = ['wallstreet_live', 'cctv_news', 'thepaper_hot', 'official_web', 'global_feeds', 'google_news', 'bing_news', 'so360_search', 'baidu_hot', 'gdelt_export'];
const FLASH_MS = 15 * 60_000;
const RECENT_MS = 24 * 60 * 60_000;
export interface RecentContextInput {
  now: Date;
  region: RegionIdentity;
  items: readonly AcquiredItem[];
  runs: readonly ProviderRun[];
  evidenceById: ReadonlyMap<string, CountryEvidence>;
  detailsById: ReadonlyMap<string, EvidenceDetail>;
  /** 重複排除前の生ID→代表ID。渡された場合、報告・話題の証拠参照を代表IDへ寄せる。 */
  evidenceIdRemap?: ReadonlyMap<string, string>;
  previousRanks?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  limitations: readonly Limitation[];
}
function detailOf(item: AcquiredItem): EvidenceDetail | undefined {
  return item.item.detail;
}
function canonicalEvidenceId(input: RecentContextInput, rawId: string): string {
  return input.evidenceIdRemap?.get(rawId) ?? rawId;
}
function topicRecords(items: readonly AcquiredItem[]): { providerId: string; detail: EvidenceDetail }[] {
  return items.flatMap((wrapped) => {
    const detail = detailOf(wrapped);
    if (!detail || !HOT_CONTEXT_PROVIDERS.includes(wrapped.providerId)) return [];
    return [{ providerId: wrapped.providerId, detail }];
  });
}
function rankChange(previous: number, current: number): 'up' | 'down' | 'steady' {
  return current < previous ? 'up' : current > previous ? 'down' : 'steady';
}
function buildTopics(input: RecentContextInput): RecentTopic[] {
  const grouped = new Map<string, { title: string; providers: Set<string>; ranks: number[]; hots: string[]; pinned: boolean; firstSeenAt: string; lastSeenAt: string; evidenceIds: Set<string> }>();
  for (const record of topicRecords(input.items)) {
    const structured = record.detail.structuredData ?? {};
    const topicId = typeof structured['topicId'] === 'string' && structured['topicId'] ? structured['topicId'] : record.detail.providerItemId;
    const evidenceId = canonicalEvidenceId(input, record.detail.evidenceId);
    const evidence = input.evidenceById.get(evidenceId);
    const slot = grouped.get(topicId) ?? { title: evidence?.title ?? topicId, providers: new Set<string>(), ranks: [], hots: [], pinned: false, firstSeenAt: record.detail.retrievedAt, lastSeenAt: record.detail.retrievedAt, evidenceIds: new Set<string>() };
    slot.providers.add(record.providerId);
    if (typeof structured['rank'] === 'number') slot.ranks.push(structured['rank']);
    if (typeof structured['hot'] === 'string' && structured['hot']) slot.hots.push(structured['hot']);
    if (typeof structured['hotIndex'] === 'string' && structured['hotIndex']) slot.hots.push(structured['hotIndex']);
    if (structured['pinned'] === true) slot.pinned = true;
    if (record.detail.retrievedAt < slot.firstSeenAt) slot.firstSeenAt = record.detail.retrievedAt;
    if (record.detail.retrievedAt > slot.lastSeenAt) slot.lastSeenAt = record.detail.retrievedAt;
    slot.evidenceIds.add(evidenceId);
    grouped.set(topicId, slot);
  }
  const topics: RecentTopic[] = [...grouped].map(([topicId, slot]) => {
  const rank = slot.ranks.length > 0 ? Math.min(...slot.ranks) : undefined;
    let previousRank: number | undefined;
    for (const providerId of slot.providers) {
      const found = input.previousRanks?.get(providerId)?.get(topicId);
      if (found !== undefined) { previousRank = found; break; }
    }
    return {
      topicId,
      title: slot.title,
      providers: [...slot.providers].sort(),
      ...(rank !== undefined ? { rank } : {}),
      ...(slot.hots[0] ? { hot: slot.hots[0] } : {}),
      ...(slot.pinned ? { pinned: true } : {}),
      firstSeenAt: slot.firstSeenAt,
      lastSeenAt: slot.lastSeenAt,
      evidenceIds: [...slot.evidenceIds],
      ...(previousRank !== undefined ? { previousRank } : {}),
      ...(previousRank !== undefined && rank !== undefined ? { rankChange: rankChange(previousRank, rank) } : {}),
    };
  });
  topics.sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) || right.providers.length - left.providers.length);
  return topics.slice(0, 20);
}
function ageClass(publishedAt: string | undefined, nowMs: number): RecentReport['ageClass'] {
  if (!publishedAt) return 'unknown';
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return 'unknown';
  const age = nowMs - parsed;
  if (age < 0) return 'unknown';
  if (age <= FLASH_MS) return 'flash';
  if (age <= RECENT_MS) return 'recent';
  return 'background';
}
function buildReports(input: RecentContextInput): RecentReport[] {
  const nowMs = input.now.getTime();
  const reports: RecentReport[] = [];
  for (const wrapped of input.items) {
    if (HOT_CONTEXT_PROVIDERS.includes(wrapped.providerId)) continue;
    const evidence = wrapped.item.evidence;
    if (!evidence) continue;
    if (!ARTICLE_CONTEXT_PROVIDERS.includes(wrapped.providerId)) continue;
    const evidenceId = canonicalEvidenceId(input, evidence.id);
    const canonical = input.evidenceById.get(evidenceId) ?? evidence;
    reports.push({
      evidenceId,
      title: canonical.title ?? canonical.url,
      ...(canonical.publisher ? { publisher: canonical.publisher } : {}),
      url: canonical.url,
      ...(canonical.publishedAt ? { publishedAt: canonical.publishedAt } : {}),
      ageClass: ageClass(canonical.publishedAt, nowMs),
    });
  }
  reports.sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''));
  const seen = new Set<string>();
  return reports.filter((report) => {
    if (seen.has(report.evidenceId)) return false;
    seen.add(report.evidenceId);
    return true;
  }).slice(0, 20);
}
function buildSources(input: RecentContextInput): { sources: RecentSourceState[]; gaps: Limitation[] } {
  const wanted = new Set([...HOT_CONTEXT_PROVIDERS, ...ARTICLE_CONTEXT_PROVIDERS]);
  const sources: RecentSourceState[] = [];
  const gaps: Limitation[] = [];
  const upstreamByProvider = new Map<string, string>();
  for (const wrapped of input.items) {
    if (upstreamByProvider.has(wrapped.providerId)) continue;
    const upstream = wrapped.item.detail?.structuredData?.['upstreamUpdatedAt'];
    if (typeof upstream === 'string' && upstream) upstreamByProvider.set(wrapped.providerId, upstream);
  }
  for (const run of input.runs) {
    if (!wanted.has(run.provider)) continue;
    if (sources.some((source) => source.provider === run.provider)) continue;
    const itemCount = run.itemCount;
    const upstream = upstreamByProvider.get(run.provider);
    const stale = run.status !== 'success' || itemCount === 0 || (upstream !== undefined && input.now.getTime() - Date.parse(upstream) > FLASH_MS);
    sources.push({
      provider: run.provider,
      status: run.status,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      itemCount,
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      ...(upstream ? { upstreamUpdatedAt: upstream } : {}),
      stale,
    });
    if (run.status === 'success' && itemCount === 0) {
      gaps.push({ code: 'recent_context_gap', area: 'media', providerId: run.provider, message: run.provider + ' returned no items in this request', evidenceIds: [] });
    }
  }
  return { sources, gaps };
}
export function buildRecentContext(input: RecentContextInput): RecentContext {
  const topics = buildTopics(input);
  const reports = buildReports(input);
  const built = buildSources(input);
  const relevant = new Set([...HOT_CONTEXT_PROVIDERS, ...ARTICLE_CONTEXT_PROVIDERS]);
  const limitations = [
    ...input.limitations.filter((limitation) => limitation.providerId !== undefined && relevant.has(limitation.providerId)),
    ...built.gaps,
  ];
  return {
    generatedAt: input.now.toISOString(),
    windowHours: 24,
    topics,
    reports,
    sources: built.sources,
    limitations,
  };
}
