import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const THEPAPER_HOT_URL = 'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar';
export const THEPAPER_HOT_MAX_ITEMS = 20;

export interface ThepaperHotEntry { id: string; title: string; url: string; publishedAt?: string; interactions: string; praises: string; }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asMillis(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(Math.round(value)).toISOString();
}

/** live実測構造 data.hotNews[].{contId,name,pubTimeLong,interactionNum,praiseTimes}。 */
export function parseThepaperHotJson(text: string): ThepaperHotEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'ThePaper hot list envelope unexpected');
  }
  const list = asRecord(asRecord(data)?.['data'])?.['hotNews'];
  if (!Array.isArray(list)) throw new ProviderHttpError(502, undefined, 'ThePaper hot list envelope unexpected');
  const entries: ThepaperHotEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const record = asRecord(item);
    const contId = asText(record?.['contId']).trim();
    const title = asText(record?.['name']).trim();
    if (!contId || !title || seen.has(contId)) continue;
    seen.add(contId);
    entries.push({
      id: contId,
      title: title.slice(0, 300),
      url: 'https://www.thepaper.cn/newsDetail_forward_' + encodeURIComponent(contId),
      ...(asMillis(record?.['pubTimeLong']) ? { publishedAt: asMillis(record?.['pubTimeLong']) } : {}),
      interactions: asText(record?.['interactionNum']).trim(),
      praises: asText(record?.['praiseTimes']).trim(),
    });
    if (entries.length >= THEPAPER_HOT_MAX_ITEMS) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'ThePaper hot list envelope unexpected');
  return entries;
}

export function createThepaperHotProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'thepaper_hot', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 600,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        res = await fetchProviderResponse(THEPAPER_HOT_URL, { sourceId: 'thepaper_hot', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseThepaperHotJson(await res.text());
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry) => {
        const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: undefined, publisher: 'The Paper', language: 'zh', publishedAt: entry.publishedAt, sourceType: 'major_local_media', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'thepaper_hot', providerItemId: 'thepaper:' + entry.id, sourceRecordUrl: entry.url, contentKind: 'title_only', language: 'zh', blocks: [], structuredData: { contId: entry.id, interactions: entry.interactions, praises: entry.praises }, publishedAt: entry.publishedAt, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
