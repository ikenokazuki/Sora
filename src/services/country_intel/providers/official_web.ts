import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';

export interface WebSearchItem { url: string; title?: string; snippet?: string; domain?: string; publishedAt?: string; }
export interface OfficialWebDeps {
  searchYahooWeb: (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]>;
  scrapeUrl: (url: string, signal: AbortSignal) => Promise<{ markdown?: string; title?: string }>;
  verifiedDomains?: readonly string[];
}
function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return undefined; }
}
function isOfficialHost(host?: string): boolean {
  if (!host) return false;
  return host.endsWith('.go.jp') || host.endsWith('.go.kr') || host.endsWith('.gov') || host.endsWith('.gouv.fr') || host.endsWith('.gov.tw') || host.endsWith('.go.id') || host.includes('mofa.go');
}
export function classifyWebItem(item: WebSearchItem, verifiedDomains: readonly string[] = []): 'official_evidence' | 'official_candidate' | 'media' {
  const host = hostOf(item.url) ?? item.domain?.toLowerCase();
  if (!host) return 'media';
  const verified = new Set(verifiedDomains.map((d) => d.toLowerCase().replace(/^www\./, '')));
  if (verified.has(host)) return 'official_evidence';
  if (isOfficialHost(host)) return 'official_candidate';
  return 'media';
}
export function webItemsToAcquisition(items: WebSearchItem[], input: ProviderInput, verifiedDomains: readonly string[] = [], now = new Date()): AcquisitionItem[] {
  const out: AcquisitionItem[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const kind = classifyWebItem(item, verifiedDomains);
    if (kind === 'official_candidate') {
      out.push({ source: { id: `web:${hostOf(item.url)}`, regionId: input.region.id, domain: hostOf(item.url)!, sourceType: 'official', discoveredAt: now.toISOString(), verificationStatus: 'candidate', discoveryMethod: 'search' } });
    } else {
      out.push({ evidence: normalizeEvidence({ url: item.url, title: item.title, excerpt: item.snippet, publisher: item.domain ?? hostOf(item.url), sourceType: kind === 'official_evidence' ? 'official' : 'international_media', publishedAt: item.publishedAt, primarySource: kind === 'official_evidence', latencyClass: 'near_realtime' }, input.region, now) });
    }
  }
  return out;
}
export function createOfficialWebProvider(deps: OfficialWebDeps): CountryIntelProvider {
  return {
    id: 'official_web', areas: ['official', 'media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 3600,
    async run(input: ProviderInput, signal: AbortSignal) {
      const queries = input.queries.filter((q) => q.providerId === 'official_web').slice(0, 12);
      const all: AcquisitionItem[] = [];
      try {
        for (const q of queries.length ? queries : [{ pass: 1 as const, providerId: 'official_web', query: input.region.name, topics: [], maxItems: 10 }]) {
          const items = await deps.searchYahooWeb(q.query, Math.min(q.maxItems, 20), signal);
          all.push(...webItemsToAcquisition(items, input, deps.verifiedDomains, new Date()));
          if (signal.aborted) throw signal.reason;
        }
        const pass2Official = input.queries.filter((q) => q.pass === 2 && q.sourceDomain && q.providerId === 'official_web').slice(0, 8);
        for (const q of pass2Official) {
          try {
            const scraped = await deps.scrapeUrl(`https://${q.sourceDomain}/`, signal);
            if (scraped.markdown) all.push({ evidence: normalizeEvidence({ url: `https://${q.sourceDomain}/`, title: scraped.title, excerpt: scraped.markdown.slice(0, 2000), publisher: q.sourceDomain, sourceType: 'official', primarySource: true, latencyClass: 'near_realtime' }, input.region, new Date()) });
          } catch { /* per-URL scrape failure never fails provider */ }
        }
      } catch (e) {
        if (e instanceof ProviderHttpError || e instanceof ProviderNetworkError) throw e;
        if (signal.aborted) throw e;
        throw new ProviderNetworkError(String(e));
      }
      return { items: all, coverage: ['official'] };
    },
  };
}
