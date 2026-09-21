import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export interface GdacsProperties { eventid?: string; eventtype?: string; severity?: string; fromdate?: string; todate?: string; country?: string; url?: string; title?: string; }
export interface GdacsFixture { features?: { properties?: GdacsProperties }[]; }

export function buildGdacsUrl(): string { return 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=TC,FL,EQ,VO,DR,WF'; }

export function parseGdacsResponse(fixture: GdacsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.features ?? []).filter((f) => f.properties?.url).map((feature) => {
    const p = feature.properties!;
    return {
      evidence: normalizeEvidence({
        url: p.url!, title: p.title ?? `GDACS ${p.eventtype ?? 'event'} ${p.eventid ?? ''}`.trim(),
        eventCountry: p.country || undefined,
        mentionedCountries: p.country ? [p.country] : undefined,
        sourceType: 'structured_dataset', publishedAt: p.fromdate,
        excerpt: `${p.eventtype ?? 'event'} severity ${p.severity ?? 'unknown'} ${p.fromdate ?? ''} to ${p.todate ?? ''}`.trim(),
        primarySource: false, latencyClass: 'near_realtime',
      }, input.region, now),
    };
  });
}

export function createGdacsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'gdacs', areas: ['disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 1800,
    async run(input: ProviderInput, signal: AbortSignal) {
      let res: Response;
      try { res = await runFetch(buildGdacsUrl(), { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'GDACS unexpected content type');
      const data = (await res.json()) as GdacsFixture;
      if (!Array.isArray(data.features)) throw new ProviderHttpError(502, undefined, 'GDACS envelope missing features');
      return { items: parseGdacsResponse(data, input, new Date()), coverage: ['disasters'] };
    },
  };
}
