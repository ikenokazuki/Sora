import { detectMetaPlatform, isOembedPlaceholder, META_OEMBED_ENDPOINTS, parseInstagramDescription, parseMetaPage, selectPostTime, type MetaBrowser, type MetaHttp } from './meta.js';
import { discoverMetaPosts, type DiscoveryWebSearch } from './discovery.js';
import { extractWeiboBid, fetchWeiboExtend, fetchWeiboHotComments, fetchWeiboStatus, parseWeiboTime, searchWeibo, stripWeiboHtml, WeiboAuthError, WeiboRateLimitedError, type WeiboHttp } from './weibo.js';
import { createWeiboSessionStore, type SimpleCookie, type WeiboSessionOpener } from './weibo_session.js';
import { SocialFetchInputSchema, SocialFetchResultSchema, SocialSearchInputSchema, SocialSearchResultSchema, type SocialFetchInput, type SocialFetchResult, type SocialPlatform, type SocialPost, type SocialSearchInput, type SocialSearchResult } from './types.js';

export interface SocialDeps {
  weiboHttp: WeiboHttp;
  sessionOpener: WeiboSessionOpener;
  metaHttp: MetaHttp;
  metaBrowser?: MetaBrowser;
  webSearch: DiscoveryWebSearch;
  now?: () => number;
}

export interface SocialContext {
  signal: AbortSignal;
  deadlineAt: number;
}

const MAX_TEXT_CHARS = 6000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

function inWindow(publishedAt: string | undefined, nowMs: number, lookbackHours: number): boolean | null {
  if (!publishedAt) return null;
  const ms = Date.parse(publishedAt);
  if (!Number.isFinite(ms)) return null;
  return nowMs - ms <= lookbackHours * 3600 * 1000;
}

function remaining(ctx: SocialContext, now: number): number {
  return ctx.deadlineAt - now;
}

function weiboRawToPost(raw: any, retrievedAt: string, lookbackHours: number, nowMs: number): SocialPost {
  const id = String(raw?.id ?? raw?.bid ?? '');
  const url = 'https://m.weibo.cn/detail/' + id;
  const publishedAt = parseWeiboTime(raw?.created_at) ?? undefined;
  const { text: sliced, truncated } = truncate(stripWeiboHtml(raw?.text ?? ''));
  const metrics: Record<string, number> = {};
  if (typeof raw?.comments_count === 'number') metrics.comments = raw.comments_count;
  if (typeof raw?.reposts_count === 'number') metrics.reposts = raw.reposts_count;
  if (typeof raw?.attitudes_count === 'number') metrics.attitudes = raw.attitudes_count;
  const retweeted = raw?.retweeted_status;
  return {
    id, platform: 'weibo', url, requestedUrl: url,
    ...(raw?.user?.screen_name ? { author: String(raw.user.screen_name) } : {}),
    text: sliced, textKind: 'excerpt',
    ...(publishedAt ? { publishedAt } : {}),
    ...(raw?.created_at ? { rawPublishedAt: String(raw.created_at) } : {}),
    retrievedAt,
    timeStatus: publishedAt ? 'known' : 'unknown',
    inRequestedWindow: inWindow(publishedAt, nowMs, lookbackHours),
    method: 'weibo_public_mobile_json',
    searchMode: 'native_latest',
    ...(Object.keys(metrics).length ? { metrics } : {}),
    comments: { state: 'not_requested', order: 'hotflow', items: [] },
    ...(retweeted ? { quotedPost: { ...(retweeted?.user?.screen_name ? { author: String(retweeted.user.screen_name) } : {}), text: stripWeiboHtml(retweeted?.text ?? '').slice(0, 1000) } } : {}),
    truncated,
    warnings: ['search snippet; use fetch for full text and comments'],
  };
}

async function enrichWeiboPost(deps: SocialDeps, post: SocialPost, bid: string, commentLimit: number, ctx: SocialContext): Promise<SocialPost> {
  const out = { ...post, warnings: [...post.warnings] };
  try {
    const status = await fetchWeiboStatus(deps.weiboHttp, bid, ctx.signal);
    if (status) {
      const full = status.isLongText === true ? await fetchWeiboExtend(deps.weiboHttp, String(status.bid ?? bid), ctx.signal) : '';
      const body = full || status.text || '';
      const { text, truncated } = truncate(stripWeiboHtml(body));
      if (text) { out.text = text; out.textKind = full ? 'full' : 'excerpt'; out.truncated = truncated; }
      const publishedAt = parseWeiboTime(status.created_at);
      if (publishedAt) { out.publishedAt = publishedAt; out.timeStatus = 'known'; }
      out.method = 'weibo_public_mobile_json' + (full ? '_plus_extend' : '');
      if (!full && status.isLongText === true) out.warnings.push('long text extend unavailable; short body kept');
    }
  } catch (e) {
    out.warnings.push('detail fetch failed: ' + String((e as Error)?.message ?? e).slice(0, 120));
  }
  if (commentLimit > 0) {
    try {
      const numericId = post.id;
      const r = await fetchWeiboHotComments(deps.weiboHttp, numericId, commentLimit, ctx.signal);
      out.comments = { state: r.state === 'fetched' ? 'fetched' : r.state, order: 'hotflow_sample', items: r.comments, ...(r.reason ? { reason: r.reason } : {}) };
    } catch (e) {
      out.comments = { state: 'failed', order: 'hotflow_sample', items: [], reason: String((e as Error)?.message ?? e).slice(0, 120) };
    }
  }
  return out;
}

function metaPageToPost(platform: SocialPlatform, requestedUrl: string, finalUrl: string, retrievedAt: string, lookbackHours: number, nowMs: number, html: string, oembedText?: string): SocialPost | null {
  const page = parseMetaPage(html);
  let path = '';
  try { path = new URL(finalUrl).pathname; } catch { path = new URL(requestedUrl).pathname; }
  const id = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? requestedUrl;
  const time = selectPostTime(page.times, path);
  const warnings: string[] = [];
  let text = page.ogDescription ?? '';
  let author: string | undefined;
  const metricLabels: Record<string, string> = {};
  const metrics: Record<string, number> = {};
  let media: SocialPost['media'];
  if (platform === 'instagram') {
    const parsed = parseInstagramDescription(page.ogDescription ?? '');
    if (parsed.username) author = parsed.username;
    if (parsed.caption) text = parsed.caption;
    if (parsed.likesDisplay) metricLabels.likes = parsed.likesDisplay;
    if (parsed.commentsDisplay) metricLabels.comments = parsed.commentsDisplay;
    if (page.ogImage) {
      const isVideo = (page.ogType ?? '').toLowerCase().startsWith('video');
      media = isVideo
        ? [{ type: 'video', url: finalUrl, thumbnailUrl: page.ogImage }]
        : [{ type: 'image', url: page.ogImage }];
    }
  } else if (platform === 'threads') {
    const m = /\(@([A-Za-z0-9._]+)\)/.exec(page.ogTitle ?? '');
    if (m) author = m[1];
    if (page.ogImage) warnings.push('og image may be the account avatar; not exported as post media');
  } else {
    author = page.ogTitle || undefined;
    if (page.ogImage) media = [{ type: 'image', url: page.ogImage }];
  }
  if ((!text || !text.trim()) && oembedText && !isOembedPlaceholder(oembedText)) {
    text = oembedText;
    warnings.push('body from tokenless oembed; og description was empty');
  }
  if (!text || !text.trim()) return null;
  const { text: sliced, truncated } = truncate(text.trim());
  let publishedAt = time.publishedAt;
  let timeStatus = time.timeStatus;
  let publishedDate: string | undefined;
  if (!publishedAt && platform === 'instagram') {
    const parsed = parseInstagramDescription(page.ogDescription ?? '');
    const ms = parsed.dateDisplay ? Date.parse(parsed.dateDisplay) : NaN;
    if (Number.isFinite(ms)) {
      publishedDate = new Date(ms).toISOString().slice(0, 10);
      timeStatus = 'date_only';
    }
  }
  return {
    id, platform, url: finalUrl, requestedUrl, finalUrl,
    ...(author ? { author } : {}),
    text: sliced, textKind: 'excerpt',
    ...(publishedAt ? { publishedAt } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    retrievedAt,
    timeStatus,
    inRequestedWindow: inWindow(publishedAt, nowMs, lookbackHours),
    method: 'open_graph' + (oembedText ? '_plus_tokenless_oembed' : ''),
    searchMode: 'web_index',
    ...(Object.keys(metrics).length ? { metrics } : {}),
    ...(Object.keys(metricLabels).length ? { metricLabels } : {}),
    ...(media ? { media } : {}),
    comments: { state: 'unsupported', order: 'none', items: [], reason: 'meta comments are out of scope' },
    truncated,
    warnings,
  };
}

async function fetchOembedText(deps: SocialDeps, platform: SocialPlatform, canonicalUrl: string, ctx: SocialContext): Promise<string | undefined> {
  const endpoint = META_OEMBED_ENDPOINTS[platform];
  if (!endpoint) return undefined;
  try {
    const { data } = await deps.metaHttp.getJson(endpoint + '?url=' + encodeURIComponent(canonicalUrl) + '&omitscript=true', 10000, ctx.signal);
    const html = typeof data?.html === 'string' ? data.html : '';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function fetchMetaPost(deps: SocialDeps, platform: SocialPlatform, url: string, lookbackHours: number, ctx: SocialContext): Promise<{ post?: SocialPost; failures: string[]; warnings: string[] }> {
  const now = deps.now ?? Date.now;
  const retrievedAt = new Date(now()).toISOString();
  const failures: string[] = [];
  const warnings: string[] = [];
  let html = '';
  let finalUrl = url;
  try {
    const page = await deps.metaHttp.getPage(url, 10000, ctx.signal);
    html = page.html;
    finalUrl = page.finalUrl;
    if (page.status === 429) return { failures: ['rate limited (429)'], warnings };
  } catch (e) {
    failures.push('static fetch: ' + String((e as Error)?.message ?? e).slice(0, 140));
  }
  let oembedText: string | undefined;
  if (!parseMetaPage(html).ogDescription) {
    oembedText = await fetchOembedText(deps, platform, finalUrl, ctx);
    if (!oembedText) warnings.push('tokenless oembed added no readable body');
  }
  let post = html ? metaPageToPost(platform, url, finalUrl, retrievedAt, lookbackHours, now(), html, oembedText) : null;
  if (!post && deps.metaBrowser && remaining(ctx, now()) > 16000) {
    try {
      const rendered = await deps.metaBrowser.readPage(url, 15000, ctx.signal);
      post = metaPageToPost(platform, url, rendered.finalUrl, retrievedAt, lookbackHours, now(), rendered.html, undefined);
      if (post) warnings.push('body from anonymous browser render');
      else failures.push('browser render had no readable body');
    } catch (e) {
      failures.push('browser: ' + String((e as Error)?.message ?? e).slice(0, 140));
    }
  }
  if (!post && !failures.length) failures.push('no readable body');
  return post ? { post, failures, warnings } : { failures, warnings };
}

export function createSocialService(deps: SocialDeps) {
  const now = deps.now ?? Date.now;
  const sessionStore = createWeiboSessionStore(deps.sessionOpener, now);

  async function searchWeiboPlatform(input: SocialSearchInput, ctx: SocialContext): Promise<SocialSearchResult> {
    const failures: string[] = [];
    const warnings: string[] = [];
    let session: { cookies: SimpleCookie[]; issuedAt: number; expiresAt: number } | undefined;
    try {
      session = await sessionStore.get(ctx.signal);
    } catch (e) {
      return { status: 'unavailable', platform: 'weibo', query: input.query, searchMode: 'native_latest', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: ['session: ' + String((e as Error)?.message ?? e).slice(0, 160)], warnings };
    }
    const unavailable = (reason: string): SocialSearchResult => ({ status: 'unavailable', platform: 'weibo', query: input.query, searchMode: 'native_latest', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: [reason], warnings });
    let raw: any[] = [];
    // Weiboの訪問者応答は不安定（成功・要認証・空応答が切替わる）。 bounded再試行で吸収する。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await searchWeibo(deps.weiboHttp, (session as { cookies: SimpleCookie[] }).cookies, input.query, input.limit, ctx.signal);
        raw = r.posts;
        failures.push(...r.failures);
        if (raw.length === 0 && r.failures.length === 0 && attempt < 2 && remaining(ctx, now()) > 5000) {
          failures.push('transient empty first page; retrying once');
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        break;
      } catch (e) {
        if (e instanceof WeiboAuthError && attempt < 2) {
          sessionStore.invalidate(session as { cookies: SimpleCookie[]; issuedAt: number; expiresAt: number });
          failures.push('session rejected (ok:-100); renewing');
          try {
            session = await sessionStore.get(ctx.signal);
            continue;
          } catch (e2) {
            return unavailable('session renewal: ' + String((e2 as Error)?.message ?? e2).slice(0, 160));
          }
        }
        if (e instanceof WeiboRateLimitedError) return unavailable('rate limited (429)');
        if (e instanceof WeiboAuthError) return unavailable('session rejected repeatedly (ok:-100)');
        throw e;
      }
    }
    const retrievedAt = new Date(now()).toISOString();
    const items: SocialPost[] = [];
    let matchedInWindow = 0;
    let unknownTime = 0;
    let excluded = 0;
    for (const post of raw) {
      if (remaining(ctx, now()) <= 1000 || items.length >= input.limit) break;
      const item = weiboRawToPost(post, retrievedAt, input.lookbackHours, now());
      if (item.inRequestedWindow === false) { excluded++; continue; }
      if (item.inRequestedWindow === null) unknownTime++;
      else matchedInWindow++;
      items.push(item);
    }
    const status = items.length ? (failures.length || unknownTime ? 'partial' : 'ok') : (failures.length ? 'unavailable' : 'empty');
    return { status, platform: 'weibo', query: input.query, searchMode: 'native_latest', items, matchedInWindow, unknownTime, excluded, failures, warnings };
  }

  async function searchMetaPlatform(input: SocialSearchInput, ctx: SocialContext): Promise<SocialSearchResult> {
    const failures: string[] = [];
    const warnings: string[] = ['meta discovery depends on the web index; not a realtime in-app search'];
    const { urls, failures: discoFailures } = await discoverMetaPosts(deps.webSearch, input.platform, input.query, input.limit, input.lookbackHours, ctx.signal);
    failures.push(...discoFailures);
    const items: SocialPost[] = [];
    let matchedInWindow = 0;
    let unknownTime = 0;
    let excluded = 0;
    for (const url of urls) {
      if (ctx.signal.aborted || remaining(ctx, now()) <= 2000 || items.length >= input.limit) break;
      const { post, failures: f, warnings: w } = await fetchMetaPost(deps, input.platform, url, input.lookbackHours, ctx);
      failures.push(...f.map((m) => url + ': ' + m));
      warnings.push(...w);
      if (!post) continue;
      if (post.inRequestedWindow === false) { excluded++; continue; }
      if (post.inRequestedWindow === null) unknownTime++;
      else matchedInWindow++;
      items.push(post);
    }
    const status = items.length ? (failures.length || unknownTime ? 'partial' : 'ok') : (failures.length && urls.length === 0 && failures.some((f) => f.startsWith('discovery:')) && items.length === 0 && discoFailures.length && urls.length === 0 ? 'empty' : (failures.length ? 'partial' : 'empty'));
    const finalStatus = items.length ? status : (failures.some((f) => /rate limited|static fetch|browser/.test(f)) ? 'unavailable' : 'empty');
    return { status: finalStatus, platform: input.platform, query: input.query, searchMode: 'web_index', items, matchedInWindow, unknownTime, excluded, failures, warnings };
  }

  return {
    async search(rawInput: SocialSearchInput, ctx: SocialContext): Promise<SocialSearchResult> {
      const input = SocialSearchInputSchema.parse(rawInput);
      const result = input.platform === 'weibo'
        ? await searchWeiboPlatform(input, ctx)
        : await searchMetaPlatform(input, ctx);
      return SocialSearchResultSchema.parse(result);
    },
    async fetch(rawInput: SocialFetchInput, ctx: SocialContext): Promise<SocialFetchResult> {
      const input = SocialFetchInputSchema.parse(rawInput);
      const failures: string[] = [];
      const warnings: string[] = [];
      const bid = extractWeiboBid(input.url);
      // Weibo 既知投稿
      if (bid) {
        try {
          const status = await fetchWeiboStatus(deps.weiboHttp, bid, ctx.signal);
          const retrievedAt = new Date(now()).toISOString();
          let post = weiboRawToPost(status, retrievedAt, 2160, now());
          post = await enrichWeiboPost(deps, { ...post, requestedUrl: input.url }, String(status?.bid ?? bid), input.commentLimit, ctx);
          post.url = 'https://m.weibo.cn/detail/' + post.id;
          const result = { status: 'ok' as const, post, failures, warnings: [...warnings, ...post.warnings] };
          return SocialFetchResultSchema.parse({ ...result, post: { ...post, warnings: [] } });
        } catch (e) {
          if (e instanceof WeiboRateLimitedError) return { status: 'unavailable', failures: ['rate limited (429)'], warnings };
          return { status: 'unavailable', failures: ['weibo fetch: ' + String((e as Error)?.message ?? e).slice(0, 160)], warnings };
        }
      }
      // Meta 既知投稿
      const platform = detectMetaPlatform(input.url);
      if (!platform || platform === 'weibo') {
        return { status: 'unavailable', failures: ['unsupported post url'], warnings };
      }
      const { post, failures: f, warnings: w } = await fetchMetaPost(deps, platform, input.url, 2160, ctx);
      failures.push(...f);
      warnings.push(...w);
      if (input.commentLimit > 0 && post) {
        post.comments = { state: 'unsupported', order: 'none', items: [], reason: 'meta comments are out of scope' };
        warnings.push('commentLimit ignored for meta platforms');
      }
      if (!post) return { status: 'unavailable', failures, warnings };
      return SocialFetchResultSchema.parse({ status: failures.length ? 'partial' : 'ok', post, failures, warnings });
    },
    /** 国地域provider用：Weibo検索上位のコメント補完。 */
    async enrichWeiboTop(items: SocialPost[], commentLimit: number, ctx: SocialContext): Promise<SocialPost[]> {
      return Promise.all(items.map((item) => enrichWeiboPost(deps, item, item.id, commentLimit, ctx)));
    },
  };
}

export type SocialService = ReturnType<typeof createSocialService>;
