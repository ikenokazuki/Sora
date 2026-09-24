/** Yahoo X リアルタイム検索の直接JSON provider。
 * Yahoo pagination JSON (`timeline.entry`) を既存Sora provider形式へ変換する。
 * ranking・クエリ生成・response圧縮は行わない。yahoo.ts / scraper.ts をimportしない。
 */
import { fetchWithSafeRedirects } from '../http_fetcher.js';

export interface YahooRealtimePageOptions {
  query: string;
  sort?: 'recent' | 'popular';
  limit?: number;
  page?: number;
}

export interface YahooRealtimeProviderItem {
  id: string;
  url: string;
  text: string;
  author_name: string;
  author_handle: string;
  author_url?: string;
  created_at?: number;
  reply_count: number;
  repost_count: number;
  like_count: number;
  hashtags?: string[];
  media?: string[];
}

export interface YahooRealtimePage {
  items: YahooRealtimeProviderItem[];
  count: number;
  page: number;
}

export type RealtimeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ENDPOINT = 'https://search.yahoo.co.jp/realtime/api/v1/pagination';
const PAGE_WIDTH = 40;
const MAX_OFFSET = 10000;

export function buildYahooRealtimeApiUrl(options: YahooRealtimePageOptions): URL {
  const query = (options.query || '').trim();
  if (!query) throw new Error('query is required');
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
    throw new Error(`limit must be an integer 1-40 (got ${String(options.limit)})`);
  }
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`page must be an integer >= 1 (got ${String(options.page)})`);
  }
  const start = (page - 1) * PAGE_WIDTH;
  if (!Number.isSafeInteger(start) || start > MAX_OFFSET) {
    throw new Error(`page offset out of range (page ${page})`);
  }
  const url = new URL(ENDPOINT);
  url.searchParams.set('p', query);
  url.searchParams.set('results', String(limit));
  url.searchParams.set('start', String(start));
  if (options.sort === 'popular') url.searchParams.set('md', 'h');
  return url;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function cleanHighlightMarkers(text: string): string {
  return text
    .replace(/\tSTART\t/g, '')
    .replace(/\tEND\t/g, '')
    .replace(/\\tSTART\\t/g, '')
    .replace(/\\tEND\\t/g, '');
}

function parseEntry(entry: unknown): YahooRealtimeProviderItem | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : null;
  if (!id) return null;
  const screenName = typeof e.screenName === 'string' ? e.screenName : '';
  const rawText = typeof e.displayTextBody === 'string'
    ? e.displayTextBody
    : typeof e.displayText === 'string'
      ? e.displayText
      : null;
  if (rawText === null) return null;
  const text = cleanHighlightMarkers(rawText);
  let url = typeof e.url === 'string' && e.url.length > 0 ? e.url : '';
  if (!url && screenName) url = `https://x.com/${screenName}/status/${id}`;
  if (!url) return null;
  const createdAt = toFiniteNumber(e.createdAt);
  const reply = toFiniteNumber(e.replyCount) ?? 0;
  const repost = toFiniteNumber(e.rtCount) ?? 0;
  const likes = toFiniteNumber(e.likesCount) ?? 0;
  const hashtags = Array.isArray(e.hashtags)
    ? (e.hashtags as unknown[]).filter((h): h is string => typeof h === 'string')
    : undefined;
  const media = Array.isArray(e.media)
    ? (e.media as unknown[])
      .map((m) => {
        if (!m || typeof m !== 'object') return null;
        const item = (m as Record<string, unknown>).item;
        if (!item || typeof item !== 'object') return null;
        const mediaUrl = (item as Record<string, unknown>).mediaUrl;
        return typeof mediaUrl === 'string' && mediaUrl.length > 0 ? mediaUrl : null;
      })
      .filter((u): u is string => u !== null)
    : undefined;
  const item: YahooRealtimeProviderItem = {
    id,
    url,
    text,
    author_name: typeof e.name === 'string' ? e.name : '',
    author_handle: screenName,
    reply_count: reply,
    repost_count: repost,
    like_count: likes,
  };
  if (typeof e.userUrl === 'string' && e.userUrl.length > 0) item.author_url = e.userUrl;
  if (createdAt !== undefined && createdAt > 0) item.created_at = Math.floor(createdAt);
  if (hashtags && hashtags.length > 0) item.hashtags = hashtags;
  if (media && media.length > 0) item.media = media;
  return item;
}

/** Yahoo pagination JSON全体 -> provider形式。構造不正は例外、個別entry不正はskip。 */
export function parseYahooRealtimePayload(payload: unknown): YahooRealtimeProviderItem[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Yahoo realtime payload: not an object');
  }
  const timeline = (payload as Record<string, unknown>).timeline;
  if (!timeline || typeof timeline !== 'object') {
    throw new Error('Invalid Yahoo realtime payload: timeline missing');
  }
  const entry = (timeline as Record<string, unknown>).entry;
  if (!Array.isArray(entry)) {
    throw new Error('Invalid Yahoo realtime payload: timeline.entry is not an array');
  }
  const items: YahooRealtimeProviderItem[] = [];
  const seen = new Set<string>();
  for (const raw of entry) {
    const parsed = parseEntry(raw);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    items.push(parsed);
  }
  if (entry.length > 0 && items.length === 0) {
    throw new Error(`Invalid Yahoo realtime payload: all ${entry.length} entries unparsable`);
  }
  return items;
}

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://search.yahoo.co.jp/realtime/search',
};

/** 単一ページ取得。1呼び出し1 HTTP、retryなし。正常0件と障害を区別する。 */
export async function searchYahooRealtimePage(
  options: YahooRealtimePageOptions,
  deps?: { fetchImpl?: RealtimeFetch; timeoutMs?: number },
): Promise<YahooRealtimePage> {
  const url = buildYahooRealtimeApiUrl(options);
  const timeoutMs = deps?.timeoutMs ?? 15000;
  // 指紋は http_fetcher（wreq impersonation）に集約。独自fetch・独自UAは使わない。
  const fetchImpl: RealtimeFetch = deps?.fetchImpl ?? (async (input, init) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) raw.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(raw)) for (const [k, v] of raw) headers[k] = v;
    else if (raw) Object.assign(headers, raw);
    const { response } = await fetchWithSafeRedirects(String(input), timeoutMs, 2, headers);
    return response;
  });
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { ...DEFAULT_HEADERS },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new Error(`Yahoo realtime fetch failed: ${err?.message || err}`);
  }
  if (!response.ok) {
    throw new Error(`Yahoo realtime HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Invalid Yahoo realtime payload: body is not JSON');
  }
  const items = parseYahooRealtimePayload(payload);
  return { items, count: items.length, page: options.page ?? 1 };
}
