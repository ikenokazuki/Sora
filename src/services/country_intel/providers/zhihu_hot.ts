import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const ZHIHU_HOT_URL = 'https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true';
export const ZHIHU_HOT_MAX_ITEMS = 20;

export interface ZhihuHotEntry { id: string; title: string; excerpt: string; url: string; hot: string; }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 順位変動に左右されない話題ID。 */
export function normalizeZhihuTopicId(title: string): string {
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function topicUrl(title: string, explicit: string): string {
  if (explicit && /^https?:\/\//.test(explicit)) return explicit;
  return 'https://www.zhihu.com/search?q=' + encodeURIComponent(title);
}

/** live実測構造 data[].target.{title_area,excerpt_area,metrics_area,link}。 */
export function parseZhihuHotJson(text: string): ZhihuHotEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'Zhihu hot list envelope unexpected');
  }
  const list = asRecord(data)?.['data'];
  if (!Array.isArray(list)) throw new ProviderHttpError(502, undefined, 'Zhihu hot list envelope unexpected');
  const entries: ZhihuHotEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const target = asRecord(asRecord(item)?.['target']);
    const title = asText(asRecord(target?.['title_area'])?.['text']).trim();
    if (!title) continue;
    const id = normalizeZhihuTopicId(title);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      title,
      excerpt: asText(asRecord(target?.['excerpt_area'])?.['text']).trim(),
      url: topicUrl(title, asText(asRecord(target?.['link'])?.['url'])),
      hot: asText(asRecord(target?.['metrics_area'])?.['text']).trim(),
    });
    if (entries.length >= ZHIHU_HOT_MAX_ITEMS) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'Zhihu hot list envelope unexpected');
  return entries;
}

export function createZhihuHotProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'zhihu_hot', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        res = await fetchProviderResponse(ZHIHU_HOT_URL, { sourceId: 'zhihu_hot', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseZhihuHotJson(await res.text());
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        const excerpt = entry.excerpt ? entry.title + ' — ' + entry.excerpt : entry.title;
        const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: excerpt.slice(0, 2000), publisher: 'Zhihu Hot List', language: 'zh', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'zhihu_hot', providerItemId: 'zhihu:' + entry.id, sourceRecordUrl: entry.url, contentKind: 'excerpt', language: 'zh', blocks: [{ index, text: excerpt.slice(0, 2000) }], structuredData: { topicId: entry.id, hot: entry.hot }, retrievedAt: at, timeBasis: 'provider_observation', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: excerpt.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
