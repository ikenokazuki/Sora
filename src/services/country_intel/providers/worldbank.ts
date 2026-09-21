import { iso2ToIso3 } from '../geo_codes.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export type WorldBankFixture = [unknown, { indicator?: { id?: string }; countryiso3code?: string; date?: string; value?: number | null }[]];

export function buildWorldBankUrl(countryCode: string, indicator = 'NY.GDP.MKTP.CD'): string {
  const params = new URLSearchParams({ format: 'json', per_page: '20', date: '2015:2025' });
  return `https://api.worldbank.org/v2/country/${encodeURIComponent(countryCode)}/indicator/${encodeURIComponent(indicator)}?${params.toString()}`;
}

export function parseWorldBankResponse(fixture: WorldBankFixture, input: ProviderInput): AcquisitionItem[] {
  const rows = Array.isArray(fixture) && Array.isArray(fixture[1]) ? fixture[1] : [];
  const latest = rows.find((r) => r.value !== null && r.value !== undefined);
  if (!latest?.date || latest.value === null || latest.value === undefined) return [];
  return [{ metric: { key: `worldbank:${latest.indicator?.id ?? 'NY.GDP.MKTP.CD'}`, current: latest.value, window: 'yearly', direction: 'unknown' as const } }];
}

export function createWorldBankProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'worldbank', areas: ['economy', 'historical_context'], latencyClass: 'historical', defaultTtlSeconds: 86400,
    async run(input: ProviderInput, signal: AbortSignal) {
      const iso3 = input.region.countryCode ? iso2ToIso3(input.region.countryCode) : undefined;
      if (!iso3) {
        return { items: [], coverage: ['economy'], status: 'unavailable' as const, errorCode: 'PROVIDER_REGION_UNSUPPORTED' };
      }
      const cc = iso3;
      const url = buildWorldBankUrl(cc);
      let res: Response;
      try { res = await runFetch(url, { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'WorldBank unexpected content type');
      const data = (await res.json()) as WorldBankFixture;
      if (!Array.isArray(data) || !Array.isArray(data[1])) throw new ProviderHttpError(502, undefined, 'WorldBank envelope missing observations');
      return { items: parseWorldBankResponse(data, input), coverage: ['economy'] };
    },
  };
}
