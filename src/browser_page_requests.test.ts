import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as dnsPromises } from 'dns';
import type { Page } from 'puppeteer-core';
import { setupPageSecurity, unsendableBrowserHeaderNames } from './browser_engine.js';

// ブラウザのページの要求の割り込み（setupPageSecurity）。puppeteer の continue・abort は、失敗することがある
// （ブラウザが受け付けない書き換え、扱い済みの要求など）。どの分かれ道で失敗しても、割り込みの処理の中で受け止める。偽のページで確かめる。
// 受け止めない失敗があれば、bun test がそのテストを失敗にする（process.on で受けても、失敗にする。Bun 1.4.4 で確かめた）
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_EGRESS_GATEWAY'];
let saved: Record<string, string | undefined> = {};
let lookup: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  // テストの事前設定（test_preload.ts）が入れる架空のプロキシは、直接つなぐ場合の検査なので外す
  for (const key of touchedKeys) delete process.env[key];
  lookup = spyOn(dnsPromises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
});

afterEach(() => {
  lookup.mockRestore();
  for (const key of touchedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Fails = { continue?: boolean; abort?: boolean; resourceType?: boolean };

/** 要求の割り込みを手元で動かす、偽のページ。返す関数は、要求を 1 つ流して、割り込みの処理が終わるまで待つ */
async function fakePage(blockMedia = false, scopedHeaders?: { origin: string; headers: Record<string, string> }) {
  let handler: ((req: unknown) => Promise<void>) | undefined;
  const mainFrame = {};
  const page = {
    setRequestInterception: async () => {},
    on: (_event: string, listener: (req: unknown) => Promise<void>) => {
      handler = listener;
    },
    mainFrame: () => mainFrame,
  } as unknown as Page;
  await setupPageSecurity(page, blockMedia, scopedHeaders);
  return async (url: string, { resourceType = 'document', fails = {} as Fails } = {}) => {
    const calls = { continued: [] as Array<Record<string, string> | undefined>, aborted: [] as string[] };
    await handler?.({
      url: () => url,
      resourceType: () => {
        if (fails.resourceType) throw new Error('Target closed');
        return resourceType;
      },
      isNavigationRequest: () => true,
      frame: () => mainFrame,
      headers: () => ({ accept: 'text/html' }),
      continue: async (overrides?: { headers?: Record<string, string> }) => {
        calls.continued.push(overrides?.headers);
        if (fails.continue) throw new Error('Protocol error (Fetch.continueRequest): refused');
      },
      abort: async (reason: string) => {
        calls.aborted.push(reason);
        if (fails.abort) throw new Error('Request is already handled!');
      },
    });
    // 受け止めない失敗は少し後に届くので、このテストの中で起こさせる
    await new Promise((resolve) => setTimeout(resolve, 20));
    return calls;
  };
}

describe('要求を通す（continue）のが失敗しても、受け止めて、その要求は中止する', () => {
  const cases: Array<[string, { url: string; env?: Record<string, string>; unresolved?: boolean; warmUp?: boolean }]> = [
    ['内部への取得を許す設定', { url: 'http://allowed.page-requests.example/', env: { SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' } }],
    ['data: の要求', { url: 'data:text/plain,x' }],
    ['初めての宛先（名前の検査の後）', { url: 'http://first.page-requests.example/' }],
    ['検査を覚えている宛先', { url: 'http://cached.page-requests.example/', warmUp: true }],
    ['名前を相手のプロキシが引くので、解決できなくても通す宛先', { url: 'http://proxied.page-requests.example/', env: { SORA_PROXY_URL: 'http://127.0.0.1:9' }, unresolved: true }],
  ];
  for (const [name, { url, env, unresolved, warmUp }] of cases) {
    test(name, async () => {
      Object.assign(process.env, env);
      if (unresolved) lookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND') as never);
      const send = await fakePage();
      if (warmUp) expect((await send(url)).continued).toHaveLength(1);
      const calls = await send(url, { fails: { continue: true } });
      expect(calls.continued).toHaveLength(1);
      expect(calls.aborted).toEqual(['failed']);
    });
  }
});

describe('要求を中止する（abort）のが失敗しても、受け止める', () => {
  const cases: Array<[string, { url: string; reason: string; resourceType?: string; blockMedia?: boolean; addresses?: string[]; unresolved?: boolean }]> = [
    ['動画・音声', { url: 'http://media.page-requests.example/a', reason: 'blockedbyclient', resourceType: 'media' }],
    ['画像（遮断する設定）', { url: 'http://image.page-requests.example/a', reason: 'blockedbyclient', resourceType: 'image', blockMedia: true }],
    ['読めない URL', { url: 'http://[broken', reason: 'blockedbyclient' }],
    ['http・https でない URL', { url: 'ftp://files.page-requests.example/a', reason: 'blockedbyclient' }],
    ['内部の IP', { url: 'http://127.0.0.1:8080/a', reason: 'accessdenied' }],
    ['解決できない名前', { url: 'http://missing.page-requests.example/', reason: 'namenotresolved', unresolved: true }],
    ['内部の IP に解決される名前', { url: 'http://rebind.page-requests.example/', reason: 'accessdenied', addresses: ['10.0.0.5'] }],
  ];
  for (const [name, { url, reason, resourceType, blockMedia, addresses, unresolved }] of cases) {
    test(name, async () => {
      if (addresses) lookup.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })) as never);
      if (unresolved) lookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND') as never);
      const send = await fakePage(blockMedia);
      const calls = await send(url, { resourceType, fails: { abort: true } });
      expect(calls.aborted[0]).toBe(reason);
      expect(calls.continued).toEqual([]);
    });
  }

  test('途中の例外のあとの中止が失敗しても、受け止める', async () => {
    const send = await fakePage();
    const calls = await send('http://broken.page-requests.example/', { fails: { resourceType: true, abort: true } });
    expect(calls.aborted).toEqual(['failed']);
  });
});

// Chromium は、次のヘッダーを要求の書き換え（continue）で断る（手元の 148 と、配布イメージの 156 で実測）。1 つでも混ざると、その要求は失敗する。
// タブ以外の制御文字を含む値は continue を通るが、要求は届かないか、文字が落ちる
const UNSENDABLE: Record<string, string> = {
  Host: 'other.example', 'Content-Length': '1', 'Keep-Alive': 'timeout=5', TE: 'trailers', Trailer: 'x', 'Transfer-Encoding': 'chunked', Upgrade: 'h2c',
  Cookie2: 'x', 'Set-Cookie': 'a=1', 'Proxy-Authorization': 'Basic c2VjcmV0', 'proxy-x-custom': '1',
  'bad name': '1', 'x(paren)': '1', ':authority': 'x', '': '1', 'x-trailing ': '1', '名前': '1',
  'x-cr': 'a\rb', 'x-lf': 'a\nb', 'x-nul': 'a\0b', 'x-ctrl': 'a\u0001b', 'x-vtab': 'a\u000bb', 'x-del': 'a\u007fb',
};
const SENDABLE: Record<string, string> = {
  'X-Ok': '1', Authorization: 'Bearer t', Connection: 'close', 'Content-Type': 'text/plain', 'x-tab': 'a\tb', 'x-latin1': 'é', 'x-japanese': '日本', 'x-empty': '', "x_!#$%&'*+.^`|~": '1',
};
const lowercaseKeys = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

describe('ブラウザが送れない呼び出し側のヘッダーは外して、ほかは付ける', () => {
  const scoped = { origin: 'http://page.page-requests.example', headers: { ...SENDABLE, ...UNSENDABLE, 'User-Agent': 'caller/1.0' } };

  test('同じオリジンへの要求', async () => {
    const send = await fakePage(false, scoped);
    const calls = await send('http://page.page-requests.example/a');
    expect(calls.aborted).toEqual([]);
    expect(calls.continued).toEqual([{ accept: 'text/html', ...lowercaseKeys(SENDABLE) }]);
  });

  test('別のオリジンへの本体の移動（資格情報でないものだけ）', async () => {
    const send = await fakePage(false, scoped);
    const { authorization, ...navigation } = lowercaseKeys(SENDABLE);
    expect((await send('http://elsewhere.page-requests.example/a')).continued).toEqual([{ accept: 'text/html', ...navigation }]);
  });

  test('connection は、値が upgrade のときだけ外す', async () => {
    for (const [value, kept] of [['Upgrade', false], [' upgrade ', false], ['close', true], ['keep-alive', true]] as const) {
      const send = await fakePage(false, { origin: 'http://page.page-requests.example', headers: { Connection: value, 'X-Ok': '1' } });
      expect((await send('http://page.page-requests.example/a')).continued).toEqual([{ accept: 'text/html', ...(kept ? { connection: value } : {}), 'x-ok': '1' }]);
    }
  });

  test('メソッドを書き換えるヘッダーは、値に CONNECT・TRACE・TRACK があるときだけ外す（Chromium 156 の規則）', () => {
    for (const name of ['X-HTTP-Method', 'X-HTTP-Method-Override', 'X-Method-Override']) {
      for (const value of ['TRACE', 'trace', 'CONNECT', 'Track', 'GET, TRACE', 'GET,trace', ' TRACE ', 'TRACE,', '\tTRACK']) {
        expect(unsendableBrowserHeaderNames({ [name]: value })).toEqual([name]);
      }
      for (const value of ['GET', 'PATCH', 'DELETE', 'TRACEX', 'XTRACE', 'GET TRACE', '']) expect(unsendableBrowserHeaderNames({ [name]: value })).toEqual([]);
    }
    expect(unsendableBrowserHeaderNames({ 'X-Other-Method': 'TRACE' })).toEqual([]);
  });

  test('外すヘッダーの名前を返す（渡された綴りのまま。User-Agent は、もともと付けないので数えない）', () => {
    expect(unsendableBrowserHeaderNames(scoped.headers)).toEqual(Object.keys(UNSENDABLE));
    expect(unsendableBrowserHeaderNames({ ...SENDABLE, 'user-agent': 'a\nb' })).toEqual([]);
    expect(unsendableBrowserHeaderNames(undefined)).toEqual([]);
  });
});
