import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as dnsPromises } from 'dns';
import type { Page } from 'puppeteer-core';
import {
  clearDnsValidationCache,
  dnsValidationCacheSize,
  rememberDnsValidation,
  setupPageSecurity,
  validateHostIpDns,
} from './browser_engine.js';
import { clearThrottledHosts, throttleDomain, throttledHostCount } from './http_fetcher.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * ホスト名ごとの Map の上限（設計 6。穴 24）。throttleDomain の domainLastAccess と、DNS の検証結果の dnsValidationCache は、
 * 別々のホスト名を渡すたびに増え、削除も上限も無かった（E38: 20 万ホストで 21.7 MiB）。
 * 追加のたびに、上限を超えていれば、役目を終えた項目を先に外し、まだ超えていれば、入れた順に古い方から外す。
 */

beforeEach(() => {
  clearThrottledHosts();
  clearDnsValidationCache();
});
afterEach(() => {
  clearThrottledHosts();
  clearDnsValidationCache();
});

describe('throttleDomain の覚え（domainLastAccess）', () => {
  test('別々のホスト名を送り続けても、上限を超えて増えない', async () => {
    for (let i = 0; i < 50; i++) await throttleDomain(`http://h${i}.example/`, 10);
    expect(throttledHostCount()).toBeLessThanOrEqual(10);
    expect(throttledHostCount()).toBeGreaterThan(0);
  });

  test('間隔（150ms）を過ぎた項目は、動きを変えないので、先に外す。間隔の中の項目は残す', async () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      for (let i = 0; i < 4; i++) await throttleDomain(`http://old${i}.example/`, 5); // 4 件
      now.mockReturnValue(1_000_000 + 149); // まだ間隔の中
      await throttleDomain('http://live-a.example/', 5); // 5 件（上限ちょうど）
      expect(throttledHostCount()).toBe(5);
      now.mockReturnValue(1_000_000 + 1_000); // old0〜3 は 1,000ms 前、live-a は 851ms 前。どれも間隔を過ぎた
      await throttleDomain('http://new.example/', 5); // 6 件 → 古い 5 件を全部外して 1 件
      expect(throttledHostCount()).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  test('間隔の中の項目は、上限を超えるときだけ、入れた順に古い方から外す', async () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(2_000_000); // 全部が同じ時刻 = 全部が間隔の中
      for (let i = 0; i < 6; i++) await throttleDomain(`http://same${i}.example/`, 5);
      // 6 件目で 6 > 5 → 9 割 = 4 件まで。古い方（same0〜1）が外れ、same2〜5 が残る
      expect(throttledHostCount()).toBe(4);
      const waited = await timeThrottle('http://same5.example/', now, 2_000_000); // 残っている最新は、まだ間隔の中 → 待つ
      expect(waited).toBeGreaterThan(0);
      const fresh = await timeThrottle('http://same0.example/', now, 2_000_000); // 外れた項目は、初めてのホストと同じ → 待たない
      expect(fresh).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  test('もう一度来たホストは、入れた順の最後に動く（よく来るホストは残る）', async () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(3_000_000);
      for (const h of ['a', 'b', 'c']) await throttleDomain(`http://${h}.example/`, 4);
      await throttleDomain('http://a.example/', 4); // a を、もう一度。順番は b, c, a
      await throttleDomain('http://d.example/', 4); // 4 件（上限ちょうど）: b, c, a, d
      await throttleDomain('http://e.example/', 4); // 5 件 → 3 件まで: b・c を外し、a, d, e が残る
      expect(throttledHostCount()).toBe(3);
      expect(await timeThrottle('http://a.example/', now, 3_000_000)).toBeGreaterThan(0); // 残っている
      expect(await timeThrottle('http://b.example/', now, 3_000_000)).toBe(0); // 外れた
    } finally {
      now.mockRestore();
    }
  });

  test('間隔のちょうど 150ms 前の項目も、待たないので、先に外す', async () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(4_000_000);
      for (const h of ['a', 'b', 'c']) await throttleDomain(`http://${h}.example/`, 3);
      now.mockReturnValue(4_000_150); // 150ms 後。もう待たない（elapsed < 150 が偽）
      await throttleDomain('http://d.example/', 3); // 4 件 → 古い 3 件を外して 1 件
      expect(throttledHostCount()).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  test('間隔（150ms）の中の項目は、150ms に近くても外さない（100ms 前の項目も、まだ待たせる）', async () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(5_000_000);
      await throttleDomain('http://x.example/', 2); // 150ms 後には、間隔を過ぎる
      now.mockReturnValue(5_000_040);
      await throttleDomain('http://y.example/', 2); // 150ms 後でも、110ms 前: まだ間隔の中
      now.mockReturnValue(5_000_150);
      await throttleDomain('http://z.example/', 2); // 3 件 → x だけが古い。y（110ms 前）は残す
      expect(throttledHostCount()).toBe(2);
      expect(await timeThrottle('http://y.example/', now, 5_000_150)).toBeGreaterThan(0); // y は、まだ待たせる
    } finally {
      now.mockRestore();
    }
  });

  test('上限を渡さず、SORA_ISOLATION が不正でも、投げない（これまでどおり、throttleDomain は投げない）', async () => {
    await withEnv({ SORA_ISOLATION: 'bogus' }, async () => {
      await expect(throttleDomain('http://bogus-level.example/')).resolves.toBeUndefined();
    });
  });

  test('待ったあとの時刻を覚える: 同じホストへの 3 回目も、間隔を空ける', async () => {
    await throttleDomain('http://three.example/', 100); // 1 回目: 待たない
    await throttleDomain('http://three.example/', 100); // 2 回目: 150ms 待つ
    const start = performance.now();
    await throttleDomain('http://three.example/', 100); // 3 回目: 2 回目が終わった時刻から数えて、また待つ
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
  });

  test('上限を渡さないときは、水準の値（strict は 2,000）で押さえる', async () => {
    await withEnv({ SORA_ISOLATION: 'strict' }, async () => {
      for (let i = 0; i < STRICT_LIMITS.hostMapMaxEntries + 500; i++) await throttleDomain(`http://s${i}.example/`);
      expect(throttledHostCount()).toBeLessThanOrEqual(STRICT_LIMITS.hostMapMaxEntries);
      expect(throttledHostCount()).toBeGreaterThan(STRICT_LIMITS.hostMapMaxEntries / 2);
    });
  });

  test('同じホストへの 2 回目は、これまでどおり、間隔（150ms）を空ける', async () => {
    await throttleDomain('http://same-host.example/', 100);
    const start = performance.now();
    await throttleDomain('http://same-host.example/', 100);
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
  });

  test('URL でない入力は、何も覚えず、投げない', async () => {
    await throttleDomain('not a url', 10);
    expect(throttledHostCount()).toBe(0);
  });
});

/** 時計を固定したまま、throttleDomain が待った時間（setTimeout に渡した ms）を返す。待たないなら 0 */
async function timeThrottle(url: string, now: ReturnType<typeof spyOn>, at: number): Promise<number> {
  now.mockReturnValue(at);
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  const calls = () => timer.mock.calls.filter((call) => typeof call[1] === 'number' && (call[1] as number) > 0);
  try {
    await throttleDomain(url, 100);
    const first = calls()[0];
    return first ? (first[1] as number) : 0;
  } finally {
    timer.mockRestore();
  }
}

describe('DNS の検証結果の覚え（dnsValidationCache）', () => {
  const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
  let lookup: ReturnType<typeof spyOn>;
  let savedAllow: string | undefined;
  beforeEach(() => {
    savedAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    lookup = spyOn(dnsPromises, 'lookup');
    lookup.mockResolvedValue(PUBLIC);
  });
  afterEach(() => {
    lookup.mockRestore();
    if (savedAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = savedAllow;
  });

  /** その時刻に、覚えた結果が使われるか（使われるなら、名前を引かない）。引いたときは、そのホストを覚え直す */
  async function isRemembered(host: string, at: number): Promise<boolean> {
    const now = spyOn(Date, 'now').mockReturnValue(at);
    try {
      lookup.mockClear();
      await validateHostIpDns(host);
      return lookup.mock.calls.length === 0;
    } finally {
      now.mockRestore();
    }
  }

  test('期限（60 秒）を過ぎた項目を先に外す。期限内の項目は、上限以下なら残す', () => {
    rememberDnsValidation('a.example', ['1.1.1.1'], 1_000, 3);
    rememberDnsValidation('b.example', ['1.1.1.1'], 1_000, 3);
    rememberDnsValidation('c.example', ['1.1.1.1'], 50_000, 3); // 3 件（上限ちょうど）
    expect(dnsValidationCacheSize()).toBe(3);
    rememberDnsValidation('d.example', ['1.1.1.1'], 61_001, 3); // a・b は 61,000 に切れた。c は 110,000 まで
    expect(dnsValidationCacheSize()).toBe(2); // c, d
  });

  test('期限切れだけで上限に収まるなら、期限内の項目は 1 つも外さない（9 割までは減らさない）', () => {
    rememberDnsValidation('old.example', ['1.1.1.1'], 0, 10); // 60,000 に切れる
    for (let i = 1; i <= 9; i++) rememberDnsValidation(`live${i}.example`, ['1.1.1.1'], 30_000, 10); // 10 件
    expect(dnsValidationCacheSize()).toBe(10);
    rememberDnsValidation('new.example', ['1.1.1.1'], 60_000, 10); // 11 件 → old（ちょうど期限）だけ外して 10 件
    expect(dnsValidationCacheSize()).toBe(10);
  });

  test('ちょうど期限の時刻の項目も、期限切れとして外す（読む側は、期限を過ぎていないものだけ使う）', () => {
    rememberDnsValidation('a.example', ['1.1.1.1'], 0, 1);
    rememberDnsValidation('b.example', ['1.1.1.1'], 60_000, 1); // a の期限 = 60,000 ちょうど
    expect(dnsValidationCacheSize()).toBe(1);
  });

  test('期限内の項目だけで上限を超えたら、入れた順に古い方から、上限の 9 割まで外す', async () => {
    for (let i = 0; i < 11; i++) rememberDnsValidation(`h${i}.example`, ['1.1.1.1'], 5_000, 10);
    expect(dnsValidationCacheSize()).toBe(9);
    expect(await isRemembered('h10.example', 5_000)).toBe(true); // 最新は残っている
    expect(await isRemembered('h2.example', 5_000)).toBe(true); // 外れるのは h0・h1 だけ
    expect(await isRemembered('h0.example', 5_000)).toBe(false);
    expect(await isRemembered('h1.example', 5_000)).toBe(false);
  });

  test('書き直した項目は、入れた順の最後に動き、新しい期限になる', async () => {
    rememberDnsValidation('a.example', ['1.1.1.1'], 1_000, 4);
    rememberDnsValidation('b.example', ['1.1.1.1'], 1_000, 4);
    rememberDnsValidation('c.example', ['1.1.1.1'], 1_000, 4);
    rememberDnsValidation('a.example', ['2.2.2.2'], 1_000, 4); // 順番は b, c, a
    rememberDnsValidation('d.example', ['1.1.1.1'], 1_000, 4); // b, c, a, d
    rememberDnsValidation('e.example', ['1.1.1.1'], 1_000, 4); // 5 件 → 3 件: b・c を外し a, d, e
    expect(dnsValidationCacheSize()).toBe(3);
    expect(await isRemembered('a.example', 1_000)).toBe(true);
    expect(await isRemembered('d.example', 1_000)).toBe(true);
    expect(await isRemembered('e.example', 1_000)).toBe(true);
    expect(await isRemembered('b.example', 1_000)).toBe(false);
    expect(await isRemembered('c.example', 1_000)).toBe(false);
  });

  test('書き直すと、期限が新しくなる', async () => {
    rememberDnsValidation('a.example', ['1.1.1.1'], 0, 10); // 60,000 まで
    rememberDnsValidation('a.example', ['1.1.1.1'], 50_000, 10); // 110,000 まで
    expect(await isRemembered('a.example', 70_000)).toBe(true);
  });

  test('validateHostIpDns: 別々のホストを引き続けても、水準の上限（strict は 2,000）を超えない', async () => {
    await withEnv({ SORA_ISOLATION: 'strict' }, async () => {
      for (let i = 0; i < STRICT_LIMITS.hostMapMaxEntries + 300; i++) await validateHostIpDns(`dns${i}.example`);
      expect(dnsValidationCacheSize()).toBeLessThanOrEqual(STRICT_LIMITS.hostMapMaxEntries);
      expect(dnsValidationCacheSize()).toBeGreaterThan(STRICT_LIMITS.hostMapMaxEntries / 2);
    });
  });

  test('validateHostIpDns: 覚えた結果は、これまでどおり、期限の中で使い回す', async () => {
    await validateHostIpDns('reuse.example');
    await validateHostIpDns('reuse.example');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('setupPageSecurity（ページの副要求の検査）も、同じ上限で押さえる', async () => {
    await withEnv({ SORA_ISOLATION: 'strict' }, async () => {
      let handler: ((req: unknown) => Promise<void>) | undefined;
      const page = {
        setRequestInterception: async () => {},
        on: (_event: string, listener: (req: unknown) => Promise<void>) => {
          handler = listener;
        },
        mainFrame: () => ({}),
      } as unknown as Page;
      await setupPageSecurity(page);
      for (let i = 0; i < STRICT_LIMITS.hostMapMaxEntries + 300; i++) {
        await handler?.({
          url: () => `http://sub${i}.example/x`,
          resourceType: () => 'document',
          isNavigationRequest: () => true,
          frame: () => ({}),
          headers: () => ({}),
          continue: () => {},
          abort: () => {},
        });
      }
      expect(dnsValidationCacheSize()).toBeLessThanOrEqual(STRICT_LIMITS.hostMapMaxEntries);
      expect(dnsValidationCacheSize()).toBeGreaterThan(STRICT_LIMITS.hostMapMaxEntries / 2);
    });
  });
});

describe('水準ごとの既定', () => {
  test('strict は standard より小さい。値は、strict 2,000・standard 10,000', () => {
    expect(STRICT_LIMITS.hostMapMaxEntries).toBeLessThan(STANDARD_LIMITS.hostMapMaxEntries);
    expect(STRICT_LIMITS.hostMapMaxEntries).toBe(2000);
    expect(STANDARD_LIMITS.hostMapMaxEntries).toBe(10_000);
  });
});
