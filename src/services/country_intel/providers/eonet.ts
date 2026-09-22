import { normalizeEvidence } from '../evidence.js';
import { inferCountryCodesFromText } from '../place_country.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export function buildEonetUrl(limit = 50, days = 30): string {
  return 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=' + String(limit) + '&days=' + String(days);
}

export interface EonetGeometry { date?: string; coordinates?: number[]; }
export interface EonetEvent { id?: string; title?: string; description?: string; link?: string; categories?: { title?: string }[]; sources?: { url?: string }[]; geometry?: EonetGeometry[]; }
export interface EonetFixture { events?: EonetEvent[]; }

export function parseEonetResponse(fixture: EonetFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.events ?? []).flatMap((event, index) => {
    const url = event.link ?? event.sources?.[0]?.url;
    if (!event.id || !url) return [];
    const dates = (event.geometry ?? []).map((g) => g.date).filter((d): d is string => typeof d === 'string');
    const title = event.title ?? 'EONET event ' + event.id;
    const categories = (event.categories ?? []).map((c) => c.title).filter((c): c is string => typeof c === 'string' && c.length > 0);
    const excerpt = [title, categories.join(' '), event.description ?? '', dates[0] ?? ''].join(' ').trim().slice(0, 2000);
    const codes = inferCountryCodesFromText([title, event.description ?? ''].join(' '));
    const evidence = normalizeEvidence({ url, title, excerpt, publisher: 'NASA EONET', ...(codes.length === 1 ? { eventCountry: codes[0] } : {}), ...(codes.length > 0 ? { mentionedCountries: codes } : {}), sourceType: 'structured_dataset', publishedAt: dates[0], primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
    const detail: EvidenceDetail = {
      evidenceId: evidence.id,
      providerId: 'eonet',
      providerItemId: event.id,
      sourceRecordUrl: url,
      contentKind: 'structured_record',
      blocks: [{ index, text: excerpt }],
      structuredData: { categories, sources: (event.sources ?? []).map((s) => s.url), geometryDates: dates, coordinates: event.geometry?.[0]?.coordinates },
      occurredAt: dates[0],
      publishedAt: dates[0],
      retrievedAt: now.toISOString(),
      timeBasis: 'provider_geometry_observation',
      geographyBasis: 'coordinates_only',
      sourceStatus: 'unverified',
      contentTruncated: false,
    };
    return [{ evidence, detail }];
  });
}

export function createEonetProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'eonet', areas: ['disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    async run(input: ProviderInput, signal: AbortSignal) {
      let res: Response;
      try {
        res = await fetchProviderResponse(buildEonetUrl(), { sourceId: 'eonet', timeoutMs: 10000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const text = await res.text();
      let data: EonetFixture;
      try {
        data = JSON.parse(text) as EonetFixture;
      } catch {
        throw new ProviderHttpError(502, undefined, 'EONET unexpected content type');
      }
      if (!Array.isArray(data.events)) throw new ProviderHttpError(502, undefined, 'EONET envelope missing events');
      return { items: parseEonetResponse(data, input, new Date()), coverage: ['disasters'] };
    },
  };
}
