import type { SimpleCookie } from './weibo_session.js';
import type { SocialComment, SocialPost } from './types.js';

export const WEIBO_PWA_HEADERS: Record<string, string> = {
  'MWeibo-Pwa': '1',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://m.weibo.cn/',
  Accept: 'application/json,text/plain,*/*',
};

export interface WeiboHttp {
  getJson(url: string, headers: Record<string, string>, cookies: SimpleCookie[], timeoutMs: number, signal: AbortSignal): Promise<{ status: number; data: any }>;
}

export class WeiboAuthError extends Error {
  constructor(message = 'Weibo auth required (ok:-100)') { super(message); this.name = 'WeiboAuthError'; }
}
export class WeiboRateLimitedError extends Error {
  constructor(message = 'Weibo rate limited') { super(message); this.name = 'WeiboRateLimitedError'; }
}

/** HTMLの改行・引用・絵文字altを維持した簡易テキスト化。 */
export function stripWeiboHtml(html: string): string {
  return String(html ?? '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1')
    .replace(/<(br|p|div|li|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** "Sat Aug 29 10:07:40 +0800 2026" をISOへ。正規化できなければnull。 */
export function parseWeiboTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function buildWeiboSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams({ containerid: '100103type=61&q=' + query + '&t=0', page_type: 'searchall', page: String(page) });
  return 'https://m.weibo.cn/api/container/getIndex?' + params.toString();
}

export function extractMblogs(payload: any): any[] {
  const out: any[] = [];
  const walk = (cards: any[]): void => {
    for (const card of cards ?? []) {
      if (card && typeof card === 'object') {
        if (card.mblog) out.push(card.mblog);
        if (Array.isArray(card.card_group)) walk(card.card_group);
      }
    }
  };
  walk(payload?.data?.cards);
  return out;
}

function checkWeiboEnvelope(data: any): void {
  if (data?.ok === -100) throw new WeiboAuthError();
  if (typeof data?.ok === 'number' && data.ok !== 1) throw new Error('Weibo API error ok=' + String(data.ok) + ' ' + String(data?.msg ?? ''));
}

export interface WeiboSearchPage {
  posts: any[];
  empty: boolean;
}

export async function fetchWeiboSearchPage(http: WeiboHttp, session: SimpleCookie[], query: string, page: number, signal: AbortSignal): Promise<WeiboSearchPage> {
  const { status, data } = await http.getJson(buildWeiboSearchUrl(query, page), WEIBO_PWA_HEADERS, session, 10000, signal);
  if (status === 429) throw new WeiboRateLimitedError();
  checkWeiboEnvelope(data);
  const posts = extractMblogs(data);
  return { posts, empty: posts.length === 0 };
}

/** 新着検索。最大3ページ、重複排除、期間外除外は呼び出し側で行う。 */
export async function searchWeibo(http: WeiboHttp, session: SimpleCookie[], query: string, limit: number, signal: AbortSignal): Promise<{ posts: any[]; failures: string[] }> {
  const posts: any[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];
  for (let page = 1; page <= 3; page++) {
    if (signal.aborted) break;
    try {
      const { posts: found, empty } = await fetchWeiboSearchPage(http, session, query, page, signal);
      let added = 0;
      for (const post of found) {
        const id = String(post?.id ?? post?.bid ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        posts.push(post);
        added++;
        if (posts.length >= limit) break;
      }
      if (empty || added === 0 || posts.length >= limit) break;
    } catch (e) {
      if (e instanceof WeiboAuthError || e instanceof WeiboRateLimitedError) throw e;
      failures.push('page ' + page + ': ' + String((e as Error)?.message ?? e).slice(0, 160));
      break;
    }
  }
  return { posts: posts.slice(0, limit), failures };
}

export async function fetchWeiboStatus(http: WeiboHttp, bid: string, signal: AbortSignal): Promise<any> {
  const { status, data } = await http.getJson('https://m.weibo.cn/statuses/show?id=' + encodeURIComponent(bid), WEIBO_PWA_HEADERS, [], 10000, signal);
  if (status === 429) throw new WeiboRateLimitedError();
  checkWeiboEnvelope(data);
  return data?.data;
}

export async function fetchWeiboExtend(http: WeiboHttp, bid: string, signal: AbortSignal): Promise<string> {
  try {
    const { data } = await http.getJson('https://m.weibo.cn/statuses/extend?id=' + encodeURIComponent(bid), WEIBO_PWA_HEADERS, [], 10000, signal);
    if (data?.ok === 1 && typeof data?.data?.longTextContent === 'string') return data.data.longTextContent;
  } catch { /* 短文を残す */ }
  return '';
}

export interface WeiboCommentsResult { comments: SocialComment[]; state: 'fetched' | 'empty' | 'failed'; reason?: string; }

export async function fetchWeiboHotComments(http: WeiboHttp, numericId: string, limit: number, signal: AbortSignal): Promise<WeiboCommentsResult> {
  try {
    const { status, data } = await http.getJson(
      'https://m.weibo.cn/comments/hotflow?id=' + encodeURIComponent(numericId) + '&mid=' + encodeURIComponent(numericId) + '&max_id_type=0',
      WEIBO_PWA_HEADERS, [], 10000, signal);
    if (status === 429) throw new WeiboRateLimitedError();
    if (data?.ok !== 1) return { comments: [], state: 'failed', reason: 'comments ok=' + String(data?.ok) };
    const list = Array.isArray(data?.data?.data) ? data.data.data : [];
    const comments = list.slice(0, limit).map((c: any): SocialComment => ({
      id: String(c?.id ?? ''),
      ...(c?.user?.screen_name ? { author: String(c.user.screen_name) } : {}),
      text: stripWeiboHtml(c?.text ?? '').slice(0, 1000),
      ...(parseWeiboTime(c?.created_at) ? { publishedAt: parseWeiboTime(c.created_at) as string } : {}),
      postId: numericId,
    })).filter((c: SocialComment) => c.id && c.text);
    return comments.length ? { comments, state: 'fetched' } : { comments: [], state: 'empty' };
  } catch (e) {
    if (e instanceof WeiboRateLimitedError) throw e;
    return { comments: [], state: 'failed', reason: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

export function extractWeiboBid(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'm.weibo.cn' && u.hostname !== 'weibo.com' && u.hostname !== 'www.weibo.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'status' || p === 'detail');
    if (idx >= 0 && parts[idx + 1] && /^[A-Za-z0-9]+$/.test(parts[idx + 1])) return parts[idx + 1];
    if (parts.length === 2 && /^[A-Za-z0-9]+$/.test(parts[1])) return parts[1];
    return null;
  } catch {
    return null;
  }
}
