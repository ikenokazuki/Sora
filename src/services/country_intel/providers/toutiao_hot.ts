import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const TOUTIAO_HOT_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
export const TOUTIAO_HOT_MAX_ITEMS = 50;

export interface ToutiaoHotEntry { id: string; title: string; hot: string; url: string; label: string; }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** ClusterIdStr を話題IDにする。順位は保持しない。 */
export function normalizeToutiaoTopicId(clusterId: string, title: string): string {
  const id = clusterId.trim();
  if (id) return id;
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** live実測構造 data[].{ClusterIdStr,Title,HotValue,Label}。 */
export function parseToutiaoHotJson(text: string): ToutiaoHotEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'Toutiao hot list envelope unexpected');
  }
  const list = asRecord(data)?.['data'];
  if (!Array.isArray(list)) throw new ProviderHttpError(502, undefined, 'Toutiao hot list envelope unexpected');
  const entries: ToutiaoHotEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const record = asRecord(item);
    const title = asText(record?.['Title']).trim();
    if (!title) continue;
    const id = normalizeToutiaoTopicId(asText(record?.['ClusterIdStr']), title);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      title,
      hot: asText(record?.['HotValue']).trim(),
      url: 'https://www.toutiao.com/trending/' + encodeURIComponent(id) + '/',
      label: asText(record?.['Label']).trim(),
    });
    if (entries.length >= TOUTIAO_HOT_MAX_ITEMS) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'Toutiao hot list envelope unexpected');
  return entries;
}

export function createToutiaoHotProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'toutiao_hot', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        res = await fetchProviderResponse(TOUTIAO_HOT_URL, { sourceId: 'toutiao_hot', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseToutiaoHotJson(await res.text());
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        const excerpt = entry.hot ? entry.title + ' (hot ' + entry.hot + ')' : entry.title;
        const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: excerpt.slice(0, 2000), publisher: 'Toutiao Hot Board', language: 'zh', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'toutiao_hot', providerItemId: 'toutiao:' + entry.id, sourceRecordUrl: entry.url, contentKind: 'excerpt', language: 'zh', blocks: [{ index, text: excerpt.slice(0, 2000) }], structuredData: { topicId: entry.id, hot: entry.hot, label: entry.label }, retrievedAt: at, timeBasis: 'provider_observation', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: excerpt.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
