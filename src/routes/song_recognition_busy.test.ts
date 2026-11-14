import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ResourceBusyError } from '../errors.js';
import type { SongRecognitionOptions } from '../services/song_recognition.js';
import { createSongRecognitionRoutes } from './song_recognition.js';

/**
 * 楽曲認識の REST（POST /music/recognize）: 認証が決めた利用者（tenant）を、認識に渡し（ブラウザの枠を数える）、
 * 枠が混み合って断られたら 429 と Retry-After（設計 6。穴 22・25）。本文・フォームで tenantId を名乗っても無視する。
 */

let previousModules: string | undefined;
beforeEach(() => {
  previousModules = process.env.SORA_MODULES;
  process.env.SORA_MODULES = 'all,shazam';
});
afterEach(() => {
  if (previousModules === undefined) delete process.env.SORA_MODULES;
  else process.env.SORA_MODULES = previousModules;
});

const found = { found: false, reason: 'no-match', message: 'x', itunes: null, itunesMatch: null, attempts: [] };
const appFor = (tenantId: string | undefined, run: (input: SongRecognitionOptions) => Promise<unknown>) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { tenantId, requestId: 'req-1', authMode: 'api_key' });
    await next();
  });
  app.route('/', createSongRecognitionRoutes(run));
  return app;
};
const postJson = (app: Hono, body: unknown) => app.request('/music/recognize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('利用者を認識に渡す', () => {
  test('JSON: 認証が決めた利用者。本文の tenantId は無視する', async () => {
    let seen: SongRecognitionOptions | undefined;
    const app = appFor('name:alice', async (input) => {
      seen = input;
      return found;
    });
    expect((await postJson(app, { url: 'https://example.com/a.mp3', tenantId: 'name:bob' })).status).toBe(200);
    expect(seen?.tenantId).toBe('name:alice');
  });

  test('multipart（ファイルのアップロード）も同じ。tenant を決めた認証が無い組み立てでは legacy', async () => {
    let seen: SongRecognitionOptions | undefined;
    const form = () => {
      const body = new FormData();
      body.append('file', new File([new Uint8Array([1, 2, 3])], 'clip.m4a', { type: 'audio/mp4' }));
      body.append('tenantId', 'name:bob');
      return body;
    };
    await appFor('name:alice', async (input) => {
      seen = input;
      return found;
    }).request('/music/recognize', { method: 'POST', body: form() });
    expect(seen?.tenantId).toBe('name:alice');
    await appFor(undefined, async (input) => {
      seen = input;
      return found;
    }).request('/music/recognize', { method: 'POST', body: form() });
    expect(seen?.tenantId).toBe('legacy');
  });
});

describe('枠が混み合って断られたら', () => {
  test('429 と Retry-After（code: BROWSER_BUSY）。ほかの失敗は、これまでどおり 502', async () => {
    const busy = appFor('name:alice', async () => {
      throw new ResourceBusyError('ブラウザの枠が混み合っています', 'queue_full', 7);
    });
    const res = await postJson(busy, { url: 'https://example.com/a.mp3' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.json()).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true });

    const down = appFor('name:alice', async () => {
      throw new Error('Shazam HTTP 503 (request failed)');
    });
    const other = await postJson(down, { url: 'https://example.com/a.mp3' });
    expect(other.status).toBe(502);
    expect(other.headers.get('retry-after')).toBeNull();
  });
});
