import { iso2ToIso3 } from '../geo_codes.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
import type { TemporalMetric } from '../types.js';

export interface WorldBankIndicator { id: string; label: string; unit: string; }

export const WORLD_BANK_INDICATORS: readonly WorldBankIndicator[] = [
  { id: 'NY.GDP.MKTP.CD', label: 'GDP nominal', unit: 'USD' },
  { id: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth', unit: '%' },
  { id: 'FP.CPI.TOTL.ZG', label: 'Inflation CPI', unit: '%' },
  { id: 'SL.UEM.TOTL.ZS', label: 'Unemployment', unit: '%' },
  { id: 'SP.POP.TOTL', label: 'Population', unit: 'persons' },
  { id: 'NE.TRD.GNFS.ZS', label: 'Trade share of GDP', unit: '%' },
];

export type WorldBankFixture = [unknown, { indicator?: { id?: string }; countryiso3code?: string; date?: string; value?: number | null }[]];

export function buildWorldBankUrl(countryCode: string, indicator = 'NY.GDP.MKTP.CD', fromYear?: number, toYear?: number): string {
  const to = toYear ?? new Date().getUTCFullYear();
  const from = fromYear ?? to - 10;
  const params = new URLSearchParams({ format: 'json', per_page: '20', date: from + ':' + to });
  return 'https://api.worldbank.org/v2/country/' + encodeURIComponent(countryCode) + '/indicator/' + encodeURIComponent(indicator) + '?' + params.toString();
}

export interface WorldBankSeriesPoint { date: string; value: number; }

export function parseWorldBankResponse(fixture: WorldBankFixture, input: ProviderInput): AcquisitionItem[] {
  const parsed = parseWorldBankIndicator(fixture, WORLD_BANK_INDICATORS[0], buildWorldBankUrl('XXX'), input);
  return parsed ? [{ metric: parsed.metric }] : [];
}

export function parseWorldBankIndicator(fixture: WorldBankFixture, indicator: WorldBankIndicator, sourceUrl: string, input: ProviderInput, now = new Date()): { metric: TemporalMetric; detail: EvidenceDetail } | undefined {
  const rows = Array.isArray(fixture) && Array.isArray(fixture[1]) ? fixture[1] : [];
  const points: WorldBankSeriesPoint[] = rows
    .filter((r) => r.date && typeof r.value === 'number')
    .map((r) => ({ date: r.date as string, value: r.value as number }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = points[0];
  if (!latest) return undefined;
  const previous = points[1];
  const metric: TemporalMetric = {
    key: 'worldbank:' + indicator.id, current: latest.value, window: 'yearly',
    direction: previous ? (latest.value > previous.value ? 'rising' : latest.value < previous.value ? 'falling' : 'stable') : 'unknown',
  };
  const evidenceId = 'wb:' + (input.region.countryCode ?? 'unknown') + ':' + indicator.id;
  const detail: EvidenceDetail = {
    evidenceId, providerId: 'worldbank', providerItemId: indicator.id, sourceRecordUrl: sourceUrl,
    contentKind: 'structured_record',
    blocks: [{ index: 0, text: indicator.label + ' ' + String(latest.value) + ' ' + indicator.unit + ' (' + latest.date + ')' }],
    structuredData: { indicator: indicator.id, label: indicator.label, unit: indicator.unit, sourceUrl, observations: points },
    publishedAt: latest.date, retrievedAt: now.toISOString(),
    timeBasis: 'provider_statistical_year', geographyBasis: 'request_region',
    sourceStatus: 'unverified', contentTruncated: false,
  };
  return { metric, detail };
}

export function createWorldBankProvider(fetchFn?: GdeltFetch, indicators: readonly WorldBankIndicator[] = WORLD_BANK_INDICATORS): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'worldbank', areas: ['economy', 'historical_context'], latencyClass: 'historical', defaultTtlSeconds: 86400,
    collectionWindowDays: 3650,
    async run(input: ProviderInput, signal: AbortSignal) {
      const iso3 = input.region.countryCode ? iso2ToIso3(input.region.countryCode) : undefined;
      if (!iso3) {
        return { items: [], coverage: ['economy'], status: 'unavailable' as const, errorCode: 'PROVIDER_REGION_UNSUPPORTED' };
      }
      const items: AcquisitionItem[] = [];
      let failures = 0;
      let lastError: unknown;
      for (const indicator of indicators) {
        if (signal.aborted) throw signal.reason;
        const url = buildWorldBankUrl(iso3, indicator.id);
        try {
          const res = await runFetch(url, { signal });
          if (!res.ok) throw new ProviderHttpError(res.status);
          if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'WorldBank unexpected content type');
          const data = (await res.json()) as WorldBankFixture;
          if (!Array.isArray(data) || !Array.isArray(data[1])) throw new ProviderHttpError(502, undefined, 'WorldBank envelope missing observations');
          const parsed = parseWorldBankIndicator(data, indicator, url, input, new Date());
          if (parsed) items.push({ metric: parsed.metric, detail: parsed.detail });
        } catch (e) {
          if (signal.aborted) throw e;
          failures += 1;
          lastError = e;
        }
      }
      if (items.length === 0 && failures > 0) {
        if (lastError instanceof ProviderHttpError || lastError instanceof ProviderNetworkError) throw lastError;
        throw new ProviderNetworkError(String(lastError));
      }
      return { items, coverage: ['economy'], ...(failures > 0 ? { status: 'partial' as const } : {}) };
    },
  };
}
