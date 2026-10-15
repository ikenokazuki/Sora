import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClientFiles } from '../scripts/gen-client/index.js';
import { callSora, SoraError } from '../client/runtime.js';

const clientDir = join(import.meta.dir, '..', 'client');

describe('client/ is generated from the OpenAPI document', () => {
  test('committed files equal a fresh generation (run `bun run gen:client` after changing a tool or route)', () => {
    for (const [path, content] of Object.entries(buildClientFiles())) {
      expect(readFileSync(join(clientDir, path), 'utf8'), `client/${path} is out of date; run: bun run gen:client`).toBe(content);
    }
    const manifest = JSON.parse(readFileSync(join(clientDir, 'manifest.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).toEqual(Object.keys(buildClientFiles()).filter((f) => f !== 'manifest.json').sort());
  });
});

interface Seen { url: string; init: RequestInit }
function fakeFetch(seen: Seen[], response: { status?: number; body?: unknown } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response.body ?? { ok: true }), { status: response.status ?? 200 });
  }) as typeof fetch;
}
const opts = (seen: Seen[], extra: object = {}) => ({ baseUrl: 'http://sora.test/', apiKey: 'k', fetch: fakeFetch(seen, extra) });

describe('generated functions call the REST route that REST_MAP names', () => {
  test('POST tools send the input as the JSON body with the Bearer key', async () => {
    const seen: Seen[] = [];
    const { searchWeb } = await import('../client/servers/sora/search_web.js');
    expect(searchWeb).toBeFunction();
    await callSora({ method: 'POST', path: '/search/web' }, { query: '天気' }, opts(seen));
    expect(seen[0].url).toBe('http://sora.test/search/web');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.body).toBe(JSON.stringify({ query: '天気' }));
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  test('path parameters are substituted and removed from the query; the rest becomes the query', async () => {
    const seen: Seen[] = [];
    await callSora({ method: 'GET', path: '/intelligence/context/:contextId/evidence' }, { contextId: 'a/b', limit: 5 }, opts(seen));
    expect(seen[0].url).toBe('http://sora.test/intelligence/context/a%2Fb/evidence?limit=5');
    expect(seen[0].init.body).toBeUndefined();
  });

  test('a tool without input has no body and no query', async () => {
    const seen: Seen[] = [];
    await callSora({ method: 'GET', path: '/watch/list' }, {}, opts(seen));
    expect(seen[0].url).toBe('http://sora.test/watch/list');
  });

  test('the generated modules bind each tool to its route', () => {
    const route = (file: string, literal: string) => expect(readFileSync(join(clientDir, 'servers/sora', file), 'utf8')).toContain(literal);
    route('search_web.ts', "{ method: 'POST', path: '/search/web' }, input");
    route('search_deep.ts', "{ method: 'POST', path: '/search/deep' }, input");
    route('search_poi.ts', "{ method: 'POST', path: '/geo/poi' }, input");
    route('normalize_address.ts', "{ method: 'POST', path: '/geo/address/normalize' }, input");
    route('get_country_context.ts', "{ method: 'GET', path: '/intelligence/context/:contextId' }, input");
    route('watch_list.ts', "{ method: 'GET', path: '/watch/list' })");
  });

  test('error bodies become SoraError with code, status, retryable and details', async () => {
    const body = { error: 'bad input', code: 'VALIDATION_ERROR', status: 400, retryable: false, details: [{ path: ['query'] }] };
    const error = await callSora({ method: 'POST', path: '/search/web' }, {}, opts([], { status: 400, body })).catch((e) => e as SoraError);
    expect(error).toBeInstanceOf(SoraError);
    expect(error).toMatchObject({ message: 'bad input', code: 'VALIDATION_ERROR', status: 400, retryable: false });
    expect((error as SoraError).details).toEqual(body.details);
  });

  test('network failures are retryable errors with status 0', async () => {
    const failing = (async () => { throw new TypeError('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const error = await callSora({ method: 'GET', path: '/watch/list' }, {}, { baseUrl: 'http://x', fetch: failing }).catch((e) => e);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true });
  });
});
