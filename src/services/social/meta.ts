import * as cheerio from 'cheerio';
import type { SocialPlatform } from './types.js';

export interface MetaHttp {
  getPage(url: string, timeoutMs: number, signal: AbortSignal): Promise<{ status: number; finalUrl: string; html: string }>;
  getJson(url: string, timeoutMs: number, signal: AbortSignal): Promise<{ status: number; data: any }>;
}

export interface MetaBrowser {
  readPage(url: string, timeoutMs: number, signal: AbortSignal): Promise<{ finalUrl: string; html: string; title: string }>;
}

const THREADS_POST_RE = /^\/@[A-Za-z0-9._]+\/post\/([A-Za-z0-9_-]+)\/?$/;
const THREADS_SHORT_RE = /^\/t\/([A-Za-z0-9_-]+)\/?$/;
const INSTAGRAM_POST_RE = /^\/(?:[A-Za-z0-9._]+\/)?(p|reel)\/([A-Za-z0-9_-]+)\/?$/i;
const FACEBOOK_POST_RE = /^\/([^/]+)\/posts\/(?:([^/]+)\/)?([^/]+)\/?$/i;

export function detectMetaPlatform(url: string): SocialPlatform | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'threads.com' || host === 'www.threads.com' || host === 'threads.net' || host === 'www.threads.net') {
      return THREADS_POST_RE.test(u.pathname) || THREADS_SHORT_RE.test(u.pathname) ? 'threads' : null;
    }
    if (host === 'instagram.com' || host === 'www.instagram.com') {
      return INSTAGRAM_POST_RE.test(u.pathname) ? 'instagram' : null;
    }
    if (host === 'facebook.com' || host === 'www.facebook.com' || host === 'm.facebook.com' || host === 'web.facebook.com') {
      if (/^\/reel\/([^/]+)\/?$/i.test(u.pathname)) return 'facebook';
      return FACEBOOK_POST_RE.test(u.pathname) ? 'facebook' : null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface MetaPageData {
  title: string;
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogType?: string;
  ogImage?: string;
  canonical?: string;
  times: Array<{ datetime?: string; href?: string; title?: string }>;
}

export function parseMetaPage(html: string): MetaPageData {
  const $ = cheerio.load(html);
  const meta = (k: string): string | undefined =>
    $('meta[property="' + k + '"]').first().attr('content') || $('meta[name="' + k + '"]').first().attr('content') || undefined;
  const times = $('time').map((_, e) => ({
    ...( $(e).attr('datetime') ? { datetime: $(e).attr('datetime') } : {}),
    ...( $(e).closest('a').attr('href') ? { href: $(e).closest('a').attr('href') as string } : {}),
    ...( $(e).attr('title') ? { title: $(e).attr('title') as string } : {}),
  })).get();
  return {
    title: $('title').text().slice(0, 300),
    ...(meta('og:title') ? { ogTitle: meta('og:title') } : {}),
    ...(meta('og:description') ? { ogDescription: meta('og:description') } : {}),
    ...(meta('og:url') ? { ogUrl: meta('og:url') } : {}),
    ...(meta('og:type') ? { ogType: meta('og:type') } : {}),
    ...(meta('og:image') ? { ogImage: meta('og:image') } : {}),
    ...($('link[rel="canonical"]').attr('href') ? { canonical: $('link[rel="canonical"]').attr('href') as string } : {}),
    times,
  };
}

/** 対象投稿に結び付く日時だけ採用する。コメント日時（/c/ リンク等）を除外。 */
export function selectPostTime(times: MetaPageData['times'], postPath: string): { publishedAt?: string; timeStatus: 'known' | 'unknown' | 'conflict' } {
  const dated = times.filter((t) => t.datetime && Number.isFinite(Date.parse(t.datetime as string)));
  if (!dated.length) return { timeStatus: 'unknown' };
  // 対象投稿自身へのリンクを持つ time を優先。コメントリンク（/c/）は除外。
  const own = dated.filter((t) => {
    const href = t.href ?? '';
    if (/\/c\//.test(href)) return false;
    if (!href) return true;
    try {
      const path = new URL(href, 'https://x.invalid').pathname;
      return path === postPath || href.includes(postPath);
    } catch {
      return href.includes(postPath);
    }
  });
  const iso = (t: { datetime?: string }): string => new Date(t.datetime as string).toISOString();
  // リンクなしの時刻（投稿ヘッダの表示時刻）を最優先する。
  const bareValues = new Set(dated.filter((t) => !t.href).map((t) => iso(t)));
  if (bareValues.size === 1) return { publishedAt: [...bareValues][0], timeStatus: 'known' };
  const candidates = own.length ? own : dated.filter((t) => !/\/c\//.test(t.href ?? ''));
  if (!candidates.length) return { timeStatus: 'unknown' };
  const first = iso(candidates[0]);
  if (candidates.length > 1 && candidates.some((t) => iso(t) !== first)) {
    // 複数の異なる日時候補。対象に結び付く単一時刻が定まらない。
    const direct = candidates.filter((t) => (t.href ?? '').includes(postPath));
    if (direct.length === 1) return { publishedAt: iso(direct[0]), timeStatus: 'known' };
    return { timeStatus: 'conflict' };
  }
  return { publishedAt: first, timeStatus: 'known' };
}

export const META_OEMBED_ENDPOINTS: Record<SocialPlatform, string> = {
  weibo: '',
  threads: 'https://graph.threads.com/oembed',
  instagram: 'https://graph.facebook.com/v25.0/instagram_oembed',
  facebook: 'https://graph.facebook.com/v25.0/oembed_post',
};

const OEMBED_PLACEHOLDERS = ['View on Threads', 'View this post on Instagram', 'View this video on Instagram'];

export function isOembedPlaceholder(text: string): boolean {
  const t = text.trim();
  return !t || OEMBED_PLACEHOLDERS.some((p) => t === p || t.startsWith(p + ' '));
}

export function parseInstagramDescription(description: string): { username: string; caption: string; likesDisplay: string; commentsDisplay: string; dateDisplay: string } {
  const m = /^([\d.,]+(?:[KMB])?)\s+likes?,\s+([\d.,]+(?:[KMB])?)\s+comments?\s+-\s+([A-Za-z0-9._]+)\s+on\s+([^:]+):\s+["\u201c]([\s\S]*)["\u201d]\.?(\s*)$/i.exec(description ?? '');
  if (!m) return { username: '', caption: '', likesDisplay: '', commentsDisplay: '', dateDisplay: '' };
  return { likesDisplay: m[1], commentsDisplay: m[2], username: m[3], dateDisplay: m[4].trim(), caption: m[5].trim() };
}
