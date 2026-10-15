import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware } from '../auth.js';
import { PUBLIC_PATHS } from '../security/public_paths.js';
import { clientRoutes } from './client.js';

const app = new Hono().route('/', clientRoutes);
const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

describe('GET /client', () => {
  test('returns the manifest listing every served file', async () => {
    const res = await get('/client');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { files: string[] };
    expect(manifest.files).toContain('servers/sora/search_web.ts');
    expect(manifest.files).toContain('runtime.ts');
  });

  test('serves a listed file as plain text', async () => {
    const res = await get('/client/servers/sora/search_web.ts');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toContain('export function searchWeb');
  });

  test('serves catalog.json with a JSON content type', async () => {
    const res = await get('/client/catalog.json');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  test.each([
    '/client/nope.ts',
    '/client/servers/sora',
    '/client/..%2Fpackage.json',
    '/client/%2e%2e/package.json',
    '/client/servers/%2e%2e/%2e%2e/package.json',
    '/client//etc/passwd',
    '/client/runtime.ts%00',
  ])('refuses %s with 404', async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  test('requires the API key like the other REST routes and is not public', async () => {
    expect([...PUBLIC_PATHS].some((p) => p.startsWith('/client'))).toBe(false);
    const guarded = new Hono();
    guarded.use('*', createAuthMiddleware('secret-test-key'));
    guarded.route('/', clientRoutes);
    const headers = { 'x-forwarded-for': '203.0.113.195' };
    expect((await guarded.fetch(new Request('http://localhost/client', { headers }))).status).toBe(401);
    const ok = await guarded.fetch(new Request('http://localhost/client', { headers: { ...headers, Authorization: 'Bearer secret-test-key' } }));
    expect(ok.status).toBe(200);
  });
});
