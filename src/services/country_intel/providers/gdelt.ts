import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';

export interface GdeltDocArticle { url: string; title?: string; seendate?: string; domain?: string; language?: string; sourcecountry?: string; }
export interface GdeltDocFixture { articles?: GdeltDocArticle[]; }

export function buildGdeltDocUrl(query: string, maxRecords = 25, period?: string): string {
  const params = new URLSearchParams({ query, mode: 'ArtList', format: 'json', maxrecords: String(maxRecords), sort: 'DateDesc' });
  if (period === '7d' || period === '30d' || period === '90d') params.set('timespan', period);
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

export function parseGdeltSeendate(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export interface GdeltTimelinePoint { date: string; value: number; }
export interface GdeltTimelineFixture { timeline?: { series?: string; data?: { date?: string; value?: number }[] }[]; }

export interface HistoricalMediaObservation {
  date: string;
  value: number;
  origin: 'provider_historical';
}

/** GDELT DOC timeline (TimelineVol) URL。履歴ベースライン用の観測系列を取得する。 */
export function buildGdeltTimelineUrl(query: string, maxRecords = 25): string {
  const params = new URLSearchParams({ query, mode: 'TimelineVol', format: 'json' });
  void maxRecords;
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

/** 保存した timeline JSON を比較可能な日次バケットへ変換する。実通信しない。 */
export function parseGdeltTimeline(fixture: GdeltTimelineFixture): HistoricalMediaObservation[] {
  const series = (fixture.timeline ?? []).find((entry) => entry.series === 'Volume')
    ?? fixture.timeline?.[0];
  if (!series || !Array.isArray(series.data)) return [];
  return series.data.flatMap((point) => {
    const day = typeof point.date === 'string' ? /^(\d{4})(\d{2})(\d{2})/.exec(point.date) : null;
    if (!day || typeof point.value !== 'number' || !Number.isFinite(point.value)) return [];
    return [{ date: `${day[1]}-${day[2]}-${day[3]}`, value: point.value, origin: 'provider_historical' as const }];
  });
}

export function parseGdeltDocResponse(fixture: GdeltDocFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  const region = input.region;
  return (fixture.articles ?? []).filter((a) => a.url).map((article) => ({
    evidence: normalizeEvidence({
      url: article.url, title: article.title, publisher: article.domain,
      publisherCountry: article.sourcecountry,
      sourceType: 'international_media', language: article.language,
      publishedAt: parseGdeltSeendate(article.seendate),
      primarySource: false, latencyClass: 'near_realtime',
    }, region, now),
  }));
}

export type GdeltFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function createGdeltProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'gdelt', areas: ['media_activity', 'current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 3600,
    async run(input: ProviderInput, signal: AbortSignal): Promise<{ items: AcquisitionItem[]; coverage?: string[] }> {
      const query = input.queries.find((q) => q.providerId === 'gdelt')?.query ?? input.region.name;
      const url = buildGdeltDocUrl(query, 25, input.request.period);
      let res: Response;
      try { res = await runFetch(url, { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) throw new ProviderHttpError(502, undefined, 'GDELT unexpected content type');
      const data = (await res.json()) as GdeltDocFixture;
      if (!Array.isArray((data as GdeltDocFixture).articles)) throw new ProviderHttpError(502, undefined, 'GDELT envelope missing articles');
      return { items: parseGdeltDocResponse(data, input, new Date()), coverage: ['media_activity'] };
    },
  };
}
