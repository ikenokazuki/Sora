import yauzl from 'yauzl';
import { normalizeProviderCountryCode } from '../geo_codes.js';
import type { CollectionWindow } from '../detail.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderLocalError, ProviderNetworkError } from '../provider_registry.js';
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
const IDX_AVG_TONE = 34;
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
    const tone = Number(cols[IDX_AVG_TONE]);
    return [{
      GLOBALEVENTID: cols[IDX_GLOBALEVENTID] || undefined,
      SQLDATE: cols[IDX_SQLDATE] || undefined,
      Actor1CountryCode: cols[IDX_ACTOR1_COUNTRY] || undefined,
      ActionGeo_CountryCode: cols[IDX_ACTION_GEO_COUNTRY] || undefined,
      EventCode: cols[IDX_EVENT_CODE] || undefined,
      ...(Number.isFinite(articles) && cols[IDX_NUM_ARTICLES] !== '' ? { NumArticles: articles } : {}),
      ...(Number.isFinite(tone) && cols[IDX_AVG_TONE] !== '' ? { AvgTone: tone } : {}),
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

export const GDELT_EXPORT_ZIP_BYTES_MAX = 5 * 1024 * 1024;
export const GDELT_EXPORT_CSV_CHARS_MAX = 50 * 1024 * 1024;

/** yauzl でメモリ内解凍する。対象の .export.CSV だけを読む。独自ZIPパーサーは作らない。 */
export function unzipGdeltExport(input: Uint8Array): Promise<string> {
  if (input.length > GDELT_EXPORT_ZIP_BYTES_MAX) {
    return Promise.reject(new ProviderLocalError('SIZE_LIMIT', 'GDELT export zip exceeds 5MiB'));
  }
  return new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(input), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(new ProviderLocalError('DECOMPRESS_FAILED', 'GDELT export zip open failed'));
        return;
      }
      let found = false;
      let settled = false;
      const fail = (code: ProviderLocalError['code'], message: string): void => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(new ProviderLocalError(code, message));
      };
      zip.on('error', () => fail('DECOMPRESS_FAILED', 'GDELT export zip read failed'));
      zip.on('end', () => {
        if (!found) fail('DECOMPRESS_FAILED', 'GDELT export CSV missing in zip');
      });
      zip.on('entry', (entry) => {
        if (settled) return;
        if (!entry.fileName.endsWith('.export.CSV')) {
          zip.readEntry();
          return;
        }
        if (found) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail('DECOMPRESS_FAILED', 'GDELT export entry open failed');
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > GDELT_EXPORT_CSV_CHARS_MAX) {
              fail('SIZE_LIMIT', 'GDELT export CSV exceeds 50MiB');
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', () => fail('DECOMPRESS_FAILED', 'GDELT export entry read failed'));
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            try { zip.close(); } catch { /* already closed */ }
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
      });
      zip.readEntry();
    });
  });
}

export interface GdeltExportProviderDeps {
  fetchFn?: GdeltFetch;
  decompressZip?: (bytes: Uint8Array) => Promise<string>;
}

/** 地域行のtone集計。新規取得なし。toneなし行は除外。 */
export function summarizeGdeltTone(rows: readonly GdeltEventRow[]): { count: number; avgTone: number } | undefined {
  const tones = rows.flatMap((row) => (typeof row.AvgTone === 'number' && Number.isFinite(row.AvgTone) ? [row.AvgTone] : []));
  if (!tones.length) return undefined;
  return { count: tones.length, avgTone: tones.reduce((a, b) => a + b, 0) / tones.length };
}

export function createGdeltExportProvider(deps: GdeltExportProviderDeps = {}): CountryIntelProvider {
  const runFetch: GdeltFetch = deps.fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  const decompress = deps.decompressZip ?? unzipGdeltExport;
  return {
    id: 'gdelt_export', areas: ['current_events', 'historical_context'], latencyClass: 'delayed', defaultTtlSeconds: 900,
    collectionWindowDays: 1 / 96,
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
        if (e instanceof ProviderLocalError) throw e;
        throw new ProviderLocalError('DECOMPRESS_FAILED', 'GDELT export decompression failed');
      }
      const rows = filterGdeltRowsForRegion(parseGdeltExport(tsv), input.region);
      const items = parseGdeltEventsResponse({ events: rows }, input, new Date());
      const tone = summarizeGdeltTone(rows);
      if (tone) {
        items.push({
          metric: {
            key: 'gdelt_media_tone',
            current: Math.round(tone.avgTone * 100) / 100,
            window: '15m',
            direction: tone.avgTone > 1 ? 'rising' : tone.avgTone < -1 ? 'falling' : 'stable',
          },
        });
      }
      return { items, coverage: ['current_events'] };
    },
  };
}
