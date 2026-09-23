import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const WEIBO_HOT_URL = 'https://weibo.com/ajax/side/hotSearch';
export const WEIBO_HOT_PAGE_URL = 'https://weibo.com/hot';
export const WEIBO_HOT_MAX_ITEMS = 30;
const WEIBO_HOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface WeiboHotEntry { id: string; query: string; hotIndex: string; tag: string; rank: number | null; pinned: boolean; }

/** 順位変動に左右されない話題ID。前後の#と空白を正規化する。 */
export function normalizeWeiboTopicId(query: string): string {
  return query.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^#+|#+$/g, '').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNum(value: unknown): string {
  return typeof value === 'number' ? String(value) : asText(value);
}

function asRank(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isAdRecord(record: Record<string, unknown> | undefined): boolean {
  return record?.['is_ad'] === 1 || record?.['is_ad'] === true || record?.['topic_ad'] === 1 || record?.['topic_ad'] === true;
}

/** live実測構造 data.realtime[] + data.hotgovs[]。話題把握用、任意検索ではない。 */
export function parseWeiboHotJson(text: string): WeiboHotEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'Weibo hot list envelope unexpected');
  }
  const root = asRecord(data);
  const inner = asRecord(root?.['data']) ?? root;
  const realtime = inner?.['realtime'];
  const hotgovs = inner?.['hotgovs'];
  const entries: WeiboHotEntry[] = [];
  const seen = new Set<string>();
  const push = (query: string, hotIndex: string, tag: string, rank: number | null, pinned: boolean): void => {
    const id = normalizeWeiboTopicId(query);
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push({ id, query: query.trim(), hotIndex, tag, rank, pinned });
  };
  if (Array.isArray(hotgovs)) {
    for (const item of hotgovs.slice(0, 3)) {
      const record = asRecord(item);
      const query = asText(record?.['word']) || asText(record?.['note']);
      if (!query.trim()) continue;
      push(query, '', asText(record?.['icon_desc']) || 'gov', null, true);
      if (entries.length >= WEIBO_HOT_MAX_ITEMS) break;
    }
  }
  if (!Array.isArray(realtime)) {
    if (entries.length) return entries.slice(0, WEIBO_HOT_MAX_ITEMS);
    throw new ProviderHttpError(502, undefined, 'Weibo hot list envelope unexpected');
  }
  for (const item of realtime) {
    const record = asRecord(item);
    if (isAdRecord(record)) continue;
    const query = asText(record?.['word']) || asText(record?.['note']) || asText(record?.['word_scheme']);
    if (!query.trim()) continue;
    const tag = asText(record?.['label_name']) || asText(record?.['icon_desc']);
    push(query, asNum(record?.['num']), tag, asRank(record?.['realpos']), false);
    if (entries.length >= WEIBO_HOT_MAX_ITEMS) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'Weibo hot list envelope unexpected');
  return entries;
}

export function weiboHotItemUrl(query: string): string {
  return 'https://s.weibo.com/weibo?q=' + encodeURIComponent(query);
}

export function createWeiboHotProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'weibo_hot', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(8000);
        const combined = signal.aborted ? signal : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout);
        res = await runFetch(WEIBO_HOT_URL, {
          signal: combined,
          headers: {
            'User-Agent': WEIBO_HOT_UA,
            Referer: 'https://weibo.com/',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
        });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      if (!res.ok) throw new ProviderHttpError(res.status, res.headers.get('retry-after') ?? undefined, 'Provider HTTP ' + res.status);
      const text = await res.text();
      const entries = parseWeiboHotJson(text);
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        const url = weiboHotItemUrl(entry.query);
        const rankLabel = entry.rank !== null ? 'rank ' + String(entry.rank) : entry.pinned ? 'pinned' : 'unranked';
        const excerpt = entry.query + ' (observed ' + rankLabel + (entry.hotIndex ? ', hot ' + entry.hotIndex : '') + (entry.tag ? ' [' + entry.tag + ']' : '') + ')';
        const evidence = normalizeEvidence({ url, title: entry.query, excerpt: excerpt.slice(0, 2000), publisher: 'Weibo Hot Search', language: 'zh', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'weibo_hot', providerItemId: 'weibo:' + entry.id, sourceRecordUrl: url, contentKind: 'excerpt', language: 'zh', blocks: [{ index, text: excerpt.slice(0, 2000) }], structuredData: { topicId: entry.id, rank: entry.rank, pinned: entry.pinned, hotIndex: entry.hotIndex, tag: entry.tag }, retrievedAt: at, timeBasis: 'provider_observation', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: excerpt.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
