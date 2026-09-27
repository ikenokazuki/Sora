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

  test('omitted social stays silent without failure', async () => {
    const provider = createBlueskyProvider();
    const region = { id: 'country:CN', name: 'China', countryCode: 'CN' as string, languages: [] as string[], aliases: [] as string[], confidence: 'high' as const };
    const quiet = await provider.run({ request: { region: 'CN' } as never, region, queries: [] }, new AbortController().signal);
    expect(quiet.items).toEqual([]);
    expect(quiet.status).toBeUndefined();
  });

  test('uses the official v2 endpoint', () => {
    expect(BLUESKY_JETSTREAM_ENDPOINT).toContain('jetstream.');
  });
});

describe("bluesky search", () => {
  const region = { id: "country:CN", name: "China", countryCode: "CN" as string, languages: ["zh"] as string[], aliases: [] as string[], confidence: "high" as const };
  const inputFor = (includeSocial: boolean) => ({
    request: { region: "China", includeSocial } as never, region,
    queries: [{ pass: 1 as const, providerId: "bluesky", query: "China", topics: [], maxItems: 25 }],
  });
  const post = (did: string, text: string) => ({
    uri: "at://" + did + "/app.bsky.feed.post/abc123",
    author: { did, handle: "user.example" },
    record: { text, createdAt: "2026-09-21T00:00:00Z", langs: ["en"] },
  });
  const fetchOk = (posts: unknown[]) => (async () => Response.json({ posts })) as (url: string, init?: RequestInit) => Promise<Response>;

  test("search posts become social evidence with excerpts", async () => {
    const provider = createBlueskyProvider(fetchOk([post("did:plc:a", "Shanghai flood update")]));
    const result = await provider.run(inputFor(true), AbortSignal.timeout(2000));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.sourceType).toBe("social");
    expect(result.items[0].evidence?.publisher).toBe("user.example");
    expect(result.items[0].detail?.contentKind).toBe("excerpt");
    expect(result.items[0].detail?.blocks[0].text).toContain("Shanghai");
  });

  test("did allowlist filters authors", async () => {
    const previous = process.env.SORA_BLUESKY_DIDS;
    process.env.SORA_BLUESKY_DIDS = "did:plc:keep";
    try {
      const provider = createBlueskyProvider(fetchOk([post("did:plc:drop", "dropped"), post("did:plc:keep", "kept")]));
      const result = await provider.run(inputFor(true), AbortSignal.timeout(2000));
      expect(result.items).toHaveLength(1);
      expect(result.items[0].detail?.blocks[0].text).toBe("kept");
    } finally {
      if (previous === undefined) delete process.env.SORA_BLUESKY_DIDS;
      else process.env.SORA_BLUESKY_DIDS = previous;
    }
  });

  test("empty results succeed and http errors propagate", async () => {
    const empty = createBlueskyProvider(fetchOk([]));
    const result = await empty.run(inputFor(true), AbortSignal.timeout(2000));
    expect(result.items).toEqual([]);
    expect(result.status).toBeUndefined();
    const failing = createBlueskyProvider((async () => new Response("denied", { status: 401 })) as (url: string, init?: RequestInit) => Promise<Response>);
    await expect(failing.run(inputFor(true), AbortSignal.timeout(2000))).rejects.toThrow();
  });
});
