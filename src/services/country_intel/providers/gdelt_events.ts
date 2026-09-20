import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export interface GdeltEventRow { GLOBALEVENTID?: string; SQLDATE?: string; Actor1CountryCode?: string; ActionGeo_CountryCode?: string; EventCode?: string; NumArticles?: number; SOURCEURL?: string; }
export interface GdeltEventsFixture { events?: GdeltEventRow[]; }

export function buildGdeltEventsUrl(query: string, maxRecords = 50): string {
  const params = new URLSearchParams({ query, format: 'json', maxrecords: String(maxRecords) });
  return `https://api.gdeltproject.org/api/v2/events/events?${params.toString()}`;
}

function parseSqlDate(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : undefined;
}

export function parseGdeltEventsResponse(fixture: GdeltEventsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.events ?? []).filter((e) => e.SOURCEURL).map((row) => ({
    evidence: normalizeEvidence({
      url: row.SOURCEURL!, title: `GDELT event ${row.GLOBALEVENTID ?? 'unknown'}`,
      eventCountry: row.ActionGeo_CountryCode || undefined,
      mentionedCountries: [row.Actor1CountryCode, row.ActionGeo_CountryCode].filter((v): v is string => Boolean(v)),
      sourceType: 'structured_dataset', publishedAt: parseSqlDate(row.SQLDATE),
      excerpt: `EventCode ${row.EventCode ?? 'unknown'} articles ${row.NumArticles ?? 0}`,
      primarySource: false, latencyClass: 'delayed',
    }, input.region, now),
  }));
}

export function createGdeltEventsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'gdelt_events', areas: ['current_events', 'historical_context'], latencyClass: 'delayed', defaultTtlSeconds: 21600,
    async run(input: ProviderInput, signal: AbortSignal) {
      const query = input.queries.find((q) => q.providerId === 'gdelt_events')?.query ?? input.region.name;
      const url = buildGdeltEventsUrl(query);
      let res: Response;
      try { res = await runFetch(url, { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'GDELT events unexpected content type');
      const data = (await res.json()) as GdeltEventsFixture;
      if (!Array.isArray(data.events)) throw new ProviderHttpError(502, undefined, 'GDELT events envelope missing events');
      return { items: parseGdeltEventsResponse(data, input, new Date()), coverage: ['current_events'] };
    },
  };
}
