import { normalizeProviderCountryCode } from '../geo_codes.js';
import type { CollectionWindow } from '../detail.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import { parseGdeltEventsResponse, type GdeltEventRow } from './gdelt_events.js';
import type { GdeltFetch } from './gdelt.js';
import type { RegionIdentity } from '../types.js';

export const GDELT_EXPORT_COLUMNS = 61;
export const GDELT_LAST_UPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const IDX_GLOBALEVENTID = 0;
const IDX_SQLDATE = 1;
const IDX_ACTOR1_COUNTRY = 7;
const IDX_EVENT_CODE = 26;
const IDX_NUM_ARTICLES = 33;
const IDX_ACTION_GEO_COUNTRY = 53;
const IDX_SOURCE_URL = 60;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export function parseGdeltExport(tsv: string): GdeltEventRow[] {
  return tsv.split('\n').flatMap((line) => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.trim()) return [];
    const cols = trimmed.split('\t');
    if (cols.length !== GDELT_EXPORT_COLUMNS) return [];
    if (!cols[IDX_SOURCE_URL]) return [];
    const articles = Number(cols[IDX_NUM_ARTICLES]);
    return [{
      GLOBALEVENTID: cols[IDX_GLOBALEVENTID] || undefined,
      SQLDATE: cols[IDX_SQLDATE] || undefined,
      Actor1CountryCode: cols[IDX_ACTOR1_COUNTRY] || undefined,
      ActionGeo_CountryCode: cols[IDX_ACTION_GEO_COUNTRY] || undefined,
      EventCode: cols[IDX_EVENT_CODE] || undefined,
      ...(Number.isFinite(articles) && cols[IDX_NUM_ARTICLES] !== '' ? { NumArticles: articles } : {}),
      SOURCEURL: cols[IDX_SOURCE_URL],
    }];
  });
}

export function parseGdeltLastUpdate(text: string): string[] {
  return text.split('\n')
    .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
    .filter((url) => url.includes('.export.CSV.zip'))
    .map((url) => (url.startsWith('http://') ? 'https://' + url.slice('http://'.length) : url));
}

export function filterGdeltRowsForRegion(rows: readonly GdeltEventRow[], region: RegionIdentity): GdeltEventRow[] {
  const wanted = region.countryCode;
  if (!wanted) return [];
  return rows.filter((row) => normalizeProviderCountryCode('gdelt_geo', row.ActionGeo_CountryCode) === wanted);
}

export interface GdeltWindowDeps {
  listExportUrls: () => Promise<string[]>;
  fetchExport: (url: string, signal: AbortSignal) => Promise<string>;
  onRows?: (rows: GdeltEventRow[], url: string) => void;
  maxFilesPerRun?: number;
  signal: AbortSignal;
}

export async function collectGdeltWindow(window: CollectionWindow, deps: GdeltWindowDeps): Promise<CollectionWindow> {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { ...window, complete: false, gaps: [{ from: window.from, to: window.to, reason: 'invalid window' }] };
  const expected = Math.max(1, Math.round((to - from) / FIFTEEN_MINUTES_MS));
  let listed: string[] = [];
  try {
    listed = await deps.listExportUrls();
  } catch {
    return { ...window, complete: false, gaps: [{ from: window.from, to: window.to, reason: 'export list unavailable' }] };
  }
  const batch = listed.slice(0, deps.maxFilesPerRun ?? 32);
  let ingested = 0;
  for (const url of batch) {
    try {
      const tsv = await deps.fetchExport(url, deps.signal);
      deps.onRows?.(parseGdeltExport(tsv), url);
      ingested += 1;
    } catch {
      if (deps.signal.aborted) throw deps.signal.reason;
    }
  }
  if (ingested >= expected) return { ...window, complete: true, gaps: [] };
  return { ...window, complete: false, gaps: [{ from: window.from, to: window.to, reason: 'period_gap: ingested ' + ingested + ' of ' + expected + ' export files' }] };
}

async function unzipStdin(input: Uint8Array): Promise<string> {
  const proc = Bun.spawn(['unzip', '-p', '-'], { stdin: input, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error('unzip failed: ' + err.slice(0, 200));
  return out;
}

export interface GdeltExportProviderDeps {
  fetchFn?: GdeltFetch;
  decompressZip?: (bytes: Uint8Array) => Promise<string>;
}

export function createGdeltExportProvider(deps: GdeltExportProviderDeps = {}): CountryIntelProvider {
  const runFetch: GdeltFetch = deps.fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  const decompress = deps.decompressZip ?? unzipStdin;
  return {
    id: 'gdelt_export', areas: ['current_events', 'historical_context'], latencyClass: 'delayed', defaultTtlSeconds: 900,
    async run(input: ProviderInput, signal: AbortSignal): Promise<{ items: AcquisitionItem[]; coverage?: string[] }> {
      let updateRes: Response;
      try {
        updateRes = await fetchProviderResponse(GDELT_LAST_UPDATE_URL, { sourceId: 'gdelt_export', timeoutMs: 10000, format: 'text', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const urls = parseGdeltLastUpdate(await updateRes.text());
      const latest = urls.at(-1);
      if (!latest) throw new ProviderHttpError(502, undefined, 'GDELT export list is empty');
      let bytes: Uint8Array;
      try {
        const zipRes = await fetchProviderResponse(latest, { sourceId: 'gdelt_export', timeoutMs: 30000, format: 'text', signal, fetchFn: runFetch });
        bytes = new Uint8Array(await zipRes.arrayBuffer());
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      let tsv: string;
      try {
        tsv = await decompress(bytes);
      } catch (e) {
        if (signal.aborted) throw e;
        throw new ProviderHttpError(502, undefined, 'GDELT export decompression failed');
      }
      const rows = filterGdeltRowsForRegion(parseGdeltExport(tsv), input.region);
      return { items: parseGdeltEventsResponse({ events: rows }, input, new Date()), coverage: ['current_events'] };
    },
  };
}
