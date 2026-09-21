import { normalizeProviderCountryCode } from '../geo_codes.js';
import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export interface GdacsProperties { eventid?: string; eventtype?: string; severity?: string; fromdate?: string; todate?: string; country?: string; url?: string; title?: string; }
export interface GdacsFixture { features?: { properties?: GdacsProperties }[]; }

export function buildGdacsUrl(): string { return 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=TC,FL,EQ,VO,DR,WF'; }

/** GDACS の country 表記を要求 region と照合する。解決不能・不一致は除外する。 */
function belongsToRegion(country: string | undefined, input: ProviderInput): string | undefined {
  if (!country) return undefined;
  const code = normalizeProviderCountryCode('gdacs', country);
  if (code) return input.region.countryCode === code ? code : undefined;
  const wanted = country.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const names = [input.region.name, ...(input.region.aliases ?? [])]
    .map((name) => name.normalize('NFKC').trim().toLocaleLowerCase('en-US'));
  return names.includes(wanted) ? input.region.countryCode : undefined;
}

export function parseGdacsResponse(fixture: GdacsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.features ?? []).flatMap((feature) => {
    if (!feature.properties?.url) return [];
    const eventCountry = belongsToRegion(feature.properties.country, input);
    // Unknown geography は要求 region へ自動帰属させない。
    if (!eventCountry) return [];
    const p = feature.properties!;
    return [{
      evidence: normalizeEvidence({
        url: p.url!, title: p.title ?? `GDACS ${p.eventtype ?? 'event'} ${p.eventid ?? ''}`.trim(),
        eventCountry,
        mentionedCountries: [eventCountry],
        sourceType: 'structured_dataset', publishedAt: p.fromdate,
        excerpt: `${p.eventtype ?? 'event'} severity ${p.severity ?? 'unknown'} ${p.fromdate ?? ''} to ${p.todate ?? ''}`.trim(),
        primarySource: false, latencyClass: 'near_realtime',
      }, input.region, now),
    }];
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
