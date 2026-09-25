import type { HotObservation, HotObservationInput } from './db.js';
/** 定期収集は廃止。report.ts が問い合わせ時に保存する。残るのは変換と差分の純粋関数。 */
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
