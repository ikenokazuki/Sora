import { normalizeEvidence } from '../evidence.js';
import { inferCountryCodesFromText } from '../place_country.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

export interface UsgsProperties { mag?: number | null; place?: string; time?: number; updated?: number; url?: string; detail?: string; tsunami?: number; status?: string; type?: string; }
export interface UsgsFeature { id?: string; properties?: UsgsProperties; geometry?: { coordinates?: number[] }; }
export interface UsgsFixture { metadata?: { generated?: number }; features?: UsgsFeature[]; }

const asIso = (value: number | undefined): string | undefined => (typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined);

export function parseUsgsResponse(fixture: UsgsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.features ?? []).flatMap((feature, index) => {
    const p = feature.properties ?? {};
    const recordUrl = typeof p.url === 'string' && p.url ? p.url : (feature.id ? 'https://earthquake.usgs.gov/earthquakes/eventpage/' + feature.id : undefined);
    if (!recordUrl) return [];
    const occurredAt = asIso(p.time);
    const coordinates = feature.geometry?.coordinates;
    const place = p.place ?? 'unknown location';
    const eventType = typeof p.type === 'string' && p.type.trim() ? p.type.trim() : 'seismic event';
    const title = 'M' + String(p.mag ?? '?') + ' - ' + place;
    const excerpt = [eventType, 'magnitude', String(p.mag ?? 'unknown'), 'depth', String(coordinates?.[2] ?? 'unknown') + 'km', place, occurredAt ?? ''].join(' ').trim();
    const codes = inferCountryCodesFromText(place);
    const evidence = normalizeEvidence({ url: recordUrl, title, excerpt, publisher: 'USGS', ...(codes.length === 1 ? { eventCountry: codes[0] } : {}), ...(codes.length > 0 ? { mentionedCountries: codes } : {}), sourceType: 'structured_dataset', publishedAt: occurredAt, primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
    const detail: EvidenceDetail = {
      evidenceId: evidence.id,
      providerId: 'usgs',
      providerItemId: feature.id ?? 'usgs-' + String(index),
      sourceRecordUrl: recordUrl,
      contentKind: 'structured_record',
      blocks: [{ index, text: excerpt }],
      structuredData: { mag: p.mag, place: p.place, longitude: coordinates?.[0], latitude: coordinates?.[1], depthKm: coordinates?.[2], tsunami: p.tsunami, status: p.status, eventType: p.type },
      occurredAt,
      publishedAt: occurredAt,
      updatedAt: asIso(p.updated),
      retrievedAt: now.toISOString(),
      timeBasis: 'provider_observation',
      geographyBasis: 'coordinates_only',
      sourceStatus: 'unverified',
      contentTruncated: false,
    };
    return [{ evidence, detail }];
  });
}

export function createUsgsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'usgs', areas: ['disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 300,
    async run(input: ProviderInput, signal: AbortSignal) {
      let res: Response;
      try {
        res = await fetchProviderResponse(USGS_FEED_URL, { sourceId: 'usgs', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'USGS unexpected content type');
      const data = (await res.json()) as UsgsFixture;
      if (!Array.isArray(data.features)) throw new ProviderHttpError(502, undefined, 'USGS envelope missing features');
      return { items: parseUsgsResponse(data, input, new Date()), coverage: ['disasters'] };
    },
  };
}
