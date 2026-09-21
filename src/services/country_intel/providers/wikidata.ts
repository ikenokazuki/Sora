import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';

export interface WikidataSearchItem { id?: string; label?: string; description?: string; url?: string; }
export interface WikidataFixture { search?: WikidataSearchItem[]; }
export function buildWikidataUrl(query: string): string {
  const params = new URLSearchParams({ action: 'wbsearchentities', search: query, language: 'en', format: 'json', limit: '10' });
  return `https://www.wikidata.org/w/api.php?${params.toString()}`;
}
function domainOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return undefined; }
}

function isWikidataEntityUrl(url: string): boolean {
  try {
    const parsed = new URL(url.includes('://') ? url : `https:${url}`);
    return parsed.hostname.toLowerCase().endsWith('wikidata.org')
      && /^\/wiki\//i.test(parsed.pathname);
  } catch { return false; }
}

export function parseWikidataResponse(fixture: WikidataFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  // v1: entity identification のみ。entity ページを official source として扱わない。
  // entity 以外のドメインも official とは断定せず、種別未確定の candidate に留める。
  return (fixture.search ?? []).flatMap((s) => {
    if (!s.url) return [];
    if (isWikidataEntityUrl(s.url)) return [];
    const domain = domainOf(s.url);
    if (!domain) return [];
    return [{
      source: {
        id: `wikidata:${s.id ?? domain}`, regionId: input.region.id, domain,
        sourceType: 'other', discoveredAt: now.toISOString(),
        verificationStatus: 'candidate' as const, discoveryMethod: 'wikidata' as const,
      },
    }];
  });
}
export function createWikidataProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'wikidata', areas: ['source_discovery'], latencyClass: 'delayed', defaultTtlSeconds: 86400,
    async run(input: ProviderInput, signal: AbortSignal) {
      const url = buildWikidataUrl(input.region.name);
      let res: Response;
      try { res = await runFetch(url, { signal }); }
      catch (e) { if (signal.aborted) throw e; throw new ProviderNetworkError(String(e)); }
      if (!res.ok) throw new ProviderHttpError(res.status);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'Wikidata unexpected content type');
      const data = (await res.json()) as WikidataFixture;
      if (!Array.isArray(data.search)) throw new ProviderHttpError(502, undefined, 'Wikidata envelope missing search');
      return { items: parseWikidataResponse(data, input, new Date()), coverage: ['source_discovery'] };
    },
  };
}
