import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADDRESS_USER_AGENT, AddressHttpError, JAPANPOST_FALLBACK, combineSignatures, downloadToFile, headSignature,
  latestSourceDate, resolveJapanPostLinks, type FetchFn, type Signature,
} from './address_http.js';

function respond(status: number, body: BodyInit | null, headers: Record<string, string> = {}, url?: string): Response {
  const response = new Response(body, { status, headers });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
}

function script(...steps: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const queue = [...steps];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const step = queue.shift();
    if (!step) throw new Error(`unexpected request: ${url}`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchFn, calls };
}
const noSleep = { sleep: async () => undefined };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-http-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('headSignature', () => {
  test('ETag・Last-Modified・サイズを読み、取得元と分かる User-Agent を付ける', async () => {
    const { fetchFn, calls } = script(respond(200, null, { etag: '"abc"', 'last-modified': 'Fri, 02 Oct 2026 15:40:53 GMT', 'content-length': '83827' }));
    expect(await headSignature('https://example.test/a.zip', { fetchFn })).toEqual({
      url: 'https://example.test/a.zip', etag: '"abc"', lastModified: 'Fri, 02 Oct 2026 15:40:53 GMT', size: 83827,
    });
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.headers.get('user-agent')).toBe(ADDRESS_USER_AGENT);
  });

  test('404 は null', async () => {
    expect(await headSignature('https://example.test/none.zip', { fetchFn: script(respond(404, null)).fetchFn })).toBeNull();
  });

  test('403 は再試行せず、blocked として投げる', async () => {
    const { fetchFn, calls } = script(respond(403, null));
    const error = await headSignature('https://example.test/a.zip', { fetchFn, ...noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressHttpError);
    expect(error).toMatchObject({ status: 403, blocked: true, retryable: false });
    expect((error as Error).message).toContain('HTTP 403');
    expect(calls).toHaveLength(1);
  });

  test('5xx と通信エラーは待って再試行し、尽きたら retryable で投げる', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const recovered = script(respond(503, null), new Error('socket closed'), respond(200, null, { etag: '"x"' }));
    expect((await headSignature('https://example.test/a.zip', { fetchFn: recovered.fetchFn, sleep }))?.etag).toBe('"x"');
    expect(waits).toEqual([1000, 2000]);

    const failing = script(respond(500, null), respond(502, null), respond(503, null));
    const error = await headSignature('https://example.test/a.zip', { fetchFn: failing.fetchFn, ...noSleep }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, retryable: true, blocked: false });
  });

  test('404 以外の 4xx は再試行しない', async () => {
    const { fetchFn, calls } = script(respond(400, null));
    await expect(headSignature('https://example.test/a.zip', { fetchFn, ...noSleep })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe('signatures', () => {
  const a: Signature = { url: 'https://example.test/a', etag: '"1"', lastModified: 'Fri, 02 Oct 2026 15:40:53 GMT', size: 10 };
  const b: Signature = { url: 'https://example.test/b', etag: null, lastModified: 'Mon, 27 Oct 2025 09:30:04 GMT', size: 20 };

  test('combineSignatures は同じ入力で同じ値、変化があれば別の値', () => {
    expect(combineSignatures([a, b])).toBe(combineSignatures([a, b]));
    expect(combineSignatures([a, b])).not.toBe(combineSignatures([a, { ...b, size: 21 }]));
    expect(combineSignatures([a, null])).not.toBe(combineSignatures([a, b]));
    expect(combineSignatures([a, b])).toMatch(/^[0-9a-f]{16}$/);
  });

  test('latestSourceDate は最も新しい Last-Modified を YYYY-MM-DD で返す', () => {
    expect(latestSourceDate([a, b, null])).toBe('2026-10-02');
    expect(latestSourceDate([null, { ...a, lastModified: null }])).toBeUndefined();
  });
});

describe('downloadToFile', () => {
  test('一時ファイル経由で保存し、署名とバイト数を返す', async () => {
    const dest = join(dir, 'sub', 'a.zip');
    const { fetchFn } = script(respond(200, new Uint8Array([1, 2, 3, 4]), { etag: '"e"', 'last-modified': 'Fri, 02 Oct 2026 15:40:53 GMT', 'content-length': '4' }));
    const result = await downloadToFile('https://example.test/a.zip', dest, { fetchFn });
    expect(result?.bytes).toBe(4);
    expect(result?.signature).toMatchObject({ url: 'https://example.test/a.zip', etag: '"e"', size: 4 });
    expect([...readFileSync(dest)]).toEqual([1, 2, 3, 4]);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test('404 は null で、ファイルを作らない', async () => {
    const dest = join(dir, 'none.zip');
    expect(await downloadToFile('https://example.test/none.zip', dest, { fetchFn: script(respond(404, null)).fetchFn })).toBeNull();
    expect(existsSync(dest)).toBe(false);
  });
});

describe('resolveJapanPostLinks', () => {
  const page = 'https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html';
  const office = 'https://www.post.japanpost.jp/service/search/zipcode/download/office/index-zip.html';

  test('転送後のページを基準に、相対リンクを解決する', async () => {
    const { fetchFn, calls } = script(
      respond(200, '<a href="utf/zip/utf_add_2609.zip">x</a><a href="utf/zip/utf_ken_all.zip">全国</a>', {}, page),
      respond(200, '<a href="/zipcode/dl/jigyosyo/readme.html">readme</a><a href="zip/jigyosyo.zip">全国</a>', {}, office),
    );
    expect(await resolveJapanPostLinks({ fetchFn })).toEqual({
      kenAll: 'https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip',
      jigyosyo: 'https://www.post.japanpost.jp/service/search/zipcode/download/office/zip/jigyosyo.zip',
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://www.post.japanpost.jp/zipcode/dl/utf-zip.html',
      'https://www.post.japanpost.jp/zipcode/dl/jigyosyo/index-zip.html',
    ]);
  });

  test('リンクが見つからない・取得できないときは既知の直 URL にする', async () => {
    const { fetchFn } = script(respond(200, '<p>ページの構成が変わった</p>', {}, page), new Error('offline'));
    expect(await resolveJapanPostLinks({ fetchFn, ...noSleep, retries: 1 })).toEqual(JAPANPOST_FALLBACK);
  });
});
