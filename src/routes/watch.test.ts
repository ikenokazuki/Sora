import { describe, expect, test } from 'bun:test';
import { createWatchRoutes } from './watch.js';
import { WatchSelectorNotFoundError } from '../services/watch.js';

describe('F7 watch route errors', () => {
  test('selector miss maps to 502 with code and retryable=false', async () => {
    const app = createWatchRoutes({
      checkWatchTarget: async () => { throw new WatchSelectorNotFoundError('#status', 'https://example.com/p'); },
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'wt_1' }) });
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string; retryable: boolean };
    expect(body.code).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(body.retryable).toBe(false);
  });
  test('batch results carry errorCode per target', async () => {
    const app = createWatchRoutes({
      checkAllWatchTargets: async () => [{ targetId: 'wt_1', url: 'https://example.com/a', changed: false, currentHash: '', checkedAt: new Date().toISOString(), errorCode: 'WATCH_SELECTOR_NOT_FOUND' }],
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ errorCode?: string }> };
    expect(body.results[0].errorCode).toBe('WATCH_SELECTOR_NOT_FOUND');
  });
  test('single result is wrapped in result', async () => {
    const app = createWatchRoutes({
      checkWatchTarget: async () => ({ targetId: 'wt_1', url: 'https://example.com/a', changed: false, currentHash: 'h', checkedAt: new Date().toISOString() }),
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'wt_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { targetId: string } };
    expect(body.result.targetId).toBe('wt_1');
  });
});
