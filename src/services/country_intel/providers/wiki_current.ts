import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
export const WIKI_CURRENT_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_CURRENT_MAX_ITEMS = 10;
export function currentEventsPageFor(date: Date): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return 'Portal:Current events/' + String(date.getUTCFullYear()) + ' ' + months[date.getUTCMonth()] + ' ' + String(date.getUTCDate());
}
export function regionMatchKeys(region: ProviderInput['region']): string[] {
  const keys = [region.name, region.nativeName, region.countryCode, ...(region.aliases ?? [])];
  return keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
}
function stripMarkup(text: string): string {
  return text.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/'''?/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
/** wikitext箇条書きから地域言及行だけ抽出。本文・辞書ハードコードなし。 */
export function extractRegionBullets(wikitext: string, region: ProviderInput['region']): string[] {
  const keys = regionMatchKeys(region).map((k) => k.toLowerCase());
  if (!keys.length) return [];
  const out: string[] = [];
  for (const line of wikitext.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('*') || trimmed.startsWith('**')) continue;
    const text = stripMarkup(trimmed.replace(/^\*+\s*/, ''));
    if (!text) continue;
    const lower = text.toLowerCase();
    if (keys.some((k) => lower.includes(k))) out.push(text);
    if (out.length >= WIKI_CURRENT_MAX_ITEMS) break;
  }
  return out;
}
export function createWikiCurrentProvider(fetchFn?: GdeltFetch, now?: Date): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'wiki_current', areas: ['current_events', 'humanitarian'], latencyClass: 'delayed', defaultTtlSeconds: 3600,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal) {
      const page = currentEventsPageFor(now ?? new Date());
      const params = new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json' });
      let res: Response;
      try {
        res = await fetchProviderResponse(WIKI_CURRENT_API + '?' + params.toString(), { sourceId: 'wiki_current', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const data = (await res.json()) as { parse?: { wikitext?: { '*': string } } };
      const wikitext = data.parse?.wikitext?.['*'];
      if (typeof wikitext !== 'string') throw new ProviderHttpError(502, undefined, 'Wikipedia current events envelope unexpected');
      const bullets = extractRegionBullets(wikitext, input.region);
      const at = new Date().toISOString();
      const pageUrl = 'https://en.wikipedia.org/wiki/' + page.replace(/ /g, '_');
      const items: AcquisitionItem[] = bullets.map((text, index) => {
        const evidence = normalizeEvidence({ url: pageUrl, title: text.slice(0, 200), excerpt: text.slice(0, 2000), publisher: 'Wikipedia Current Events', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'delayed' }, input.region, new Date());
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'wiki_current', providerItemId: page + '#' + String(index), sourceRecordUrl: pageUrl, contentKind: 'excerpt', blocks: [{ index, text: text.slice(0, 2000) }], structuredData: { page }, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'mention_only', sourceStatus: 'unverified', contentTruncated: text.length > 2000 };
        return { evidence, detail, areas: ['current_events'] as readonly string[] };
      });
      return { items, coverage: ['current_events'] };
    },
  };
}
