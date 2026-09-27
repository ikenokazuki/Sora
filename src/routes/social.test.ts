import { describe, expect, test } from 'bun:test';
import { createSocialRoutes } from './social.js';

const fakeService = {
  search: async (input: any) => ({ status: 'empty', platform: input.platform, query: input.query, searchMode: 'test', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: [], warnings: [] }),
  fetch: async (input: any) => ({ status: 'unavailable', failures: ['unsupported post url'], warnings: [], ...(input.url.includes('weibo') ? {} : {}) }),
  enrichWeiboTop: async (x: any) => x,
};

describe('social rest routes', () => {
  test('POST /social/search validates and delegates', async () => {
    const app = createSocialRoutes({ service: fakeService as never });
    const res = await app.request('/social/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'weibo', query: 'q' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.platform).toBe('weibo');
    expect(body.status).toBe('empty');
  });
  test('POST /social/search rejects bad input', async () => {
    const app = createSocialRoutes({ service: fakeService as never });
    const res = await app.request('/social/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'x', query: '' }) });
    expect(res.status).toBe(400);
  });
  test('POST /social/fetch validates url', async () => {
    const app = createSocialRoutes({ service: fakeService as never });
    const bad = await app.request('/social/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    const ok = await app.request('/social/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.org/a' }) });
    expect(ok.status).toBe(200);
  });
});

test('OpenAPI exposes social endpoints alongside MCP tools', async () => {
  const { generateOpenApiDocument } = await import('../types.js');
  const doc = generateOpenApiDocument() as { paths: Record<string, unknown> };
  expect(doc.paths['/social/search']).toBeDefined();
  expect(doc.paths['/social/fetch']).toBeDefined();
});
