import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import type { EvidenceDetail } from '../detail.js';
import { normalizeEvidence } from '../evidence.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';

/** 鍵なしで公開投稿に届く取得先。順序は応答の安定したものから。 */
export const FEDIVERSE_TAG_SOURCES: ReadonlyArray<{ kind: 'misskey' | 'mastodon'; host: string }> = [
  { kind: 'misskey', host: 'https://misskey.io' },
  { kind: 'mastodon', host: 'https://mstdn.jp' },
  { kind: 'mastodon', host: 'https://fedibird.com' },
  { kind: 'mastodon', host: 'https://mastodon.xyz' },
];

const stripTag = (token: string): string => token.replace(/^#+/, '').trim();

/** 計画クエリから単語タグを最大3件取り出す。空白を含む語は使わない。 */
export function extractFediverseTags(input: ProviderInput): string[] {
  const planned = input.queries.find((q) => q.providerId === 'fediverse')?.query
    ?? [input.region.name, input.request.query?.trim()].filter(Boolean).join(' ');
  const tags: string[] = [];
  for (const token of planned.split(/\s+/)) {
    const tag = stripTag(token);
    if (tag.length >= 2 && !tags.includes(tag) && tags.length < 3) tags.push(tag);
  }
  return tags;
}

export interface FediversePost { url: string; title: string; text: string; author: string; language?: string; publishedAt?: string; }

export function parseMisskeyNotes(data: unknown, host: string): FediversePost[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((note): FediversePost[] => {
    if (!note || typeof note !== 'object') return [];
    const n = note as Record<string, unknown>;
    if (typeof n.id !== 'string' || typeof n.text !== 'string' || !n.text.trim()) return [];
    const user = (n.user && typeof n.user === 'object' ? n.user : {}) as Record<string, unknown>;
    const username = typeof user.username === 'string' ? user.username : 'unknown';
    const createdAt = typeof n.createdAt === 'string' ? n.createdAt : undefined;
    return [{
      url: host + '/notes/' + n.id,
      title: n.text.trim().slice(0, 120),
      text: n.text.trim().slice(0, 1000),
      author: username + '@' + host.replace(/^https?:\/\//, ''),
      publishedAt: createdAt,
    }];
  });
}

export function parseMastodonStatuses(data: unknown): FediversePost[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((status): FediversePost[] => {
    if (!status || typeof status !== 'object') return [];
    const s = status as Record<string, unknown>;
    const url = typeof s.url === 'string' ? s.url : undefined;
    const content = typeof s.content === 'string' ? s.content : '';
    const text = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!url || !text) return [];
    const account = (s.account && typeof s.account === 'object' ? s.account : {}) as Record<string, unknown>;
    const acct = typeof account.acct === 'string' ? account.acct : 'unknown';
    const createdAt = typeof s.created_at === 'string' ? s.created_at : undefined;
    const language = typeof s.language === 'string' ? s.language : undefined;
    return [{ url, title: text.slice(0, 120), text: text.slice(0, 1000), author: acct, language, publishedAt: createdAt }];
  });
}

function toItems(posts: FediversePost[], providerId: string, input: ProviderInput, now: Date): AcquisitionItem[] {
  return posts.map((post, index) => {
    const evidence = normalizeEvidence({
      url: post.url, title: post.title, excerpt: post.text, publisher: post.author,
      sourceType: 'social', ...(post.language ? { language: post.language } : {}), publishedAt: post.publishedAt,
      primarySource: false, latencyClass: 'realtime',
    }, input.region, now);
    const detail: EvidenceDetail = {
      evidenceId: evidence.id,
      providerId,
      providerItemId: post.url,
      sourceRecordUrl: post.url,
      contentKind: 'excerpt',
      ...(post.language ? { language: post.language } : {}),
      blocks: [{ index, text: post.text }],
      structuredData: { author: post.author },
      publishedAt: post.publishedAt,
      retrievedAt: now.toISOString(),
      timeBasis: 'provider_posted',
      geographyBasis: 'unknown',
      sourceStatus: 'unverified',
      contentTruncated: post.text.length >= 1000,
    };
    return [{ evidence, detail }];
  }).flat();
}

async function postJson(fetchFn: GdeltFetch, url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ProviderHttpError(res.status, undefined, 'Fediverse HTTP ' + res.status);
  return res.json();
}

export function createFediverseProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'fediverse', areas: ['social_observations'], latencyClass: 'near_realtime', defaultTtlSeconds: 300,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal): Promise<{ items: AcquisitionItem[]; coverage?: string[]; gaps?: { area: string; reason: string }[] }> {
      if (!input.request.includeSocial) return { items: [], coverage: ['social_observations'] };
      const tags = extractFediverseTags(input);
      if (tags.length === 0) return { items: [], coverage: ['social_observations'], gaps: [{ area: 'social_observations', reason: 'no usable tag from query' }] };
      const now = new Date();
      const items: AcquisitionItem[] = [];
      const gaps: { area: string; reason: string }[] = [];
      for (const source of FEDIVERSE_TAG_SOURCES) {
        if (signal.aborted) break;
        for (const tag of tags) {
          if (signal.aborted) break;
          try {
            if (source.kind === 'misskey') {
              const data = await postJson(runFetch, source.host + '/api/notes/search-by-tag', { tag, limit: 10 }, signal);
              items.push(...toItems(parseMisskeyNotes(data, source.host), 'fediverse', input, now));
            } else {
              const res = await fetchProviderResponse(source.host + '/api/v1/timelines/tag/' + encodeURIComponent(tag) + '?limit=10', { sourceId: 'fediverse', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
              items.push(...toItems(parseMastodonStatuses(await res.json()), 'fediverse', input, now));
            }
          } catch (error) {
            if (signal.aborted) break;
            gaps.push({ area: 'social_observations', reason: source.host + ' tag ' + tag + ': ' + String((error as Error)?.message ?? error).slice(0, 160) });
          }
          if (items.length >= 30) break;
        }
        if (items.length >= 30) break;
      }
      return { items: items.slice(0, 30), coverage: ['social_observations'], ...(gaps.length > 0 ? { gaps } : {}) };
    },
  };
}
