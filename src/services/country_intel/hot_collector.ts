import { resolveRegion } from './region.js';
import { pruneHotObservations, saveHotObservations, type HotObservation, type HotObservationInput } from './db.js';
import type { CollectionJob } from './collector.js';
import type { CountryIntelProvider } from './provider_registry.js';
import type { GdeltFetch } from './providers/gdelt.js';
import { createWeiboHotProvider } from './providers/weibo_hot.js';
import { createZhihuHotProvider } from './providers/zhihu_hot.js';
import { createToutiaoHotProvider } from './providers/toutiao_hot.js';
import { createWallstreetLiveProvider } from './providers/wallstreet_live.js';
import { createCctvNewsProvider } from './providers/cctv_news.js';
import { createThepaperHotProvider } from './providers/thepaper_hot.js';
export interface HotSourceDef {
  sourceId: string;
  region: string;
  intervalMs: number;
  createProvider: (fetchFn?: GdeltFetch) => CountryIntelProvider;
}
const FIVE_MINUTES = 5 * 60_000;
const TEN_MINUTES = 10 * 60_000;
export const DEFAULT_HOT_SOURCES: readonly HotSourceDef[] = [
  { sourceId: 'weibo_hot', region: 'CN', intervalMs: FIVE_MINUTES, createProvider: (fetchFn) => createWeiboHotProvider(fetchFn) },
  { sourceId: 'zhihu_hot', region: 'CN', intervalMs: FIVE_MINUTES, createProvider: (fetchFn) => createZhihuHotProvider(fetchFn) },
  { sourceId: 'toutiao_hot', region: 'CN', intervalMs: FIVE_MINUTES, createProvider: (fetchFn) => createToutiaoHotProvider(fetchFn) },
  { sourceId: 'wallstreet_live', region: 'CN', intervalMs: FIVE_MINUTES, createProvider: (fetchFn) => createWallstreetLiveProvider(fetchFn) },
  { sourceId: 'cctv_news', region: 'CN', intervalMs: TEN_MINUTES, createProvider: (fetchFn) => createCctvNewsProvider(fetchFn) },
  { sourceId: 'thepaper_hot', region: 'CN', intervalMs: TEN_MINUTES, createProvider: (fetchFn) => createThepaperHotProvider(fetchFn) },
];
export function hotCollectRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.SORA_INTEL_COLLECT_REGIONS ?? '').split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  return list.length > 0 ? list : ['CN'];
}
export interface HotCollectDeps {
  fetchFn?: GdeltFetch;
  now?: () => number;
}
export interface HotCollectResult {
  cursor: string;
  observedAt: string;
  observed: number;
}
function hotText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function hotRank(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
export function toHotObservationInputs(sourceId: string, regionId: string, observedAt: string, items: readonly { evidence?: { title?: string; url: string }; detail?: { providerItemId: string; structuredData?: Record<string, unknown> } }[]): HotObservationInput[] {
  return items.flatMap((wrapped) => {
    const evidence = wrapped.evidence;
    const detail = wrapped.detail;
    if (!evidence || !detail) return [];
    const structured = detail.structuredData ?? {};
    const topicId = hotText(structured['topicId']) ?? hotText(structured['liveId']) ?? hotText(structured['articleId']) ?? hotText(structured['contId']) ?? detail.providerItemId;
    if (!topicId) return [];
    return [{
      sourceId,
      topicId,
      regionId,
      observedAt,
      rank: hotRank(structured['rank']),
      hot: hotText(structured['hot']) ?? hotText(structured['hotIndex']),
      pinned: structured['pinned'] === true,
      title: evidence.title ?? evidence.url,
      url: evidence.url,
      upstreamUpdatedAt: hotText(structured['upstreamUpdatedAt']),
    }];
  });
}
export async function collectHotSource(def: HotSourceDef, deps: HotCollectDeps = {}): Promise<HotCollectResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const region = resolveRegion(def.region);
  const provider = def.createProvider(deps.fetchFn);
  const signal = AbortSignal.timeout(provider.timeoutMs ?? 8000);
  const result = await provider.run({ request: { region: def.region } as never, region, queries: [] }, signal);
  const observedAt = new Date(nowMs).toISOString();
  const inputs = toHotObservationInputs(def.sourceId, region.id, observedAt, result.items);
  saveHotObservations(inputs);
  pruneHotObservations(nowMs);
  return { cursor: observedAt, observedAt, observed: inputs.length };
}
export function createHotCollectorJobs(regions: readonly string[] = hotCollectRegions(), deps: HotCollectDeps = {}): CollectionJob[] {
  return DEFAULT_HOT_SOURCES.filter((def) => regions.includes(def.region)).map((def) => ({
    sourceId: 'hot:' + def.sourceId,
    intervalMs: def.intervalMs,
    collect: async () => {
      const collected = await collectHotSource(def, deps);
      return { cursor: collected.cursor, details: [] };
    },
  }));
}
export type HotTopicChangeKind = 'new' | 'dropped' | 'rank_up' | 'rank_down' | 'steady';
export interface HotTopicChange {
  topicId: string;
  kind: HotTopicChangeKind;
  title: string;
  previousRank?: number;
  currentRank?: number;
}
export function diffHotSnapshots(previous: readonly HotObservation[], current: readonly HotObservation[]): HotTopicChange[] {
  const before = new Map(previous.map((item) => [item.topicId, item]));
  const seen = new Set<string>();
  const changes: HotTopicChange[] = [];
  for (const item of current) {
    seen.add(item.topicId);
    const old = before.get(item.topicId);
    if (!old) {
      changes.push({ topicId: item.topicId, kind: 'new', title: item.title });
      continue;
    }
    if (old.rank !== undefined && item.rank !== undefined && old.rank !== item.rank) {
      changes.push({ topicId: item.topicId, kind: item.rank < old.rank ? 'rank_up' : 'rank_down', title: item.title, previousRank: old.rank, currentRank: item.rank });
      continue;
    }
    changes.push({ topicId: item.topicId, kind: 'steady', title: item.title });
  }
  for (const old of previous) {
    if (!seen.has(old.topicId)) changes.push({ topicId: old.topicId, kind: 'dropped', title: old.title });
  }
  return changes;
}
