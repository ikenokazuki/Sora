import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import type { EvidenceDetail } from '../detail.js';
import { normalizeEvidence } from '../evidence.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';

export const BLUESKY_JETSTREAM_ENDPOINT = 'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents';
export const BLUESKY_SEARCH_URL = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';

export interface BlueskyRecord { text?: unknown; createdAt?: unknown; langs?: unknown; }
export interface BlueskyCommit { operation?: unknown; collection?: unknown; did?: unknown; rkey?: unknown; time?: unknown; cursor?: unknown; record?: BlueskyRecord; }
export interface BlueskyEnvelope { payload?: { collection?: unknown; operation?: unknown; did?: unknown; rkey?: unknown; time?: unknown; record?: BlueskyRecord } & BlueskyCommit; }

export function parseBlueskyEvent(envelope: unknown, retrievedAt: string): EvidenceDetail | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const payload = (envelope as BlueskyEnvelope).payload;
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.collection !== 'app.bsky.feed.post') return undefined;
  if (payload.operation !== 'create' && payload.operation !== 'update') return undefined;
  const record = payload.record;
  const text = record && typeof record.text === 'string' ? record.text : undefined;
  if (!text) return undefined;
  const did = typeof payload.did === 'string' ? payload.did : undefined;
  const rkey = typeof payload.rkey === 'string' ? payload.rkey : undefined;
  if (!did || !rkey) return undefined;
  const langs = Array.isArray(record?.langs) ? record.langs.filter((l): l is string => typeof l === 'string') : [];
  const createdAt = typeof record?.createdAt === 'string' ? record.createdAt : undefined;
  return {
    evidenceId: 'bsky:' + did + '/' + rkey,
    providerId: 'bluesky',
    providerItemId: did + '/' + rkey,
    sourceRecordUrl: 'https://bsky.app/profile/' + did + '/post/' + rkey,
    contentKind: 'excerpt',
    ...(langs[0] ? { language: langs[0] } : {}),
    blocks: [{ index: 0, text }],
    structuredData: { did, operation: payload.operation },
    publishedAt: createdAt,
    retrievedAt,
    timeBasis: 'provider_posted',
    geographyBasis: 'unknown',
    sourceStatus: 'unverified',
    contentTruncated: false,
  };
}

export function buildBlueskySearchUrl(query: string, lang: string | undefined, limit = 25): string {
  const params = new URLSearchParams({ q: query, limit: String(limit), sort: 'latest' });
  if (lang) params.set('lang', lang);
  return BLUESKY_SEARCH_URL + '?' + params.toString();
}

export interface BlueskySearchPost {
  uri?: unknown;
  author?: { did?: unknown; handle?: unknown };
  record?: { text?: unknown; createdAt?: unknown; langs?: unknown };
}

export interface BlueskySearchFixture {
  posts?: BlueskySearchPost[];
}

function configuredDids(): string[] {
  return (process.env.SORA_BLUESKY_DIDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function parseBlueskySearchResponse(
  fixture: BlueskySearchFixture,
  input: ProviderInput,
  allowedDids: readonly string[] = [],
  now = new Date(),
): AcquisitionItem[] {
  const posts = Array.isArray(fixture.posts) ? fixture.posts : [];
  return posts.flatMap((post, index) => {
    if (!post || typeof post !== 'object') return [];
    const uri = typeof post.uri === 'string' ? post.uri : undefined;
    const author = post.author && typeof post.author === 'object' ? post.author : undefined;
    const did = author && typeof author.did === 'string' ? author.did : undefined;
    const handle = author && typeof author.handle === 'string' ? author.handle : undefined;
    const record = post.record && typeof post.record === 'object' ? post.record : undefined;
    const text = record && typeof record.text === 'string' ? record.text.trim() : '';
    if (!uri || !did || !text) return [];
    if (allowedDids.length > 0 && !allowedDids.includes(did)) return [];
    const rkey = uri.split('/').pop() || ('post-' + String(index));
    const url = 'https://bsky.app/profile/' + did + '/post/' + rkey;
    const langs = record && Array.isArray(record.langs)
      ? record.langs.filter((lang): lang is string => typeof lang === 'string')
      : [];
    const createdAt = record && typeof record.createdAt === 'string' ? record.createdAt : undefined;
    const evidence = normalizeEvidence({
      url, title: text.slice(0, 120), excerpt: text.slice(0, 1000), publisher: handle ?? did,
      sourceType: 'social', ...(langs[0] ? { language: langs[0] } : {}), publishedAt: createdAt,
      primarySource: false, latencyClass: 'realtime',
    }, input.region, now);
    const detail: EvidenceDetail = {
      evidenceId: evidence.id,
      providerId: 'bluesky',
      providerItemId: did + '/' + rkey,
      sourceRecordUrl: url,
      contentKind: 'excerpt',
      ...(langs[0] ? { language: langs[0] } : {}),
      blocks: [{ index, text }],
      structuredData: { did, ...(handle ? { handle } : {}) },
      publishedAt: createdAt,
      retrievedAt: now.toISOString(),
      timeBasis: 'provider_posted',
      geographyBasis: 'unknown',
      sourceStatus: 'unverified',
      contentTruncated: text.length > 1000,
    };
    return [{ evidence, detail }];
  });
}

export function createBlueskyProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'bluesky', areas: ['social_observations'], latencyClass: 'near_realtime', defaultTtlSeconds: 300,
    async run(input: ProviderInput, signal: AbortSignal): Promise<{ items: AcquisitionItem[]; coverage?: string[] }> {
      if (!input.request.includeSocial) return { items: [], coverage: ['social_observations'] };
      const query = [input.region.name, input.request.query?.trim()].filter(Boolean).join(' ');
      const url = buildBlueskySearchUrl(query, input.region.languages[0]);
      let res: Response;
      try {
        res = await fetchProviderResponse(url, { sourceId: 'bluesky', timeoutMs: 8000, format: 'json', signal, fetchFn: runFetch });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ProviderHttpError) throw error;
        throw new ProviderNetworkError(String(error));
      }
      const data = (await res.json()) as BlueskySearchFixture;
      if (!Array.isArray(data.posts)) throw new ProviderHttpError(502, undefined, 'Bluesky envelope missing posts');
      return { items: parseBlueskySearchResponse(data, input, configuredDids(), new Date()), coverage: ['social_observations'] };
    },
  };
}
