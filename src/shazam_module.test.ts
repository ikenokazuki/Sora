import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { buildSoraMcpInstructions, createMcpServer, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { createSongRecognitionRoutes } from './routes/song_recognition.js';
import { SongRecognitionInputError, type SongRecognitionOptions, type SongRecognitionResult } from './services/song_recognition.js';
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

describe('documentation follows the module', () => {
  test('OpenAPI and the endpoint list include /music/recognize only when it is enabled', async () => {
    delete process.env.ENABLED_MODULES;
    expect((generateOpenApiDocument() as any).paths['/music/recognize']).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/music/recognize');
    process.env.ENABLED_MODULES = 'all,shazam';
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/music/recognize'].post.requestBody.content['application/json'].schema.required).toEqual(['url']);
    expect(doc.paths['/music/recognize'].post.requestBody.content['multipart/form-data'].schema.required).toEqual(['file']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /music/recognize');
  });
});
