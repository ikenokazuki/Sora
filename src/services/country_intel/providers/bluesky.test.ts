import { describe, expect, test } from 'bun:test';
import { BLUESKY_JETSTREAM_ENDPOINT, createBlueskyProvider, parseBlueskyEvent } from './bluesky.js';

const envelope = {
  $type: 'message',
  payload: {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did: 'did:plc:example',
    seq: 1,
    time: '2026-09-22T00:00:00Z',
    operation: 'create',
    collection: 'app.bsky.feed.post',
    rkey: 'example',
    record: { $type: 'app.bsky.feed.post', createdAt: '2026-09-22T00:00:00Z', text: 'New update', langs: ['en'] },
  },
};

describe('bluesky', () => {
  test('language does not establish the event country', () => {
    const result = parseBlueskyEvent(envelope, '2026-09-22T00:00:01Z');
    expect(result?.geographyBasis).toBe('unknown');
    expect(result?.language).toBe('en');
    expect(result?.providerItemId).toBe('did:plc:example/example');
  });

  test('deletes and non-post collections are not records', () => {
    const deleted = { payload: { collection: 'app.bsky.feed.post', operation: 'delete', did: 'did:plc:x', rkey: 'y' } };
    expect(parseBlueskyEvent(deleted, '2026-09-22T00:00:01Z')).toBeUndefined();
    const liked = { payload: { collection: 'app.bsky.feed.like', operation: 'create', did: 'did:plc:x', rkey: 'y', record: { text: 'x' } } };
    expect(parseBlueskyEvent(liked, '2026-09-22T00:00:01Z')).toBeUndefined();
    expect(parseBlueskyEvent(null, '2026-09-22T00:00:01Z')).toBeUndefined();
  });

  test('unconfigured social reports not_configured instead of silence', async () => {
    const provider = createBlueskyProvider();
    const region = { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' } as const;
    const quiet = await provider.run({ request: { region: 'CN' } as never, region, queries: [] }, new AbortController().signal);
    expect(quiet.items).toEqual([]);
    expect(quiet.status).toBeUndefined();
    const noisy = await provider.run({ request: { region: 'CN', includeSocial: true } as never, region, queries: [] }, new AbortController().signal);
    expect(noisy.status).toBe('unavailable');
    expect(noisy.errorCode).toBe('BLUESKY_NOT_CONFIGURED');
  });

  test('uses the official v2 endpoint', () => {
    expect(BLUESKY_JETSTREAM_ENDPOINT).toContain('jetstream.');
  });
});
