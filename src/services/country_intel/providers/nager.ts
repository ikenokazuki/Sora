import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
import type { CalendarEvent } from '../types.js';

export interface NagerHoliday { date?: string; localName?: string; name?: string; countryCode?: string; fixed?: boolean; global?: boolean; counties?: string[] | null; launchYear?: number | null; types?: string[]; }
export function buildNagerUrl(year: number, countryCode: string): string {
  return 'https://date.nager.at/api/v3/publicholidays/' + String(year) + '/' + encodeURIComponent(countryCode);
}
export interface NagerParsed { calendar: CalendarEvent; detail: EvidenceDetail; }
export function parseNagerDetails(fixture: NagerHoliday[], input: ProviderInput, now = new Date()): NagerParsed[] {
  return (fixture ?? []).flatMap((h, index) => {
    if (!h.date) return [];
    const id = 'nager:' + (h.countryCode ?? input.region.countryCode ?? 'unknown') + ':' + h.date;
    const title = h.localName ?? h.name ?? 'Public holiday';
    const calendar: CalendarEvent = {
      id, date: h.date, title, type: 'public_holiday', official: true,
      relatedCountries: input.region.countryCode ? [input.region.countryCode] : undefined,
      sourceUrl: 'https://date.nager.at/',
    };
    const detail: EvidenceDetail = {
      evidenceId: id, providerId: 'nager', providerItemId: id, sourceRecordUrl: 'https://date.nager.at/',
      contentKind: 'structured_record',
      blocks: [{ index, text: title + ' (' + h.date + ')' }],
      structuredData: { localName: h.localName, name: h.name, types: h.types, global: h.global, counties: h.counties, countryCode: h.countryCode ?? input.region.countryCode },
      publishedAt: h.date, retrievedAt: now.toISOString(),
      timeBasis: 'provider_calendar', geographyBasis: 'request_region',
      sourceStatus: 'unverified', contentTruncated: false,
    };
    return [{ calendar, detail }];
  });
}
export function parseNagerResponse(fixture: NagerHoliday[], input: ProviderInput): AcquisitionItem[] {
  return parseNagerDetails(fixture, input).map(({ calendar, detail }) => ({ calendar, detail }));
}
export function createNagerProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'nager', areas: ['calendar', 'holidays'], latencyClass: 'delayed', defaultTtlSeconds: 86400,
    async run(input: ProviderInput, signal: AbortSignal) {
      const cc = input.region.countryCode;
      if (!cc) {
        return { items: [], coverage: ['calendar'], status: 'unavailable' as const, errorCode: 'PROVIDER_REGION_UNSUPPORTED' };
      }
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
