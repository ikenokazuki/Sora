import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as dnsPromises } from 'dns';
import type { Page } from 'puppeteer-core';
import { setupPageSecurity, validateHostIpDns } from './browser_engine.js';
import { closeHttpSession, fetchWithSafeRedirects } from './http_fetcher.js';

// 検査の DNS（validateHostIpDns・ページの副要求の検査）は、名前を解決できないとき、これまで、検査を通して、接続のときの解決に任せていた。
// 攻撃者が自分の DNS で、検査のときだけ失敗させ、接続のときに内部の IP を答えると、検査を抜けられる。
// Sora の手元で名前を引いて接続するとき（プロキシもゲートウェイも通さないとき）は、解決できないなら、遮断する。
// 名前を相手（運用者のプロキシ・ゲートウェイ）が解決するときは、手元の DNS が失敗するのは普通なので、これまでどおり通す。
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_EGRESS_GATEWAY'];
let saved: Record<string, string | undefined> = {};
let lookup: ReturnType<typeof spyOn>;

const notFound = (host: string) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });

beforeEach(() => {
  saved = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  // テストの事前設定（test_preload.ts）は、外へ出ないよう、プロキシの環境変数に、架空のプロキシを入れている。直接つなぐ場合の検査なので、外す
  for (const key of touchedKeys) delete process.env[key];
  lookup = spyOn(dnsPromises, 'lookup');
});

afterEach(() => {
  lookup.mockRestore();
  for (const key of touchedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('validateHostIpDns: 名前を解決できないとき', () => {
  test('既定は、これまでどおり、通す（空を返す）', async () => {
    lookup.mockRejectedValue(notFound('open-fail.example'));
    expect(await validateHostIpDns('open-fail.example')).toEqual([]);
  });

  test('failClosed: 解決に失敗したら、遮断する', async () => {
    lookup.mockRejectedValue(notFound('closed-fail.example'));
    await expect(validateHostIpDns('closed-fail.example', { failClosed: true })).rejects.toThrow('解決できない');
  });

  test('failClosed: 答えが空でも、遮断する（既定は、空を返す）', async () => {
    lookup.mockResolvedValue([]);
    await expect(validateHostIpDns('closed-empty.example', { failClosed: true })).rejects.toThrow('解決できない');
    expect(await validateHostIpDns('open-empty.example')).toEqual([]);
  });

  test('failClosed でも、公開の IP に解決できれば、通る', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await validateHostIpDns('closed-public.example', { failClosed: true })).toEqual(['93.184.216.34']);
  });

  test('内部の IP に解決されたら、どちらでも、DNS Rebinding として遮断する', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(validateHostIpDns('rebind-open.example')).rejects.toThrow('DNS Rebinding');
    await expect(validateHostIpDns('rebind-closed.example', { failClosed: true })).rejects.toThrow('DNS Rebinding');
  });

  test('内部への取得を許す設定（SORA_FETCH_ALLOW_PRIVATE_NETWORK=true）のときは、検査しない', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    lookup.mockRejectedValue(notFound('local-ok.example'));
    expect(await validateHostIpDns('local-ok.example', { failClosed: true })).toEqual([]);
  });
});

describe('fetchWithSafeRedirects: 名前を解決できないとき', () => {
  const hosts = ['direct-fail.example', 'proxied-fail.example', 'bypassed-fail.example'];
  afterEach(async () => {
    for (const host of hosts) await closeHttpSession(host);
  });

  test('直接つなぐとき（プロキシもゲートウェイも無い）は、取得を始めずに、遮断する', async () => {
    lookup.mockRejectedValue(notFound('direct-fail.example'));
    await expect(fetchWithSafeRedirects('http://direct-fail.example/', 3000, 0)).rejects.toThrow('解決できない');
  });

  test('運用者のプロキシ越しのときは、これまでどおり、通す（名前は、プロキシが解決する）', async () => {
    process.env.SORA_PROXY_URL = 'http://127.0.0.1:9'; // 閉じたポート。取得は、プロキシへの接続の失敗で終わる
    lookup.mockRejectedValue(notFound('proxied-fail.example'));
    const error = await fetchWithSafeRedirects('http://proxied-fail.example/', 3000, 0).then(
      () => '',
      (reason: unknown) => String(reason),
    );
    expect(error).not.toBe('');
    expect(error).not.toContain('解決できない');
  });

  test('プロキシがあっても、NO_PROXY の宛先は、直接つなぐので、遮断する', async () => {
    process.env.SORA_PROXY_URL = 'http://127.0.0.1:9';
    process.env.NO_PROXY = 'bypassed-fail.example';
    lookup.mockRejectedValue(notFound('bypassed-fail.example'));
    await expect(fetchWithSafeRedirects('http://bypassed-fail.example/', 3000, 0)).rejects.toThrow('解決できない');
  });
});

describe('setupPageSecurity: ページの副要求の宛先の名前を解決できないとき', () => {
  /** 要求の傍受を、手元で動かせる、偽のページ。要求を 1 つ流し、abort か continue のどちらが呼ばれたかを返す */
  async function interceptRequest(url: string): Promise<{ aborted?: string; continued: boolean }> {
    let handler: ((req: unknown) => Promise<void>) | undefined;
    const page = {
      setRequestInterception: async () => {},
      on: (_event: string, listener: (req: unknown) => Promise<void>) => {
        handler = listener;
      },
      mainFrame: () => ({}),
    } as unknown as Page;
    await setupPageSecurity(page);
    const result: { aborted?: string; continued: boolean } = { continued: false };
    await handler?.({
      url: () => url,
      resourceType: () => 'document',
      isNavigationRequest: () => true,
      frame: () => ({}),
      headers: () => ({}),
      continue: () => {
        result.continued = true;
      },
      abort: (reason: string) => {
        result.aborted = reason;
      },
    });
    return result;
  }

  test('直接つなぐとき（プロキシもゲートウェイも無い）は、要求を中止する', async () => {
    lookup.mockRejectedValue(notFound('page-direct.example'));
    expect(await interceptRequest('http://page-direct.example/x')).toEqual({ aborted: 'namenotresolved', continued: false });
  });

  test('運用者のプロキシ越しのときは、これまでどおり、要求を通す', async () => {
    process.env.SORA_PROXY_URL = 'http://127.0.0.1:9';
    lookup.mockRejectedValue(notFound('page-proxied.example'));
    expect(await interceptRequest('http://page-proxied.example/x')).toEqual({ continued: true });
  });

  test('プロキシがあっても、NO_PROXY の宛先は、ブラウザが直接つなぐので、要求を中止する', async () => {
    process.env.SORA_PROXY_URL = 'http://127.0.0.1:9';
    process.env.NO_PROXY = 'page-bypassed.example';
    lookup.mockRejectedValue(notFound('page-bypassed.example'));
    expect(await interceptRequest('http://page-bypassed.example/x')).toEqual({ aborted: 'namenotresolved', continued: false });
  });

  test('出口のゲートウェイを使うときも、これまでどおり、要求を通す（名前は、ゲートウェイが解決する）', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'on';
    lookup.mockRejectedValue(notFound('page-gateway.example'));
    expect(await interceptRequest('http://page-gateway.example/x')).toEqual({ continued: true });
  });
});
