import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import type { EvidenceDetail } from '../detail.js';

export const BLUESKY_JETSTREAM_ENDPOINT = 'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents';

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

export interface BlueskyCollectionOptions {
  dids: string[];
  endpoint?: string;
  onRecord: (detail: EvidenceDetail) => Promise<void> | void;
  onDelete?: (did: string, rkey: string) => void;
  onGap?: (reason: string) => void;
}

export function startBlueskyCollection(options: BlueskyCollectionOptions): { stop(): void } {
  let stopped = false;
  let socket: WebSocket | undefined;
  let backoffMs = 2000;
  let lastCursor: string | undefined;
  const params = new URLSearchParams({ collections: 'app.bsky.feed.post', kinds: 'commit' });
  for (const did of options.dids) params.append('dids', did);
  const base = options.endpoint ?? BLUESKY_JETSTREAM_ENDPOINT;
  const connect = (): void => {
    if (stopped) return;
    const url = lastCursor ? base + '?' + params.toString() + '&cursor=' + encodeURIComponent(lastCursor) : base + '?' + params.toString();
    try {
      socket = new WebSocket(url, ['xrpc.v1.json']);
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onmessage = (event) => {
      if (stopped) return;
      const raw = String(event.data ?? '');
      if (raw.length > 1024 * 1024) { options.onGap?.('oversize message dropped'); return; }
      let envelope: BlueskyEnvelope;
      try { envelope = JSON.parse(raw) as BlueskyEnvelope; } catch { return; }
      const cursor = (envelope.payload as { cursor?: unknown })?.cursor;
      if (typeof cursor === 'number' || typeof cursor === 'string') lastCursor = String(cursor);
      if (envelope.payload?.operation === 'delete' && typeof envelope.payload.did === 'string' && typeof envelope.payload.rkey === 'string') {
        options.onDelete?.(envelope.payload.did, envelope.payload.rkey);
        return;
      }
      const detail = parseBlueskyEvent(envelope, new Date().toISOString());
      if (detail) void Promise.resolve(options.onRecord(detail)).catch(() => undefined);
    };
    socket.onclose = () => { scheduleReconnect(); };
    socket.onerror = () => { try { socket?.close(); } catch { /* reconnect handles */ } };
  };
  const scheduleReconnect = (): void => {
    if (stopped) return;
    options.onGap?.('jetstream reconnect');
    setTimeout(() => { backoffMs = Math.min(backoffMs * 2, 30000); connect(); }, backoffMs);
  };
  connect();
  return { stop(): void { stopped = true; try { socket?.close(); } catch { /* already closed */ } } };
}

export function createBlueskyProvider(): CountryIntelProvider {
  return {
    id: 'bluesky', areas: ['social_observations'], latencyClass: 'near_realtime', defaultTtlSeconds: 300,
    async run(input: ProviderInput, _signal: AbortSignal): Promise<{ items: AcquisitionItem[]; coverage?: string[]; status?: 'unavailable'; errorCode?: string }> {
      void _signal;
      if (!input.request.includeSocial) return { items: [], coverage: ['social_observations'] };
      const dids = (process.env.SORA_BLUESKY_DIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (dids.length === 0) return { items: [], coverage: ['social_observations'], status: 'unavailable', errorCode: 'BLUESKY_NOT_CONFIGURED' };
      return { items: [], coverage: ['social_observations'], status: 'unavailable', errorCode: 'BLUESKY_NO_REQUEST_HISTORY' };
    },
  };
}
