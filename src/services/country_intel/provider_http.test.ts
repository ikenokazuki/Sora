import { beforeEach, describe, expect, test } from 'bun:test';
import { fetchProviderResponse, isExpectedContentType, resetProviderHttpState } from './provider_http.js';
import { ProviderHttpError } from './provider_registry.js';

beforeEach(() => {
  resetProviderHttpState();
});

function okResponse(body = '{}', contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('provider http', () => {
  test('enforces per-host minimum interval', async () => {
    let t = 0;
    const slept: number[] = [];
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      return okResponse();
    };
    const opts = { sourceId: 's', timeoutMs: 1000, format: 'json' as const, fetchFn, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, minIntervalMs: 1000 };
    await fetchProviderResponse('https://example.org/a', opts);
    await fetchProviderResponse('https://example.org/b', opts);
    expect(calls).toBe(2);
    expect(slept).toEqual([1000]);
  });

  test('maps 429 with retry-after and rejects empty content', async () => {
    const limited = async (): Promise<Response> => new Response('slow', { status: 429, headers: { 'retry-after': '30' } });
    const err = await fetchProviderResponse('https://example.org/l', { sourceId: 's', timeoutMs: 1000, format: 'json', fetchFn: limited }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(429);
    expect((err as ProviderHttpError).retryAfter).toBe('30');
    const empty = async (): Promise<Response> => new Response(null, { status: 204 });
    await expect(fetchProviderResponse('https://example.org/e', { sourceId: 's', timeoutMs: 1000, format: 'json', fetchFn: empty })).rejects.toThrow();
  });

  test('limits global concurrency', async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const fetchFn = async (): Promise<Response> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { resolvers.push(resolve); });
      active -= 1;
      return okResponse();
    };
    const run = (u: string): Promise<Response> => fetchProviderResponse(u, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, maxConcurrency: 2 });
    const pending = [run('https://a.example/1'), run('https://b.example/2'), run('https://c.example/3')];
    await Bun.sleep(20);
    expect(peak).toBe(2);
    resolvers.splice(0).forEach((resolve) => resolve());
    await Bun.sleep(20);
    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all(pending);
    expect(peak).toBe(2);
  });

  test('classifies expected content types', () => {
    expect(isExpectedContentType('application/json; charset=utf-8', 'json')).toBe(true);
    expect(isExpectedContentType('text/html', 'json')).toBe(false);
    expect(isExpectedContentType('application/rss+xml', 'xml')).toBe(true);
  });
});
