import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { buildSoraMcpInstructions, createMcpServer, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { createYoutubeRoutes } from './routes/youtube.js';
import { YoutubeInputError } from './services/youtube.js';
import { generateOpenApiDocument } from './types.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

describe('youtube module is on by default', () => {
  test('unset, all and naming it enable it, and a list without it does not', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('youtube')).toBe(true);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('youtube')).toBe(true);
    process.env.ENABLED_MODULES = 'web,youtube';
    expect(isModuleActive('youtube')).toBe(true);
    process.env.ENABLED_MODULES = 'web';
    expect(isModuleActive('youtube')).toBe(false);
  });
});

const post = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/youtube/transcript', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 字幕・題名はすべてテスト用の作り物。
const fakeResult = {
  found: true,
  videoId: 'abcdefghijk',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: 'テストの動画',
  transcript: { status: 'ok' as const, source: 'auto' as const, language: 'ja', text: '[0:00] てすと' },
  availableTracks: [],
};

describe('MCP tool', () => {
  test('is registered by default as a deferred youtube tool, and absent when the module is left out', () => {
    delete process.env.ENABLED_MODULES;
    const entry = toolCatalogOf(createMcpServer()).get('get_youtube_transcript');
    expect(entry?.category).toBe('youtube');
    expect(entry?.handle.enabled).toBe(false);
    expect(toolCatalogOf(createMcpServer({ modules: ['web'], deferTools: false })).has('get_youtube_transcript')).toBe(false);
  });

  test('lists with a required url, and a call returns the transcript as JSON or a YouTube error', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          videoDetails: { title: 'テストの動画MCP', author: 'テスト投稿者', lengthSeconds: '60', shortDescription: '' },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=ja&kind=asr', languageCode: 'ja', kind: 'asr', name: { simpleText: '日本語 (自動生成)' } }] } },
        }));
      }
      return new Response(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'てすと' }] }] }));
    }) as unknown as typeof fetch;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'youtube-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_youtube_transcript') as any;
      expect(tool.inputSchema.required).toEqual(['url']);
      const res = await client.callTool({ name: 'get_youtube_transcript', arguments: { url: 'https://youtu.be/mcpTest0001' } }) as any;
      expect(JSON.parse(res.content[0].text)).toMatchObject({
        found: true,
        videoId: 'mcpTest0001',
        title: 'テストの動画MCP',
        transcript: { status: 'ok', source: 'auto', language: 'ja', text: '[0:00] てすと' },
      });
      const bad = await client.callTool({ name: 'get_youtube_transcript', arguments: { url: 'https://example.com/x' } }) as any;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('YouTube error');
    } finally {
      globalThis.fetch = saved;
      await client.close();
      await server.close();
    }
  });

  test('search_tools finds it by YouTube 字幕 and enables it for the session', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'youtube-defer-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('get_youtube_transcript');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: 'YouTube 字幕' } }) as any;
      expect(found.content[0].text).toContain('get_youtube_transcript');
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('get_youtube_transcript');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('the instructions mention it only when the module is active', () => {
    expect(buildSoraMcpInstructions(['all'])).toContain('get_youtube_transcript');
    // 動画を探すときと調べものでは、検索の側の指定（既定は 0）を使うよう案内する
    expect(buildSoraMcpInstructions(['all'])).toContain('search_video transcripts');
    expect(buildSoraMcpInstructions(['all'])).toContain('search_deep videos');
    expect(buildSoraMcpInstructions(['youtube'])).not.toContain('search_video');
    expect(buildSoraMcpInstructions(['web'])).not.toContain('get_youtube_transcript');
  });
});

describe('REST /youtube/transcript', () => {
  test('validates the body, answers, and maps errors to 400 and a retryable 502', async () => {
    const ok = new Hono().route('/', createYoutubeRoutes(async () => fakeResult));
    expect(await (await post(ok, { url: 'abcdefghijk' })).json()).toMatchObject({ found: true, transcript: { status: 'ok' } });
    expect((await post(ok, {})).status).toBe(400);
    expect((await post(ok, '{broken')).status).toBe(400);
    expect((await post(ok, { url: 'abcdefghijk', maxChars: 0 })).status).toBe(400);

    const notVideo = new Hono().route('/', createYoutubeRoutes(async () => { throw new YoutubeInputError('url must be a YouTube video URL or an 11-character video ID'); }));
    const bad = await post(notVideo, { url: 'https://example.com/' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_INPUT' });

    const down = new Hono().route('/', createYoutubeRoutes(async () => { throw new Error('YouTube request failed: fetch failed'); }));
    const res = await post(down, { url: 'abcdefghijk' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'YOUTUBE_UPSTREAM_ERROR', retryable: true });
  });

  test('is mounted on the app, and listed in OpenAPI and GET /', async () => {
    expect((await post(app, {})).status).toBe(400);
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/youtube/transcript'].post.requestBody.content['application/json'].schema.required).toEqual(['url']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /youtube/transcript');
  });
});

const postChannel = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/youtube/channel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// チャンネル名・題名はすべてテスト用の作り物。
const fakeChannelResult = {
  found: true,
  channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
  title: 'テストチャンネル',
  url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
  videos: [{ videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'テストの動画' }],
};

describe('REST /youtube/channel', () => {
  test('validates the body, passes it on, and maps errors to 400 and a retryable 502', async () => {
    let seen: unknown;
    const ok = new Hono().route('/', createYoutubeRoutes(undefined, async (input) => { seen = input; return fakeChannelResult; }));
    expect(await (await postChannel(ok, { url: '@YouTube', limit: 3 })).json()).toMatchObject({ found: true, channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', videos: [{ videoId: 'abcdefghijk' }] });
    expect(seen).toEqual({ url: '@YouTube', limit: 3 });
    expect((await postChannel(ok, {})).status).toBe(400);
    expect((await postChannel(ok, '{broken')).status).toBe(400);
    expect((await postChannel(ok, { url: '@YouTube', limit: 0 })).status).toBe(400);
    expect((await postChannel(ok, { url: '@YouTube', limit: 16 })).status).toBe(400);

    const notChannel = new Hono().route('/', createYoutubeRoutes(undefined, async () => { throw new YoutubeInputError('url must be a YouTube channel URL, an @handle or a channel ID (UC…)'); }));
    const bad = await postChannel(notChannel, { url: 'https://example.com/' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_INPUT' });

    const down = new Hono().route('/', createYoutubeRoutes(undefined, async () => { throw new Error('YouTube request failed: feed HTTP 429'); }));
    const res = await postChannel(down, { url: '@YouTube' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'YOUTUBE_UPSTREAM_ERROR', retryable: true });
  });

  test('is mounted on the app, and listed in OpenAPI and GET /', async () => {
    expect((await postChannel(app, {})).status).toBe(400);
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/youtube/channel'].post.requestBody.content['application/json'].schema.required).toEqual(['url']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /youtube/channel');
  });
});
