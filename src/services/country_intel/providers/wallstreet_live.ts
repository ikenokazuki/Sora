import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const WALLSTREET_LIVE_URL = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30';
export const WALLSTREET_LIVE_MAX_ITEMS = 30;

export interface WallstreetLiveEntry { id: string; title: string; excerpt: string; url: string; publishedAt?: string; }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(Math.round(value * 1000)).toISOString();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** live実測構造 data.items[].{id,title,content_text,display_time,uri}。 */
export function parseWallstreetLiveJson(text: string): WallstreetLiveEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'WallStreetCN live envelope unexpected');
  }
  const list = asRecord(asRecord(data)?.['data'])?.['items'];
  if (!Array.isArray(list)) throw new ProviderHttpError(502, undefined, 'WallStreetCN live envelope unexpected');
  const entries: WallstreetLiveEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const body = stripHtml(asText(record?.['content_text']));
    const title = asText(record?.['title']).trim() || body.slice(0, 120);
    const url = asText(record?.['uri']).trim();
    if (!title || !url || !/^https?:\/\//.test(url)) continue;
    const publishedAt = asEpochSeconds(record?.['display_time']);
    entries.push({
      id: String(record?.['id'] ?? url),
      title: title.slice(0, 300),
      excerpt: body,
      url,
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (entries.length >= WALLSTREET_LIVE_MAX_ITEMS) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'WallStreetCN live envelope unexpected');
  return entries;
}

export function createWallstreetLiveProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'wallstreet_live', areas: ['media_activity', 'economy'], latencyClass: 'near_realtime', defaultTtlSeconds: 300,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      let res: Response;
      try {
        res = await fetchProviderResponse(WALLSTREET_LIVE_URL, { sourceId: 'wallstreet_live', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseWallstreetLiveJson(await res.text());
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: entry.excerpt.slice(0, 2000) || undefined, publisher: 'WallStreetCN Live', language: 'zh', publishedAt: entry.publishedAt, sourceType: 'major_local_media', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'wallstreet_live', providerItemId: 'wscn:' + entry.id, sourceRecordUrl: entry.url, contentKind: 'excerpt', language: 'zh', blocks: entry.excerpt ? [{ index, text: entry.excerpt.slice(0, 2000) }] : [], structuredData: { liveId: entry.id }, publishedAt: entry.publishedAt, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: entry.excerpt.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
