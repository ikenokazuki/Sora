import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { buildSoraMcpInstructions, createMcpServer, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { createLyricsRoutes } from './routes/lyrics.js';
import { generateOpenApiDocument } from './types.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

describe('lyrics module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('lyrics')).toBe(false);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('lyrics')).toBe(false);
    process.env.ENABLED_MODULES = '*';
    expect(isModuleActive('lyrics')).toBe(false);
    expect(isModuleActive('lyrics', ['all'])).toBe(false);
  });

  test('naming it enables it, alone or next to all', () => {
    process.env.ENABLED_MODULES = 'lyrics';
    expect(isModuleActive('lyrics')).toBe(true);
    process.env.ENABLED_MODULES = ' All , Lyrics ';
    expect(isModuleActive('lyrics')).toBe(true);
    expect(isModuleActive('music')).toBe(true);
    expect(isModuleActive('lyrics', ['all', 'lyrics'])).toBe(true);
    expect(isModuleActive('lyrics', ['lyrics'])).toBe(true);
  });

  test('the other modules keep their meaning', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('music')).toBe(true);
    process.env.ENABLED_MODULES = 'lyrics';
    expect(isModuleActive('music')).toBe(false);
    expect(isModuleActive('web', ['all'])).toBe(true);
  });
});

const post = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/lyrics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 歌詞の本文は使わない。以下はすべてテスト用の作り物。
const fakeResult = { found: true, track: { title: 'テスト曲', artist: 'テスト歌手' }, lyrics: 'らら', source: 'lrclib' as const, candidates: [], notice: 'n' };

describe('MCP tool', () => {
  test('is absent by default and under all, present when the module is named', () => {
    delete process.env.ENABLED_MODULES;
    expect(toolCatalogOf(createMcpServer({ deferTools: false })).has('get_lyrics')).toBe(false);
    expect(toolCatalogOf(createMcpServer({ modules: ['all'], deferTools: false })).has('get_lyrics')).toBe(false);
    const named = toolCatalogOf(createMcpServer({ modules: ['all', 'lyrics'], deferTools: false }));
    expect(named.get('get_lyrics')?.category).toBe('lyrics');
    expect(named.has('search_song')).toBe(true);
  });

  test('is deferred like the other music tools until search_tools activates it', () => {
    const entry = toolCatalogOf(createMcpServer({ modules: ['lyrics'] })).get('get_lyrics');
    expect(entry?.handle.enabled).toBe(false);
  });

  test('lists with a required title, and a call returns the lookup as JSON', async () => {
    const saved = globalThis.fetch;
    const artist = 'テスト歌手MCP'; const title = 'テスト曲MCP';
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 9, trackName: title, artistName: artist, albumName: 'a', instrumental: false, plainLyrics: 'らら\nるる' }]))) as unknown as typeof fetch;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['lyrics'], deferTools: false });
    const client = new Client({ name: 'lyrics-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_lyrics') as any;
      expect(tool.inputSchema.required).toEqual(['title']);
      const res = await client.callTool({ name: 'get_lyrics', arguments: { title, artist } }) as any;
      expect(JSON.parse(res.content[0].text)).toMatchObject({ found: true, lyrics: 'らら\nるる', source: 'lrclib' });
      const none = await client.callTool({ name: 'search_tools', arguments: { query: 'zzzqqq' } }) as any;
      expect(none.content[0].text).toContain('lyrics');
    } finally {
      globalThis.fetch = saved;
      await client.close();
      await server.close();
    }
  });

  test('search_tools finds it by 歌詞 and enables it for the session', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['lyrics'] });
    const client = new Client({ name: 'lyrics-defer-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('get_lyrics');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: '歌詞' } }) as any;
      expect(found.content[0].text).toContain('get_lyrics');
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('get_lyrics');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('the instructions mention it only when the module is active', () => {
    expect(buildSoraMcpInstructions(['lyrics'])).toContain('get_lyrics');
    expect(buildSoraMcpInstructions(['all'])).not.toContain('get_lyrics');
  });
});

describe('REST /lyrics', () => {
  test('is a 404 MODULE_DISABLED that says how to enable it, by default and under all', async () => {
    delete process.env.ENABLED_MODULES;
    for (const value of [undefined, 'all']) {
      if (value) process.env.ENABLED_MODULES = value;
      const res = await post(app, { title: 'x' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.code).toBe('MODULE_DISABLED');
      expect(json.error).toContain('ENABLED_MODULES');
    }
  });

  test('when enabled it validates, answers, and maps a failed lookup to a retryable 502', async () => {
    process.env.ENABLED_MODULES = 'all,lyrics';
    const ok = new Hono().route('/', createLyricsRoutes(async () => fakeResult));
    expect(await (await post(ok, { title: 'テスト曲' })).json()).toMatchObject({ found: true, lyrics: 'らら' });
    expect((await post(ok, {})).status).toBe(400);
    expect((await post(ok, '{broken')).status).toBe(400);
    const down = new Hono().route('/', createLyricsRoutes(async () => { throw new Error('LRCLIB HTTP 503'); }));
    const res = await post(down, { title: 'テスト曲' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'LYRICS_UPSTREAM_ERROR', retryable: true });
  });
});

describe('documentation follows the module', () => {
  test('OpenAPI and the endpoint list include /lyrics only when it is enabled', async () => {
    delete process.env.ENABLED_MODULES;
    expect(generateOpenApiDocument().paths['/lyrics' as keyof ReturnType<typeof generateOpenApiDocument>['paths']]).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/lyrics');
    process.env.ENABLED_MODULES = 'all,lyrics';
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/lyrics'].post.requestBody.content['application/json'].schema.required).toEqual(['title']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /lyrics');
  });
});
