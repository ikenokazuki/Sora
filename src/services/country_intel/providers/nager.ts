import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export interface NagerHoliday { date?: string; localName?: string; name?: string; countryCode?: string; }
export function buildNagerUrl(year: number, countryCode: string): string {
  return `https://date.nager.at/api/v3/publicholidays/${year}/${encodeURIComponent(countryCode)}`;
}
export function parseNagerResponse(fixture: NagerHoliday[], input: ProviderInput): AcquisitionItem[] {
  return (fixture ?? []).filter((h) => h.date).map((h) => ({
    calendar: {
      id: `nager:${h.countryCode ?? input.region.countryCode ?? 'unknown'}:${h.date}`,
      date: h.date!, title: h.localName ?? h.name ?? 'Public holiday',
      type: 'public_holiday' as const, official: true,
      relatedCountries: input.region.countryCode ? [input.region.countryCode] : undefined,
      sourceUrl: 'https://date.nager.at/',
    },
  }));
}
export function createNagerProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'nager', areas: ['calendar', 'holidays'], latencyClass: 'delayed', defaultTtlSeconds: 86400,
    async run(input: ProviderInput, signal: AbortSignal) {
      const cc = input.region.countryCode ?? 'KR';
      const year = new Date().getUTCFullYear();
      let res: Response;
      try { res = await runFetch(buildNagerUrl(year, cc), { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'Nager unexpected content type');
      const data = (await res.json()) as NagerHoliday[];
      if (!Array.isArray(data)) throw new ProviderHttpError(502, undefined, 'Nager envelope missing holidays');
      return { items: parseNagerResponse(data, input), coverage: ['calendar'] };
    },
  };
}
