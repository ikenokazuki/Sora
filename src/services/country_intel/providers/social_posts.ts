import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import type { EvidenceDetail } from '../detail.js';
import type { IntelSocialPlatform } from '../types.js';
import type { SocialPost, SocialService } from '../../social/index.js';

export const SOCIAL_PLATFORMS: readonly IntelSocialPlatform[] = ['weibo', 'threads', 'instagram', 'facebook'];
export const SOCIAL_DEFAULT_LOOKBACK_HOURS = 24;
export const SOCIAL_MAX_QUERIES = 8;
export const SOCIAL_MAX_PER_PLATFORM = 2;
export const SOCIAL_MAX_URLS = 10;
export const SOCIAL_MAX_PER_SERVICE = 10;
export const SOCIAL_WEIBO_COMMENT_TOP = 2;
export const SOCIAL_WEIBO_COMMENT_LIMIT = 5;

export interface SocialPostsDeps {
  service?: SocialService;
}

function defaultQuery(input: ProviderInput): string {
  return input.request.query?.trim()
    || input.region.nativeName?.trim()
    || input.region.name?.trim()
    || '';
}

function planQueries(input: ProviderInput): Array<{ platform: IntelSocialPlatform; query: string }> {
  const explicit = input.request.social?.queries ?? [];
  const byPlatform = new Map<IntelSocialPlatform, string[]>();
  for (const q of explicit) {
    if (!SOCIAL_PLATFORMS.includes(q.platform)) throw new Error('unsupported social platform: ' + String(q.platform));
    const list = byPlatform.get(q.platform) ?? [];
    if (list.length < SOCIAL_MAX_PER_PLATFORM && !list.includes(q.query)) list.push(q.query);
    byPlatform.set(q.platform, list);
  }
  const platforms = input.request.social?.platforms?.length
    ? [...new Set(input.request.social.platforms)]
    : [...SOCIAL_PLATFORMS];
  for (const p of platforms) {
    if (!SOCIAL_PLATFORMS.includes(p)) throw new Error('unsupported social platform: ' + String(p));
  }
  const fallback = defaultQuery(input);
  const out: Array<{ platform: IntelSocialPlatform; query: string }> = [];
  for (const [platform, list] of byPlatform) for (const query of list) {
    if (out.length >= SOCIAL_MAX_QUERIES) break;
    out.push({ platform, query });
  }
  for (const platform of platforms) {
    if (out.length >= SOCIAL_MAX_QUERIES) break;
    if ((byPlatform.get(platform) ?? []).length > 0) continue;
    if (!fallback) continue;
    out.push({ platform, query: fallback });
  }
  return out.slice(0, SOCIAL_MAX_QUERIES);
}

export function socialPostToAcquisition(post: SocialPost, input: ProviderInput, now: Date): AcquisitionItem {
  const evidence = normalizeEvidence({
    url: post.url,
    title: post.text.slice(0, 120) || post.id,
    excerpt: post.text.slice(0, 2000),
    publisher: post.author ?? post.platform,
    sourceType: 'social',
    ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    primarySource: false,
    latencyClass: 'near_realtime',
  }, input.region, now);
  const comments = post.comments;
  const detail: EvidenceDetail = {
    evidenceId: evidence.id,
    providerId: 'social_posts',
    providerItemId: post.platform + ':' + post.id,
    sourceRecordUrl: post.url,
    contentKind: 'excerpt',
    blocks: [{ index: 0, text: post.text.slice(0, 2000) }],
    structuredData: {
      platform: post.platform,
      method: post.method,
      searchMode: post.searchMode ?? 'unknown',
      textKind: post.textKind,
      timeStatus: post.timeStatus,
      inRequestedWindow: post.inRequestedWindow,
      ...(post.metrics ? { metrics: post.metrics } : {}),
      ...(post.metricLabels ? { metricLabels: post.metricLabels } : {}),
      ...(comments ? { commentsState: comments.state, commentCount: comments.items.length } : {}),
      ...(post.quotedPost ? { quotedPost: post.quotedPost } : {}),
    },
    ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    retrievedAt: post.retrievedAt,
    timeBasis: post.publishedAt ? 'provider_posted' : 'retrieved',
    geographyBasis: 'unknown',
    sourceStatus: 'unverified',
    contentTruncated: post.truncated,
  };
  const item: AcquisitionItem = { evidence, detail, areas: ['social_observations'] as readonly string[] };
  if (comments && comments.state === 'fetched' && comments.items.length) {
    item.detail = {
      ...detail,
      blocks: [
        { index: 0, text: post.text.slice(0, 2000) },
        ...comments.items.slice(0, 5).map((c, i) => ({ index: i + 1, text: (c.author ? c.author + ': ' : '') + c.text.slice(0, 500) })),
      ],
      structuredData: {
        ...detail.structuredData,
        comments: comments.items.slice(0, 5),
      },
    };
  }
  return item;
}

export function createSocialPostsProvider(deps: SocialPostsDeps = {}): CountryIntelProvider {
  return {
    id: 'social_posts',
    areas: ['social_observations'],
    latencyClass: 'near_realtime',
    defaultTtlSeconds: 60,
    collectionWindowDays: 1,
    timeoutMs: 45000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (!input.request.includeSocial) return { items: [], coverage: ['social_observations:excluded'] };
      const service = deps.service ?? await loadProdService();
      const now = new Date();
      const deadlineAt = Date.now() + 45000;
      const ctx = { signal, deadlineAt };
      const lookbackHours = input.request.social?.lookbackHours ?? SOCIAL_DEFAULT_LOOKBACK_HOURS;
      const queries = planQueries(input);
      const items: AcquisitionItem[] = [];
      const gaps: { area: string; reason: string }[] = [];
      for (const q of queries) {
        if (signal.aborted || Date.now() >= deadlineAt - 1000 || items.length >= SOCIAL_MAX_PER_SERVICE * SOCIAL_PLATFORMS.length) break;
        try {
          const r = await service.search({ platform: q.platform, query: q.query, limit: SOCIAL_MAX_PER_SERVICE, lookbackHours }, ctx);
          let posts = r.items;
          if (q.platform === 'weibo' && posts.length) {
            const top = [...posts].sort((a, b) => ((b.metrics?.comments ?? 0) - (a.metrics?.comments ?? 0))).slice(0, SOCIAL_WEIBO_COMMENT_TOP);
            const enriched = await service.enrichWeiboTop(top, SOCIAL_WEIBO_COMMENT_LIMIT, ctx);
            const byId = new Map(enriched.map((p) => [p.id, p]));
            posts = posts.map((p) => byId.get(p.id) ?? p);
          }
          for (const post of posts) items.push(socialPostToAcquisition(post, input, now));
          if (r.status === 'unavailable' || r.status === 'partial') {
            gaps.push({ area: 'social_observations', reason: q.platform + ' ' + q.query + ': ' + r.status + (r.failures.length ? ' ' + r.failures[0].slice(0, 120) : '') });
          }
        } catch (e) {
          if (signal.aborted) break;
          gaps.push({ area: 'social_observations', reason: q.platform + ' ' + q.query + ': ' + String((e as Error)?.message ?? e).slice(0, 140) });
        }
      }
      const urls = (input.request.social?.urls ?? []).slice(0, SOCIAL_MAX_URLS);
      for (const url of urls) {
        if (signal.aborted || Date.now() >= deadlineAt - 1000) break;
        try {
          const r = await service.fetch({ url, commentLimit: SOCIAL_WEIBO_COMMENT_LIMIT }, ctx);
          if (r.post) items.push(socialPostToAcquisition(r.post, input, now));
          else gaps.push({ area: 'social_observations', reason: url + ': ' + (r.failures[0] ?? 'no post').slice(0, 120) });
        } catch (e) {
          if (signal.aborted) break;
          gaps.push({ area: 'social_observations', reason: url + ': ' + String((e as Error)?.message ?? e).slice(0, 140) });
        }
      }
      return { items, coverage: ['social_observations'], ...(gaps.length ? { gaps } : {}) };
    },
  };
}

async function loadProdService(): Promise<SocialService> {
  const { createSocialService } = await import('../../social/index.js');
  const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('../../social/transport.js');
  return createSocialService({
    weiboHttp: createProdWeiboHttp(),
    sessionOpener: createProdSessionOpener(),
    metaHttp: createProdMetaHttp(),
    metaBrowser: createProdMetaBrowser(),
    webSearch: createProdWebSearch(),
  });
}
