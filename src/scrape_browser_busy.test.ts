import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { ResourceBusyError } from './errors.js';
import { scrapeUrl } from './scraper.js';
import { fillQueue, releaseAll, saturate } from './test_fixtures/browser_slots.js';

/**
 * scrapeUrl が、ブラウザの枠の断り（ResourceBusyError）を握って、欠けた結果を共有のキャッシュに入れない（設計 6。穴 25。独立したレビューで見つかった同じ型の穴）。
 * キャッシュのキーには利用者が含まれないので、枠を断られた利用者の欠けた結果（静的な殻だけ・スクリーンショットなし）が入ると、
 * 枠に余裕のある別の利用者にも、その結果が返る（`cached: true`・ブラウザで取り直さない）。
 */

let server: ReturnType<typeof Bun.serve>;
const saved: Record<string, string | undefined> = {};
const spies: Array<{ mockRestore: () => void }> = [];

const SPA = '<html><head><title>Spa</title></head><body><div id="root"><p>Static shell text that is more than fifty characters long, but SPA marker present.</p></div></body></html>';
const ARTICLE = `<html><head><title>Article</title></head><body><article><h1>Article</h1><p>${'This is a long server rendered paragraph with plenty of readable text. '.repeat(12)}</p></article></body></html>`;

beforeEach(() => {
  for (const key of ['SORA_ISOLATION', 'CHROME_PATH', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK']) saved[key] = process.env[key];
  process.env.SORA_ISOLATION = 'strict';
  process.env.CHROME_PATH = process.execPath; // Chromium が「ある」ことにする（枠を断られるので、起動しない）
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      return new Response(new URL(request.url).pathname.startsWith('/spa') ? SPA : ARTICLE, { headers: { 'content-type': 'text/html' } });
    },
  });
});

afterEach(async () => {
  server.stop(true);
  for (const spy of spies.splice(0)) spy.mockRestore();
  await releaseAll();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** T の枠の待ちが上限で、T が断られる状態にする。そのあと、枠を空けて、U（余裕のある別の利用者）が来る */
async function refuseT(url: string, options: Record<string, unknown> = {}) {
  await saturate();
  fillQueue('T', 10); // strict の browserQueuePerTenant は 10
  const outcome = await scrapeUrl({ url, tenantId: 'T', timeoutMs: 5000, ...options }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await releaseAll();
  return outcome;
}

describe('SPA の殻（ブラウザで描画が要る）で、枠を断られたとき', () => {
  test('断られた利用者には、ResourceBusyError を返す（静的な殻だけの結果にしない）', async () => {
    const outcome = await refuseT(`http://127.0.0.1:${server.port}/spa-throws-${Math.random()}`);
    expect('error' in outcome ? outcome.error : undefined).toBeInstanceOf(ResourceBusyError);
  });

  test('余裕のある別の利用者は、キャッシュの殻ではなく、ブラウザで取り直す（getBrowser を呼ぶ）', async () => {
    const url = `http://127.0.0.1:${server.port}/spa-shared-${Math.random()}`;
    await refuseT(url);
    const getBrowser = spyOn(engine, 'getBrowser').mockRejectedValue(new Error('would launch browser'));
    spies.push(getBrowser);
    const u = await scrapeUrl({ url, tenantId: 'U', timeoutMs: 5000 }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(getBrowser.mock.calls.length).toBeGreaterThan(0);
    expect('value' in u ? (u.value as { cached?: boolean }).cached : undefined).not.toBe(true);
  });

  test('断りでない描画の失敗（ブラウザが起動できない）は、これまでどおり、静的な殻で救済する', async () => {
    const url = `http://127.0.0.1:${server.port}/spa-crash-${Math.random()}`;
    spies.push(spyOn(engine, 'getBrowser').mockRejectedValue(new Error('browser crashed')));
    const result = await scrapeUrl({ url, tenantId: 'T', timeoutMs: 5000 });
    expect(result.content).toContain('Static shell text');
  });
});

describe('スクリーンショットのためのブラウザ描画で、枠を断られたとき', () => {
  test('断られた利用者には、ResourceBusyError を返す（画像なしの結果にしない）', async () => {
    const outcome = await refuseT(`http://127.0.0.1:${server.port}/ssr-throws-${Math.random()}`, { formats: ['markdown', 'screenshot'] });
    expect('error' in outcome ? outcome.error : undefined).toBeInstanceOf(ResourceBusyError);
  });

  test('余裕のある別の利用者は、画像なしのキャッシュではなく、ブラウザで取り直す', async () => {
    const url = `http://127.0.0.1:${server.port}/ssr-shared-${Math.random()}`;
    await refuseT(url, { formats: ['markdown', 'screenshot'] });
    const getBrowser = spyOn(engine, 'getBrowser').mockRejectedValue(new Error('would launch browser'));
    spies.push(getBrowser);
    await scrapeUrl({ url, tenantId: 'U', timeoutMs: 5000, formats: ['markdown', 'screenshot'] }).catch(() => undefined);
    expect(getBrowser.mock.calls.length).toBeGreaterThan(0);
  });

  test('断りでない撮影の失敗は、これまでどおり、画像を撮れない警告つきの結果を返す', async () => {
    const url = `http://127.0.0.1:${server.port}/ssr-crash-${Math.random()}`;
    spies.push(spyOn(engine, 'getBrowser').mockRejectedValue(new Error('browser crashed')));
    const result = await scrapeUrl({ url, tenantId: 'T', timeoutMs: 5000, formats: ['markdown', 'screenshot'] });
    expect(result.screenshot).toBeUndefined();
    expect(JSON.stringify(result.warnings)).toContain('画像を取れませんでした');
  });
});
