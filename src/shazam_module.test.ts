import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { buildSoraMcpInstructions, createMcpServer, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { createSongRecognitionRoutes } from './routes/song_recognition.js';
import { recognizeSignature, SongRecognitionInputError, type SongRecognitionOptions, type SongRecognitionResult } from './services/song_recognition.js';
import { DATA_URI_PREFIX, signatureUri } from './services/shazam_signature.js';
import { toneBursts } from './test_fixtures/audio.js';
import { generateOpenApiDocument } from './types.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

// 作り物の結果だけを使う
const fakeResult: SongRecognitionResult = {
  found: true, itunes: { id: '1700000001', type: 'song', title: 'テスト曲', artist: 'テスト歌手' }, itunesMatch: 'apple-id',
  shazam: { key: '900001', title: 'テスト曲', artist: 'テスト歌手' }, match: { songOffsetSec: 10, clipOffsetSec: 0 },
  attempts: [{ offsetSec: 0, durationSec: 12, matched: true }], audio: { bytes: 4, durationSec: 30, contentType: 'audio/mp4' },
};
const postJson = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/music/recognize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('shazam module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it; naming it does', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('shazam')).toBe(false);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('shazam')).toBe(false);
    process.env.ENABLED_MODULES = '*';
    expect(isModuleActive('shazam')).toBe(false);
    expect(isModuleActive('shazam', ['all'])).toBe(false);
    process.env.ENABLED_MODULES = ' All , Lyrics , Shazam ';
    expect(isModuleActive('shazam')).toBe(true);
    expect(isModuleActive('lyrics')).toBe(true);
    expect(isModuleActive('music')).toBe(true);
    expect(isModuleActive('shazam', ['shazam'])).toBe(true);
  });
});

describe('MCP tool', () => {
  test('is absent by default and under all, present and deferred when the module is named', () => {
    delete process.env.ENABLED_MODULES;
    expect(toolCatalogOf(createMcpServer({ deferTools: false })).has('recognize_song')).toBe(false);
    expect(toolCatalogOf(createMcpServer({ modules: ['all'], deferTools: false })).has('recognize_song')).toBe(false);
    const named = toolCatalogOf(createMcpServer({ modules: ['all', 'shazam'], deferTools: false }));
    expect(named.get('recognize_song')?.category).toBe('shazam');
    expect(toolCatalogOf(createMcpServer({ modules: ['shazam'] })).get('recognize_song')?.handle.enabled).toBe(false);
  });

  test('search_tools finds it by 楽曲認識, it requires url, and a bad url is an error result', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['shazam'] });
    const client = new Client({ name: 'shazam-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('recognize_song');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: '楽曲認識' } }) as any;
      expect(found.content[0].text).toContain('recognize_song');
      const tool = (await client.listTools()).tools.find((t) => t.name === 'recognize_song') as any;
      expect(tool.inputSchema.required).toEqual(['url']);
      const bad = await client.callTool({ name: 'recognize_song', arguments: { url: 'ftp://example.com/a.mp3' } }) as any;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('Song recognition error');
      const none = await client.callTool({ name: 'search_tools', arguments: { query: 'zzzqqq' } }) as any;
      expect(none.content[0].text).toContain('shazam');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('the instructions mention it only when the module is active', () => {
    expect(buildSoraMcpInstructions(['shazam'])).toContain('recognize_song');
    expect(buildSoraMcpInstructions(['all'])).not.toContain('recognize_song');
  });
});

describe('REST /music/recognize', () => {
  test('is a 404 MODULE_DISABLED that says how to enable it, by default and under all', async () => {
    delete process.env.ENABLED_MODULES;
    for (const value of [undefined, 'all']) {
      if (value) process.env.ENABLED_MODULES = value;
      const res = await postJson(app, { url: 'https://example.com/a.mp3' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.code).toBe('MODULE_DISABLED');
      expect(json.error).toContain('ENABLED_MODULES');
    }
  });

  test('when enabled it takes JSON or a multipart upload, validates, and maps failures', async () => {
    process.env.ENABLED_MODULES = 'all,shazam';
    let seen: SongRecognitionOptions | undefined;
    const ok = new Hono().route('/', createSongRecognitionRoutes(async (input) => { seen = input; return fakeResult; }));
    expect(await (await postJson(ok, { url: 'https://example.com/a.mp3', offsetSec: 8 })).json()).toMatchObject({ found: true, itunes: { id: '1700000001' } });
    expect(seen).toMatchObject({ url: 'https://example.com/a.mp3', offsetSec: 8 });
    expect((await postJson(ok, {})).status).toBe(400);
    expect((await postJson(ok, '{broken')).status).toBe(400);

    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'clip.m4a', { type: 'audio/mp4' }));
    form.append('offsetSec', '4');
    form.append('noCache', 'true');
    expect((await ok.request('/music/recognize', { method: 'POST', body: form })).status).toBe(200);
    // Bun は multipart のファイルの形式を拡張子から決めることがある（.m4a → audio/x-m4a）
    expect(seen?.audio?.contentType).toMatch(/^audio\//);
    expect([...(seen?.audio?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(seen).toMatchObject({ offsetSec: 4, noCache: true });
    const empty = new FormData();
    empty.append('offsetSec', '4');
    expect((await ok.request('/music/recognize', { method: 'POST', body: empty })).status).toBe(400);

    const wrong = new Hono().route('/', createSongRecognitionRoutes(async () => { throw new SongRecognitionInputError('url は http(s) の URL です'); }));
    expect((await postJson(wrong, { url: 'x' })).status).toBe(400);
    const down = new Hono().route('/', createSongRecognitionRoutes(async () => { throw new Error('Shazam HTTP 503 (request failed)'); }));
    const res = await postJson(down, { url: 'https://example.com/a.mp3' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'SONG_RECOGNITION_UPSTREAM_ERROR', retryable: true });
  });
});

const sigBody = () => {
  const { uri, sampleMs } = signatureUri(toneBursts(1000));
  return { signature: uri.slice(DATA_URI_PREFIX.length), sampleMs };
};
const postSig = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/music/recognize/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const upstream = (status: number) => (async () => new Response('no', { status })) as unknown as typeof fetch;

describe('REST /music/recognize/signature', () => {
  test('is a 404 MODULE_DISABLED by default and under all', async () => {
    delete process.env.ENABLED_MODULES;
    for (const value of [undefined, 'all']) {
      if (value) process.env.ENABLED_MODULES = value;
      const res = await postSig(app, sigBody());
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).code).toBe('MODULE_DISABLED');
    }
  });

  test('when enabled it validates the body and passes it on', async () => {
    process.env.ENABLED_MODULES = 'all,shazam';
    let seen: unknown;
    const ok = new Hono().route('/', createSongRecognitionRoutes(undefined, async (input) => { seen = input; return fakeResult; }));
    const body = sigBody();
    expect((await postSig(ok, { ...body, country: 'JP' })).status).toBe(200);
    expect(seen).toEqual({ ...body, country: 'JP' });
    for (const bad of [
      {}, { ...body, sampleMs: 2999 }, { ...body, sampleMs: 12001 }, { ...body, sampleMs: 12000.5 },
      { ...body, signature: 'A'.repeat(65537) }, { ...body, signature: 'not base64!' }, { ...body, country: 'japan' },
    ]) {
      expect((await postSig(ok, bad)).status).toBe(400);
    }
    expect((await postSig(ok, '{broken')).status).toBe(400);
  });

  test('a broken signature is 400 INVALID_INPUT without asking Shazam; Shazam refusals and outages are 502', async () => {
    process.env.ENABLED_MODULES = 'all,shazam';
    let sent = 0;
    const counting = (async () => { sent++; return Response.json({ matches: [] }); }) as unknown as typeof fetch;
    const real = new Hono().route('/', createSongRecognitionRoutes(undefined, (input) => recognizeSignature(input, { fetchFn: counting })));
    const body = sigBody();
    const flipped = Buffer.from(body.signature, 'base64');
    flipped[flipped.length - 1] ^= 1;
    for (const bad of [{ ...body, signature: flipped.toString('base64') }, { ...body, sampleMs: 11000 }, { ...body, signature: body.signature.slice(0, -1) }]) {
      const res = await postSig(real, bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('INVALID_INPUT');
    }
    expect(sent).toBe(0);
    for (const status of [403, 429, 503]) {
      const down = new Hono().route('/', createSongRecognitionRoutes(undefined, (input) => recognizeSignature(input, { fetchFn: upstream(status) })));
      const res = await postSig(down, body);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'SONG_RECOGNITION_UPSTREAM_ERROR', retryable: true });
    }
  });

  test('a match whose iTunes lookup is refused is 502 too, so the caller can retry it', async () => {
    process.env.ENABLED_MODULES = 'all,shazam';
    const hit = { matches: [{ offset: 1 }], track: { key: '900001', title: 'テスト曲', subtitle: 'テスト歌手', trackadamid: '1700000001' } };
    const itunesRefused = (async (url: string) => (url.startsWith('https://amp.shazam.com/') ? Response.json(hit) : new Response('no', { status: 403 }))) as unknown as typeof fetch;
    const real = new Hono().route('/', createSongRecognitionRoutes(undefined, (input) => recognizeSignature(input, { fetchFn: itunesRefused })));
    const res = await postSig(real, sigBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'SONG_RECOGNITION_UPSTREAM_ERROR', retryable: true, error: 'iTunes lookup failed' });
  });
});

describe('documentation follows the module', () => {
  test('OpenAPI and the endpoint list include /music/recognize only when it is enabled', async () => {
    delete process.env.ENABLED_MODULES;
    expect((generateOpenApiDocument() as any).paths['/music/recognize']).toBeUndefined();
    expect((generateOpenApiDocument() as any).paths['/music/recognize/signature']).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/music/recognize');
    process.env.ENABLED_MODULES = 'all,shazam';
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/music/recognize'].post.requestBody.content['application/json'].schema.required).toEqual(['url']);
    expect(doc.paths['/music/recognize'].post.requestBody.content['multipart/form-data'].schema.required).toEqual(['file']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /music/recognize');
    expect(doc.paths['/music/recognize/signature'].post.requestBody.content['application/json'].schema.required).toEqual(['signature', 'sampleMs']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /music/recognize/signature');
  });
});
