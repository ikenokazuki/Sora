// 検索系 REST の入口が、リクエストスキーマに合わない入力を外部へ問い合わせる前に 400 で返すことを確かめる。
import { describe, expect, test } from 'bun:test';
import { app } from '../index.js';

async function post(path: string, body: unknown): Promise<{ status: number; error?: string }> {
  const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, error: ((await res.json()) as { error?: string }).error };
}

describe('search route input validation', () => {
  test('realtime keeps the per-field messages', async () => {
    expect(await post('/search/realtime', { query: 'x', limit: 41 })).toEqual({ status: 400, error: 'limit must be an integer 1-40' });
    expect(await post('/search/realtime', { query: 'x', sort: 'old' })).toEqual({ status: 400, error: 'sort must be "recent" or "popular"' });
    expect(await post('/realtime', { query: 'x', focus: 'all' })).toEqual({ status: 400, error: 'focus must be "official" or "public"' });
    expect(await post('/realtime', { query: 'x', anchor: 'a'.repeat(101) })).toEqual({ status: 400, error: 'anchor must be a string of at most 100 characters' });
  });

  test('realtime rejects a non-string query instead of ignoring it', async () => {
    const res = await post('/search/realtime', { query: 123 });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith('query:');
  });

  test('realtime still requires at least one search constraint', async () => {
    expect(await post('/search/realtime', {})).toEqual({ status: 400, error: 'query, accountId, hashtags, or other search constraints are required' });
  });

  for (const path of ['/search/image', '/search/video', '/search/news', '/search/chiebukuro', '/search/suggest']) {
    test(`${path} validates query and limit`, async () => {
      expect(await post(path, {})).toEqual({ status: 400, error: 'query is required' });
      expect(await post(path, { query: '' })).toEqual({ status: 400, error: 'query is required' });
      const badLimit = await post(path, { query: 'x', limit: '5' });
      expect(badLimit.status).toBe(400);
      expect(badLimit.error).toStartWith('limit:');
    });
  }
});
