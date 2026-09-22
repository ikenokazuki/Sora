import { XMLParser } from 'fast-xml-parser';
import { normalizeProviderCountryCode } from '../geo_codes.js';
import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export interface GdacsUrlLinks { report?: string; details?: string; geometry?: string; }
export interface GdacsLinkEntry { Key?: string; Value?: string; }
export interface GdacsAffectedCountry { iso2?: string; iso3?: string; countryname?: string; }
export interface GdacsSeverityData { severity?: number | string; severitytext?: string; severityunit?: string; }

export interface GdacsProperties {
  eventid?: string | number;
  episodeid?: string | number;
  eventtype?: string;
  eventname?: string;
  name?: string;
  title?: string;
  description?: string;
  htmldescription?: string;
  alertlevel?: string;
  severity?: string | number;
  severitydata?: GdacsSeverityData;
  fromdate?: string;
  todate?: string;
  datemodified?: string;
  country?: string;
  iso3?: string;
  url?: string | GdacsUrlLinks | GdacsLinkEntry[];
  link?: GdacsLinkEntry[];
  affectedcountries?: GdacsAffectedCountry[];
}

export interface GdacsFixture { features?: { properties?: GdacsProperties; geometry?: unknown }[]; }

export function buildGdacsUrl(): string { return 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=TC,FL,EQ,VO,DR,WF'; }

export const GDACS_RSS_URL = 'https://www.gdacs.org/xml/rss.xml';

function linkValue(links: GdacsLinkEntry[] | undefined, keys: readonly string[]): string | undefined {
  if (!Array.isArray(links)) return undefined;
  for (const key of keys) {
    const found = links.find((entry) => entry.Key === key);
    if (found?.Value) return found.Value;
  }
  return undefined;
}

export function resolveGdacsUrl(p: GdacsProperties): string | undefined {
  if (typeof p.url === 'string' && p.url.length > 0) return p.url;
  if (p.url && typeof p.url === 'object' && !Array.isArray(p.url)) {
    if (p.url.report) return p.url.report;
    if (p.url.details) return p.url.details;
    if (p.url.geometry) return p.url.geometry;
  }
  if (Array.isArray(p.url)) {
    const fromUrl = linkValue(p.url, ['web', 'report', 'details']);
    if (fromUrl) return fromUrl;
  }
  return linkValue(p.link, ['web', 'report', 'details']);
}

function regionNames(input: ProviderInput): string[] {
  return [input.region.name, ...(input.region.aliases ?? [])].map((name) => name.normalize('NFKC').trim().toLocaleLowerCase('en-US'));
}

function matchName(country: string | undefined, input: ProviderInput): string | undefined {
  if (!country) return undefined;
  const wanted = country.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return regionNames(input).includes(wanted) ? input.region.countryCode : undefined;
}

export function matchGdacsRegion(p: GdacsProperties, input: ProviderInput): string[] {
  const matched = new Set<string>();
  const wanted = input.region.countryCode;
  if (!wanted) return [];
  for (const token of (p.country ?? '').split(',')) {
    const name = token.trim();
    if (!name) continue;
    const code = normalizeProviderCountryCode('gdacs', name) ?? normalizeProviderCountryCode('iso2', name);
    if (code === wanted) matched.add(code);
    else if (!code && matchName(name, input) === wanted) matched.add(wanted);
  }
  for (const entry of p.affectedcountries ?? []) {
    const code = (entry.iso2 && normalizeProviderCountryCode('iso2', entry.iso2)) ?? (entry.iso3 && normalizeProviderCountryCode('gdacs', entry.iso3)) ?? matchName(entry.countryname, input);
    if (code === wanted) matched.add(code);
  }
  return [...matched];
}

export function gdacsRecordKey(p: GdacsProperties): string {
  return [p.eventtype ?? 'unknown', String(p.eventid ?? 'unknown'), String(p.episodeid ?? '')].join(':');
}

function severityText(p: GdacsProperties): string | undefined {
  if (p.severitydata?.severitytext) return p.severitydata.severitytext;
  if (typeof p.severity === 'string' && p.severity.length > 0) return p.severity;
  return p.alertlevel;
}

function toDetail(url: string, title: string, p: GdacsProperties, evidenceId: string, affected: string[], now: Date): EvidenceDetail {
  const text = (p.description ?? p.name ?? title).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return {
    evidenceId,
    providerId: 'gdacs',
    providerItemId: gdacsRecordKey(p),
    sourceRecordUrl: url,
    contentKind: 'structured_record',
    blocks: [{ index: 0, text: text || title }],
    structuredData: {
      eventType: p.eventtype,
      eventId: p.eventid,
      episodeId: p.episodeid,
      alertLevel: p.alertlevel,
      affectedCountryCodes: affected,
      severityText: severityText(p),
      fromdate: p.fromdate,
      todate: p.todate,
    },
    occurredAt: p.fromdate,
    publishedAt: p.fromdate,
    updatedAt: p.datemodified ?? p.todate,
    retrievedAt: now.toISOString(),
    timeBasis: 'provider_event_window',
    geographyBasis: (p.affectedcountries?.length ?? 0) > 0 ? 'provider_affected_countries' : 'provider_country_field',
    sourceStatus: 'unverified',
    contentTruncated: false,
  };
}

export function parseGdacsApi(fixture: GdacsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return (fixture.features ?? []).flatMap((feature) => {
    const p = feature.properties;
    if (!p) return [];
    const url = resolveGdacsUrl(p);
    if (!url) return [];
    const affected = matchGdacsRegion(p, input);
    if (affected.length === 0) return [];
    const eventCountry = affected[0];
    const title = p.title ?? p.name ?? ['GDACS', p.eventtype ?? 'event', String(p.eventid ?? '')].join(' ').trim();
    const evidence = normalizeEvidence({
      url, title,
      eventCountry,
      mentionedCountries: affected,
      sourceType: 'structured_dataset', publishedAt: p.fromdate,
      excerpt: [p.eventtype ?? 'event', severityText(p) ?? 'unknown', p.fromdate ?? '', 'to', p.todate ?? ''].join(' ').trim(),
      primarySource: false, latencyClass: 'near_realtime',
    }, input.region, now);
    return [{ evidence, detail: toDetail(url, title, p, evidence.id, affected, now) }];
  });
}

export function parseGdacsResponse(fixture: GdacsFixture, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return parseGdacsApi(fixture, input, now);
}

export interface GdacsFeedItem { title?: string; link?: string; description?: string; pubDate?: string; eventtype?: string; eventid?: string | number; episodeid?: string | number; country?: string; alertlevel?: string; }

function feedField(entry: Record<string, unknown>, name: string): string | undefined {
  const value = entry['gdacs:' + name] ?? entry[name];
  return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined;
}

export function parseGdacsFeed(xml: string, input: ProviderInput, now = new Date()): AcquisitionItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  let parsed: { rss?: { channel?: { item?: GdacsFeedItem | GdacsFeedItem[] } } };
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }
  const raw = parsed?.rss?.channel?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.flatMap((entry) => {
    const url = typeof entry.link === 'string' ? entry.link : undefined;
    if (!url) return [];
    const record = entry as Record<string, unknown>;
    const text = (name: string): string | undefined => feedField(record, name);
    const title = (typeof entry.title === 'string' ? entry.title : undefined) ?? ['GDACS', text('eventtype') ?? 'event'].join(' ');
    const p: GdacsProperties = { eventtype: text('eventtype'), eventid: text('eventid'), episodeid: text('episodeid'), country: text('country'), alertlevel: text('alertlevel'), title, description: typeof entry.description === 'string' ? entry.description : undefined, fromdate: typeof entry.pubDate === 'string' ? entry.pubDate : undefined, url };
    const affected = matchGdacsRegion(p, input);
    if (affected.length === 0) return [];
    const evidence = normalizeEvidence({ url, title, eventCountry: affected[0], mentionedCountries: affected, sourceType: 'structured_dataset', publishedAt: text('pubDate'), excerpt: typeof entry.description === 'string' ? entry.description : undefined, primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
    return [{ evidence, detail: toDetail(url, title, p, evidence.id, affected, now) }];
  });
}

export function createGdacsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'gdacs', areas: ['disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 1800,
    collectionWindowDays: 30,
    async run(input: ProviderInput, signal: AbortSignal) {
      const apiItems = await fetchGdacsApi(runFetch, signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      });
      if (apiItems) return { items: apiItems.items(input, new Date()), coverage: ['disasters'] };
      // API 失敗時のみ RSS へ一度フォールバックする。成功分は report 側で保持される。
      const rssItems = await fetchGdacsRss(runFetch, signal);
      return { items: rssItems(input, new Date()), coverage: ['disasters'], status: 'partial' as const, errorCode: 'GDACS_API_FALLBACK_RSS' };
    },
  };
}

async function fetchGdacsApi(
  runFetch: GdeltFetch,
  signal: AbortSignal,
): Promise<{ items(input: ProviderInput, now: Date): AcquisitionItem[] } | null> {
  let res: Response;
  try {
    res = await fetchProviderResponse(buildGdacsUrl(), { sourceId: 'gdacs', timeoutMs: 15000, format: 'json', signal, fetchFn: runFetch });
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof ProviderHttpError) throw e;
    throw new ProviderNetworkError(String(e));
  }
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ProviderHttpError(502, undefined, 'GDACS unexpected content type');
  const data = (await res.json()) as GdacsFixture;
  if (!Array.isArray(data.features)) throw new ProviderHttpError(502, undefined, 'GDACS envelope missing features');
  return { items: (input, now) => parseGdacsApi(data, input, now) };
}

async function fetchGdacsRss(
  runFetch: GdeltFetch,
  signal: AbortSignal,
): Promise<(input: ProviderInput, now: Date) => AcquisitionItem[]> {
  let res: Response;
  try {
    res = await fetchProviderResponse(GDACS_RSS_URL, { sourceId: 'gdacs-rss', timeoutMs: 15000, format: 'xml', signal, fetchFn: runFetch });
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof ProviderHttpError) throw e;
    throw new ProviderNetworkError(String(e));
  }
  const xml = await res.text();
  return (input, now) => parseGdacsFeed(xml, input, now);
}
