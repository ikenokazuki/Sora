import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const CCTV_NEWS_CATEGORIES = ['china', 'society'] as const;
export const CCTV_NEWS_MAX_PER_CATEGORY = 30;
const CCTV_JSONP_BASE = 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/';

export interface CctvNewsEntry { id: string; title: string; excerpt: string; url: string; publishedAt?: string; category: string; }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function unwrapJsonp(text: string): string {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new ProviderHttpError(502, undefined, 'CCTV news envelope unexpected');
  return text.slice(start + 1, end);
}

function parseFocusDate(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const parsed = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+08:00');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function entryId(url: string, title: string): string {
  const m = /\/([A-Z]+[^\/]*)\.shtml$/.exec(url);
  if (m?.[1]) return m[1];
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** JSONPを剥がして記事一覧を返す。コードとしては実行しない。 */
export function parseCctvNewsJsonp(text: string, category: string): CctvNewsEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(unwrapJsonp(text)) as unknown;
  } catch {
    throw new ProviderHttpError(502, undefined, 'CCTV news envelope unexpected');
  }
  const list = asRecord(asRecord(data)?.['data'])?.['list'];
  if (!Array.isArray(list)) throw new ProviderHttpError(502, undefined, 'CCTV news envelope unexpected');
  const entries: CctvNewsEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const title = asText(record?.['title']).trim();
    const url = asText(record?.['url']).trim();
    if (!title || !/^https?:\/\//.test(url)) continue;
    const publishedAt = parseFocusDate(asText(record?.['focus_date']));
    entries.push({
      id: entryId(url, title),
      title: title.slice(0, 300),
      excerpt: asText(record?.['brief']).trim(),
      url,
      ...(publishedAt ? { publishedAt } : {}),
      category,
    });
    if (entries.length >= CCTV_NEWS_MAX_PER_CATEGORY) break;
  }
  if (!entries.length) throw new ProviderHttpError(502, undefined, 'CCTV news envelope unexpected');
  return entries;
}

export function createCctvNewsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'cctv_news', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 600,
    collectionWindowDays: 1,
    timeoutMs: 8000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = [];
      for (const category of CCTV_NEWS_CATEGORIES) {
        let res: Response;
        try {
          const timeout = AbortSignal.timeout(8000);
          const combined = signal.aborted ? signal : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout);
          res = await runFetch(CCTV_JSONP_BASE + category + '_1.jsonp', {
            signal: combined,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
              Referer: 'https://news.cctv.com/' + category,
              Accept: 'application/javascript, text/plain, */*',
            },
          });
        } catch (e) {
          if (signal.aborted) throw e;
          if (e instanceof ProviderHttpError) throw e;
          throw new ProviderNetworkError(String(e));
        }
        if (!res.ok) throw new ProviderHttpError(res.status, res.headers.get('retry-after') ?? undefined, 'Provider HTTP ' + res.status);
        const entries = parseCctvNewsJsonp(await res.text(), category);
        for (const entry of entries) {
          const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: entry.excerpt.slice(0, 2000) || undefined, publisher: 'CCTV News', language: 'zh', publishedAt: entry.publishedAt, sourceType: 'major_local_media', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
          const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'cctv_news', providerItemId: 'cctv:' + entry.id, sourceRecordUrl: entry.url, contentKind: 'excerpt', language: 'zh', blocks: entry.excerpt ? [{ index: items.length, text: entry.excerpt.slice(0, 2000) }] : [], structuredData: { articleId: entry.id, category: entry.category }, publishedAt: entry.publishedAt, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: entry.excerpt.length > 2000 };
          items.push({ evidence, detail, areas: ['media_activity'] as readonly string[] });
        }
        if (signal.aborted) throw signal.reason;
      }
      return { items, coverage: ['media_activity'] };
    },
  };
}
