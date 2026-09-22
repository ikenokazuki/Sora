import { XMLParser } from 'fast-xml-parser';
import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
import { GLOBAL_FEED_CATALOG, type SourceCatalogEntry } from '../source_catalog.js';

export interface FeedEntry { title?: string; link?: string; description?: string; publishedAt?: string; language?: string; guid?: string; }

function entryLink(link: unknown): string | undefined {
  if (typeof link === 'string') return link || undefined;
  if (Array.isArray(link)) {
    for (const item of link) {
      const found = entryLink(item);
      if (found) return found;
    }
    return undefined;
  }
  if (link && typeof link === 'object') {
    const record = link as Record<string, unknown>;
    if (typeof record['@_href'] === 'string' && record['@_href']) return record['@_href'] as string;
    if (typeof record['#text'] === 'string' && record['#text']) return record['#text'] as string;
  }
  return undefined;
}

function entryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim() || undefined;
  }
  return undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseFeed(xml: string, sourceId: string): FeedEntry[] {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  void sourceId;
  const rss = parsed['rss'] as Record<string, unknown> | undefined;
  const channel = rss?.['channel'] as Record<string, unknown> | undefined;
  if (channel) {
    const language = entryText(channel['language']);
    return asArray(channel['item'] as Record<string, unknown> | Array<Record<string, unknown>>).map((item) => ({
      title: entryText(item['title']),
      link: entryLink(item['link']),
      description: entryText(item['description']) ?? entryText(item['content:encoded']),
      publishedAt: entryText(item['pubDate']) ?? entryText(item['dc:date']) ?? entryText(item['updated']),
      guid: entryText(item['guid']),
      language,
    }));
  }
  const feed = parsed['feed'] as Record<string, unknown> | undefined;
  if (feed) {
    return asArray(feed['entry'] as Record<string, unknown> | Array<Record<string, unknown>>).map((item) => ({
      title: entryText(item['title']),
      link: entryLink(item['link']),
      description: entryText(item['summary']) ?? entryText(item['content']),
      publishedAt: entryText(item['published']) ?? entryText(item['updated']),
      guid: entryText(item['id']),
      language: undefined,
    }));
  }
  const rdf = parsed['rdf:RDF'] as Record<string, unknown> | undefined;
  if (rdf) {
    return asArray(rdf['item'] as Record<string, unknown> | Array<Record<string, unknown>>).map((item) => ({
      title: entryText(item['title']),
      link: entryLink(item['link']),
      description: entryText(item['description']),
      publishedAt: entryText(item['dc:date']),
      guid: entryText(item['link']),
      language: undefined,
    }));
  }
  return [];
}

export function feedEntriesToAcquisition(entries: FeedEntry[], entry: SourceCatalogEntry, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return entries.flatMap((item, index) => {
    if (!item.link) return [];
    const title = item.title ?? item.link;
    const excerpt = item.description?.slice(0, 2000);
    const evidence = normalizeEvidence({
      url: item.link, title, excerpt, publisher: entry.publisher,
      sourceType: entry.sourceType, language: item.language, publishedAt: item.publishedAt,
      primarySource: entry.sourceType === 'official', latencyClass: 'near_realtime',
    }, input.region, now);
    const detail: EvidenceDetail = {
      evidenceId: evidence.id,
      providerId: entry.id,
      providerItemId: item.guid ?? item.link,
      sourceRecordUrl: item.link,
      contentKind: 'excerpt',
      ...(item.language ? { language: item.language } : {}),
      blocks: excerpt ? [{ index, text: excerpt }] : [],
      structuredData: { publisher: entry.publisher },
      publishedAt: item.publishedAt,
      retrievedAt: now.toISOString(),
      timeBasis: 'provider_publication',
      geographyBasis: 'unknown',
      sourceStatus: 'unverified',
      contentTruncated: (item.description?.length ?? 0) > 2000,
    };
    return [{ evidence, detail, areas: [entry.areas[0] ?? 'media_activity'] }];
  });
}

/** 地域に合うフィード選択。共通＋対象国一致、上限6。 */
export function selectFeedsForRegion(catalog: readonly SourceCatalogEntry[], countryCode: string | undefined, limit = 6): SourceCatalogEntry[] {
  const matched = catalog.filter((entry) => !(entry.countryCodes?.length) || (countryCode && entry.countryCodes.includes(countryCode)));
  return matched.slice(0, limit);
}

export function createGlobalFeedsProvider(fetchFn?: GdeltFetch, catalog: readonly SourceCatalogEntry[] = GLOBAL_FEED_CATALOG): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'global_feeds', areas: ['media_activity', 'current_events', 'humanitarian', 'economy'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal) {
      const all: AcquisitionItem[] = [];
      const now = new Date();
      const feeds = selectFeedsForRegion(catalog, input.region?.countryCode);
      for (const entry of feeds) {
        let res: Response;
        try {
          res = await fetchProviderResponse(entry.url, { sourceId: entry.id, timeoutMs: 10000, format: 'xml', signal, fetchFn: runFetch });
        } catch (e) {
          if (signal.aborted) throw e;
          if (e instanceof ProviderHttpError) throw e;
          throw new ProviderNetworkError(String(e));
        }
        const xml = await res.text();
        all.push(...feedEntriesToAcquisition(parseFeed(xml, entry.id), entry, input, now));
        if (signal.aborted) throw signal.reason;
      }
      return { items: all, coverage: ['media_activity'] };
    },
  };
}
