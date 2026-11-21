import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as dnsPromises } from 'dns';
import type { Page } from 'puppeteer-core';
import { closeSharedBrowser, resolveChromiumPath, setupPageSecurity, validateHostIpDns } from './browser_engine.js';
import { handleBrowserSessionAction } from './browser_session.js';
import { deliverWebhook } from './enrichment.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * URL の事前検査（取得の前に、内部・遮断する宛先を断る検査）が断った回数を、理由別に数える（設計 8）。
 * 理由は、出口のゲートウェイの `sora_egress_denied_<理由>_total` と同じ名前（private_ip・blocked_host・dns）で、
 * カウンターは `sora_precheck_denied_<理由>_total`。数えるのは、断った 1 回につき 1 つだけ（理由は、IP が先、次に名前）。
 */

const names = (): Record<string, number> =>
  Object.fromEntries(Object.entries(getSecurityMetrics()).filter(([name]) => name.startsWith('sora_precheck_denied_')));

/** 直接つなぐ環境（プロキシもゲートウェイも無い）。テストの事前設定が入れた架空のプロキシも外す */
const direct = {
  SORA_PROXY_URL: undefined,
  SORA_PROXY_LIST: undefined,
  HTTPS_PROXY: undefined,
  https_proxy: undefined,
  HTTP_PROXY: undefined,
  http_proxy: undefined,
  ALL_PROXY: undefined,
  all_proxy: undefined,
  NO_PROXY: undefined,
  no_proxy: undefined,
  SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined,
  SORA_EGRESS_GATEWAY: undefined,
};
const inDirect = <T>(fn: () => Promise<T> | T) => withEnv(direct, fn);

const notFound = (host: string) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });

let lookup: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetSecurityMetrics();
  lookup = spyOn(dnsPromises, 'lookup');
});
afterEach(() => {
  lookup.mockRestore();
  resetSecurityMetrics();
});

describe('validateHostIpDns（静的な取得・browser_action の navigate が通る検査）', () => {
  test('内部の IP リテラルは private_ip で数える', () =>
    inDirect(async () => {
      await expect(validateHostIpDns('10.0.0.5')).rejects.toThrow('遮断');
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('ゲートウェイと同じ見分け方: IP が先（クラウドのメタデータの IP は、リンクローカルなので private_ip）', () =>
    inDirect(async () => {
      await expect(validateHostIpDns('169.254.169.254')).rejects.toThrow('遮断');
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('遮断する名前（localhost・.internal）は blocked_host で数える', () =>
    inDirect(async () => {
      await expect(validateHostIpDns('localhost')).rejects.toThrow('遮断');
      await expect(validateHostIpDns('metadata.google.internal')).rejects.toThrow('遮断');
      expect(names()).toEqual({ sora_precheck_denied_blocked_host_total: 2 });
    }));

  test('公開の名前が内部の IP に解決されたら（DNS Rebinding）、private_ip で 1 回だけ数える（答えが 2 つ内部でも）', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([
        { address: '10.0.0.5', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ]);
      await expect(validateHostIpDns('rebind.example')).rejects.toThrow('DNS Rebinding');
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('名前を解決できず、遮断するとき（failClosed）は dns で数える', () =>
    inDirect(async () => {
      lookup.mockRejectedValue(notFound('closed.example'));
      await expect(validateHostIpDns('closed.example', { failClosed: true })).rejects.toThrow('解決できない');
      expect(names()).toEqual({ sora_precheck_denied_dns_total: 1 });
    }));

  test('名前を解決できなくても、通すとき（既定）は数えない', () =>
    inDirect(async () => {
      lookup.mockRejectedValue(notFound('open.example'));
      expect(await validateHostIpDns('open.example')).toEqual([]);
      expect(names()).toEqual({});
    }));

  test('公開の IP・公開の名前は、通して、数えない', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      expect(await validateHostIpDns('public.example', { failClosed: true })).toEqual(['93.184.216.34']);
      await expect(validateHostIpDns('8.8.8.8')).resolves.toBeDefined(); // 公開の IP リテラル（DNS は上の答えを返す）
      expect(names()).toEqual({});
    }));

  test('内部への取得を許す設定（SORA_FETCH_ALLOW_PRIVATE_NETWORK=true）のときは、検査しないので、数えない', () =>
    withEnv({ ...direct, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
      expect(await validateHostIpDns('10.0.0.5')).toEqual([]);
      expect(names()).toEqual({});
    }));
});

describe('setupPageSecurity（ブラウザのページの副要求・遷移の検査）', () => {
  /** 要求の傍受を、手元で動かせる、偽のページ。要求を 1 つ流し、abort か continue のどちらが呼ばれたかを返す */
  async function intercept(url: string, resourceType = 'document'): Promise<{ aborted?: string; continued: boolean }> {
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
      resourceType: () => resourceType,
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

  test('内部の IP リテラルへの要求は中止して、private_ip で数える', () =>
    inDirect(async () => {
      expect(await intercept('http://127.0.0.1:8080/x')).toEqual({ aborted: 'accessdenied', continued: false });
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('遮断する名前への要求は中止して、blocked_host で数える', () =>
    inDirect(async () => {
      expect(await intercept('http://localhost/')).toEqual({ aborted: 'accessdenied', continued: false });
      expect(names()).toEqual({ sora_precheck_denied_blocked_host_total: 1 });
    }));

  test('公開の名前が内部の IP に解決されたら、中止して、private_ip で 1 回だけ数える', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([
        { address: '10.0.0.5', family: 4 },
        { address: '10.0.0.6', family: 4 },
      ]);
      expect(await intercept('http://rebind-page.example/x')).toEqual({ aborted: 'accessdenied', continued: false });
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('直接つなぐとき、名前を解決できなければ、中止して、dns で数える', () =>
    inDirect(async () => {
      lookup.mockRejectedValue(notFound('page-direct.example'));
      expect(await intercept('http://page-direct.example/x')).toEqual({ aborted: 'namenotresolved', continued: false });
      expect(names()).toEqual({ sora_precheck_denied_dns_total: 1 });
    }));

  test('運用者のプロキシ越しなら、名前を解決できなくても通す。数えない（名前は、プロキシが解決する）', () =>
    withEnv({ ...direct, SORA_PROXY_URL: 'http://127.0.0.1:9' }, async () => {
      lookup.mockRejectedValue(notFound('page-proxied.example'));
      expect(await intercept('http://page-proxied.example/x')).toEqual({ continued: true });
      expect(names()).toEqual({});
    }));

  test('公開の宛先・data: は通して、数えない', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      expect(await intercept('https://public-page.example/x')).toEqual({ continued: true });
      expect(await intercept('data:text/plain,hello')).toEqual({ continued: true });
      expect(names()).toEqual({});
    }));

  test('内部への取得を許す設定（SORA_FETCH_ALLOW_PRIVATE_NETWORK=true）のときは、検査しないので、通して、数えない', () =>
    withEnv({ ...direct, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
      expect(await intercept('http://127.0.0.1:8080/x')).toEqual({ continued: true });
      expect(names()).toEqual({});
    }));

  test('広告・トラッカー・メディア・http 以外を中止するのは、内部の宛先の拒否ではないので、数えない', () =>
    inDirect(async () => {
      expect(await intercept('https://www.google-analytics.com/collect')).toEqual({ aborted: 'blockedbyclient', continued: false });
      expect(await intercept('https://cdn.example/video', 'media')).toEqual({ aborted: 'blockedbyclient', continued: false });
      expect(await intercept('ftp://files.example/x')).toEqual({ aborted: 'blockedbyclient', continued: false });
      expect(names()).toEqual({});
    }));
});

describe('deliverWebhook（webhook の宛先の検査）', () => {
  /** 送信（fetch）を偽物（2xx を返す）にして、結果と、送信を試みた回数を返す。断った宛先には、送らない */
  const deliver = async (url: string): Promise<{ delivered: boolean; sent: number }> => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const send = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      return { delivered: await deliverWebhook(url, { ok: true }), sent: send.mock.calls.length };
    } finally {
      send.mockRestore();
      warn.mockRestore();
    }
  };

  test('内部の IP リテラルは断って（送らない）、private_ip で数える', () =>
    inDirect(async () => {
      expect(await deliver('http://127.0.0.1:9/hook')).toEqual({ delivered: false, sent: 0 });
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('遮断する名前は断って（送らない）、blocked_host で数える', () =>
    inDirect(async () => {
      expect(await deliver('http://localhost:9/hook')).toEqual({ delivered: false, sent: 0 });
      expect(names()).toEqual({ sora_precheck_denied_blocked_host_total: 1 });
    }));

  test('公開の名前が内部の IP に解決されたら断って（送らない）、private_ip で 1 回だけ数える', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([
        { address: '10.0.0.5', family: 4 },
        { address: '10.0.0.6', family: 4 },
      ]);
      expect(await deliver('https://rebind-hook.example/hook')).toEqual({ delivered: false, sent: 0 });
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('名前を解決できなければ断って（送らない）、dns で数える', () =>
    inDirect(async () => {
      lookup.mockRejectedValue(notFound('hook-fail.example'));
      expect(await deliver('https://hook-fail.example/hook')).toEqual({ delivered: false, sent: 0 });
      expect(names()).toEqual({ sora_precheck_denied_dns_total: 1 });
    }));

  test('公開の宛先は、送って、数えない', () =>
    inDirect(async () => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      expect(await deliver('https://public-hook.example/hook')).toEqual({ delivered: true, sent: 1 });
      expect(names()).toEqual({});
    }));

  test('内部への取得を許す設定のときは、検査しないので、送って、数えない', () =>
    withEnv({ ...direct, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
      expect(await deliver('http://127.0.0.1:9/hook')).toEqual({ delivered: true, sent: 1 });
      expect(names()).toEqual({});
    }));

  test('http・https 以外の URL は断る（送らない）が、内部の宛先の拒否ではないので、数えない', () =>
    inDirect(async () => {
      expect(await deliver('ftp://example.com/hook')).toEqual({ delivered: false, sent: 0 });
      expect(names()).toEqual({});
    }));
});

describe.skipIf(!resolveChromiumPath())('browser_action（実際の Chromium）', () => {
  afterEach(async () => {
    await closeSharedBrowser();
  });

  const act = (options: Record<string, unknown>) => handleBrowserSessionAction({ actions: [], extract: { markdown: false }, ...options } as never);

  test('最初の URL が内部の IP なら、断って、private_ip で 1 回だけ数える', () =>
    inDirect(async () => {
      await expect(act({ url: 'http://127.0.0.1:9/' })).rejects.toThrow('private or blocked host');
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));

  test('最初の URL が遮断する名前なら、断って、blocked_host で 1 回だけ数える', () =>
    inDirect(async () => {
      await expect(act({ url: 'http://localhost:9/' })).rejects.toThrow('private or blocked host');
      expect(names()).toEqual({ sora_precheck_denied_blocked_host_total: 1 });
    }));

  test('内部への取得を許す設定のときは、最初の URL を検査しないので、数えない', () =>
    withEnv({ ...direct, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
      // 検査は通り、閉じたポートへのページの移動が失敗する。内部の宛先を断ったのではない
      const error = await act({ url: 'http://127.0.0.1:9/' }).then(
        () => '',
        (reason: unknown) => String(reason),
      );
      expect(error).not.toContain('private or blocked host');
      expect(names()).toEqual({});
    }));

  test('navigate の URL が内部の IP なら、断って、private_ip で 1 回だけ数える（検査は validateHostIpDns の 1 か所）', () =>
    inDirect(async () => {
      await act({ actions: [{ type: 'navigate', url: 'http://10.0.0.5/' }] }).catch(() => undefined);
      expect(names()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
    }));
});
