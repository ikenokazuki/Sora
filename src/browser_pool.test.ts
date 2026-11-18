import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ResourceBusyError } from './errors.js';
import { BrowserHandle, BrowserPool, type BrowserLike, type ChildLike, HandleRetiredError } from './browser_pool.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * ブラウザの寿命の管理（BrowserHandle）と、tenant ごとの池（BrowserPool。設計 2。段階 6）。
 * 実際の Chromium は使わず、偽のブラウザで確かめる（起動・終了・子プロセスの終わりを、テストが決める）。
 */

class FakeChild extends EventEmitter implements ChildLike {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  /** true なら、SIGKILL で終わる（凍ったプロセスでも、SIGKILL は効く） */
  killExits = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? 'SIGTERM'));
    if (this.killExits && signal === 'SIGKILL' && this.exitCode === null) queueMicrotask(() => this.exit());
    return true;
  }
  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let serial = 0;
class FakeBrowser implements BrowserLike {
  readonly id = ++serial;
  connected = true;
  contexts = 1;
  pageCount = 1;
  closed = false;
  readonly child = new FakeChild();
  /** true なら、close() のあとも、子プロセスは終わらない（テストが exit() を呼ぶまで） */
  holdExit = false;
  /** version() の往復の時間（ミリ秒） */
  versionDelay = 0;
  /** pages() の往復の時間（ミリ秒）。Infinity なら、返らない（凍っている） */
  pagesDelay = 0;
  /** true なら、close() が返らない（凍っている）。closed は、呼ばれたことの印 */
  closeHangs = false;
  constructor(readonly slot: number | undefined) {}
  async version(): Promise<string> {
    if (this.versionDelay) await sleep(this.versionDelay);
    if (!this.connected && !this.versionDelay) throw new Error('disconnected');
    return 'fake';
  }
  async close(): Promise<void> {
    this.connected = false;
    this.closed = true;
    if (this.closeHangs) return new Promise<void>(() => undefined);
    if (!this.holdExit) queueMicrotask(() => this.child.exit());
  }
  process(): ChildLike {
    return this.child;
  }
  browserContexts(): unknown[] {
    return new Array(this.contexts);
  }
  async pages(): Promise<unknown[]> {
    if (this.pagesDelay === Number.POSITIVE_INFINITY) return new Promise<unknown[]>(() => undefined);
    if (this.pagesDelay) await sleep(this.pagesDelay);
    return new Array(this.pageCount);
  }
}

/** 条件が成り立つまで待つ（固定の時間を置かない。成り立たなければ、時間切れで失敗する） */
async function until(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件が、時間内に成り立たなかった');
    await sleep(5);
  }
}

interface Rig {
  launched: FakeBrowser[];
  inUse: Set<string>;
  ttl: { value: number };
  max: { value: number };
  handleFor: (key: string) => BrowserHandle<FakeBrowser, undefined>;
  pool: BrowserPool<FakeBrowser, undefined>;
  hold: { value: boolean };
  launchDelay: { value: number };
  launchFails: { value: boolean };
  /** reap（uid のプロセスが残っていないことの確認）。calls は、渡された番号。result が false なら、残っている */
  reap: { calls: number[]; result: boolean };
  waitMs: { value: number };
}

function rig(graceMs = 60): Rig {
  const launched: FakeBrowser[] = [];
  const inUse = new Set<string>();
  const ttl = { value: 0 };
  const max = { value: 3 };
  const hold = { value: false };
  const launchDelay = { value: 0 };
  const launchFails = { value: false };
  const reap = { calls: [] as number[], result: true };
  const waitMs = { value: 0 };
  const makeHandle = (key: string, slot: number | undefined, onReleased?: (handle: BrowserHandle<FakeBrowser, undefined>) => void) =>
    new BrowserHandle<FakeBrowser, undefined>(
      key,
      slot,
      {
        launch: async (s) => {
          if (launchDelay.value) await sleep(launchDelay.value);
          if (launchFails.value) throw new Error('launch failed');
          const browser = new FakeBrowser(s);
          browser.holdExit = hold.value;
          launched.push(browser);
          return browser;
        },
        inUse: () => inUse.has(key),
        idleTtlMs: () => ttl.value,
        retireWhenIdle: slot !== undefined,
        exitGraceMs: graceMs,
        reap: async (reapSlot) => {
          reap.calls.push(reapSlot);
          return reap.result;
        },
      },
      onReleased,
    );
  const pool = new BrowserPool<FakeBrowser, undefined>({ max: () => max.value, makeHandle, waitMs: () => waitMs.value });
  const shared = makeHandle('*shared*', undefined);
  return { launched, inUse, ttl, max, hold, launchDelay, launchFails, reap, waitMs, pool, handleFor: () => shared };
}

afterEach(() => resetSecurityMetrics());

describe('BrowserHandle: 1 つのブラウザの寿命（共有ブラウザの、これまでの挙動）', () => {
  test('同時に get() を呼んでも、起動は 1 つで、全員が同じブラウザを受け取る', async () => {
    const r = rig();
    r.launchDelay.value = 20;
    const handle = r.handleFor('s');
    const results = await Promise.all(Array.from({ length: 5 }, () => handle.get(undefined)));
    expect(r.launched).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
  });

  test('起動済みなら、再利用する。接続が切れていたら、起動し直す', async () => {
    const r = rig();
    const handle = r.handleFor('s');
    const a = await handle.get(undefined);
    expect(await handle.get(undefined)).toBe(a);
    a.connected = false;
    const b = await handle.get(undefined);
    expect(b).not.toBe(a);
    expect(r.launched).toHaveLength(2);
  });

  test('起動に失敗したら、待っている全員に同じ失敗が伝わり、次の呼び出しで起動をやり直せる', async () => {
    const r = rig();
    const handle = r.handleFor('s');
    r.launchFails.value = true;
    r.launchDelay.value = 10;
    const results = await Promise.allSettled([handle.get(undefined), handle.get(undefined)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    r.launchFails.value = false;
    expect((await handle.get(undefined)).connected).toBe(true);
  });

  test('close(): 起動の最中なら、完了を待ってから閉じる（管理されないブラウザが残らない）。閉じたあとの get() は、新しく起動する', async () => {
    const r = rig();
    r.launchDelay.value = 20;
    const handle = r.handleFor('s');
    const launching = handle.get(undefined);
    await handle.close();
    expect(r.launched[0].closed).toBe(true); // 起動の完了を待って、閉じた
    // 閉じたあとなら、get() は、起動し直して、新しいブラウザを返してよい（管理されないブラウザが残らないよう、もう一度閉じる）
    await launching.catch(() => undefined);
    await handle.close();
    expect(r.launched.every((browser) => browser.closed)).toBe(true);
    expect(handle.connected).toBe(false);
    r.launchDelay.value = 0;
    const next = await handle.get(undefined);
    expect(next.connected).toBe(true);
  });

  test('無操作の時間（idleTtlMs）が過ぎたら閉じる。使っている（枠を持っている）間は閉じない', async () => {
    const r = rig();
    r.ttl.value = 60;
    const handle = r.handleFor('*shared*');
    const browser = await handle.get(undefined);
    r.inUse.add('*shared*');
    await sleep(200);
    expect(browser.connected).toBe(true);
    r.inUse.delete('*shared*');
    await sleep(200);
    expect(browser.connected).toBe(false);
  });

  test('ページ・コンテキストが開いている間は閉じない', async () => {
    const r = rig();
    r.ttl.value = 60;
    const handle = r.handleFor('*shared*');
    const browser = await handle.get(undefined);
    browser.contexts = 2;
    await sleep(200);
    expect(browser.connected).toBe(true);
    browser.contexts = 1;
    await sleep(200);
    expect(browser.connected).toBe(false);
  });

  test('空き判定の最中に、別の呼び出しが同じブラウザを受け取ったら、閉じない', async () => {
    const r = rig();
    r.ttl.value = 80;
    const handle = r.handleFor('*shared*');
    const browser = await handle.get(undefined);
    const pages = browser.pages.bind(browser);
    browser.pages = async () => { await handle.get(undefined); return pages(); };
    await sleep(250);
    expect(browser.connected).toBe(true);
  });

  test('idleTtlMs が 0 なら、無操作では閉じない', async () => {
    const r = rig();
    r.ttl.value = 0;
    const handle = r.handleFor('*shared*');
    const browser = await handle.get(undefined);
    await sleep(150);
    expect(browser.connected).toBe(true);
  });

  test('usageCount が上限（200）以上なら、rotateIfWorn で閉じて、数え直す', async () => {
    const r = rig();
    const handle = r.handleFor('*shared*');
    const browser = await handle.get(undefined);
    for (let i = 0; i < 199; i++) handle.recordUsage();
    expect(handle.rotateIfWorn()).toBe(false);
    handle.recordUsage();
    expect(handle.rotateIfWorn()).toBe(true);
    await sleep(20);
    expect(browser.connected).toBe(false);
    expect(handle.usageCount).toBe(0);
  });
});

describe('BrowserPool: tenant ごとのブラウザのプロセス（別の番号 = 別の uid）', () => {
  test('tenant ごとに、別のブラウザを起動し、別の番号を渡す。同じ tenant には、同じブラウザを返す', async () => {
    const r = rig();
    const a = await r.pool.get('A', undefined);
    const b = await r.pool.get('B', undefined);
    expect(a).not.toBe(b);
    expect(await r.pool.get('A', undefined)).toBe(a);
    expect([a.slot, b.slot]).toEqual([0, 1]);
    expect(r.launched).toHaveLength(2);
  });

  test('同時に呼んでも、tenant ごとに 1 つだけ起動する', async () => {
    const r = rig();
    r.launchDelay.value = 20;
    const results = await Promise.all(['A', 'B', 'A', 'B', 'A'].map((key) => r.pool.get(key, undefined)));
    expect(r.launched).toHaveLength(2);
    expect(new Set(results).size).toBe(2);
  });

  test('同時に動いているプロセスは、同じ番号を持たない', async () => {
    const r = rig();
    r.max.value = 5;
    const browsers = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((key) => r.pool.get(key, undefined)));
    expect(new Set(browsers.map((browser) => browser.slot)).size).toBe(5);
  });

  test('上限に達したら、使っていないプロセスのうち、最も長く使われていないものを閉じて、その番号を渡す', async () => {
    const r = rig();
    r.max.value = 2;
    const a = await r.pool.get('A', undefined);
    await sleep(5);
    const b = await r.pool.get('B', undefined);
    await sleep(5);
    await r.pool.get('A', undefined); // A を、B より新しく使う
    const c = await r.pool.get('C', undefined);
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(c.slot).toBe(b.slot);
  });

  test('使っているプロセス（枠を持っている・ページが開いている）は閉じない。ほかが空いていれば、そちらを閉じる', async () => {
    const r = rig();
    r.max.value = 2;
    const a = await r.pool.get('A', undefined);
    await sleep(5);
    const b = await r.pool.get('B', undefined);
    r.inUse.add('A'); // A がいちばん古いが、使っている
    const c = await r.pool.get('C', undefined);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(true);
    expect(c.slot).toBe(b.slot);
    c.contexts = 2; // C は、セッション（開いたままのコンテキスト）で使っている
    await expect(r.pool.get('D', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
  });

  test('閉じてよいプロセスが無ければ、ResourceBusyError（process_limit・browser）で断り、カウンターを数える。何も壊さない', async () => {
    const r = rig();
    r.max.value = 2;
    const a = await r.pool.get('A', undefined);
    const b = await r.pool.get('B', undefined);
    r.inUse.add('A');
    r.inUse.add('B');
    const error = await r.pool.get('C', undefined).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error).toMatchObject({ reason: 'process_limit', resource: 'browser' });
    expect(String((error as Error).message)).toContain('2');
    expect(getSecurityMetrics()['sora_browser_busy_process_limit_total']).toBe(1);
    expect(a.closed || b.closed).toBe(false);
    expect(r.launched).toHaveLength(2);
  });

  test('番号を別の tenant に渡すのは、前のプロセスが完全に終わってから（同じ uid の 2 つのプロセスが並ばない）', async () => {
    const r = rig();
    r.max.value = 1;
    r.hold.value = true; // close() のあとも、子プロセスは終わらない
    const a = await r.pool.get('A', undefined);
    const events: string[] = [];
    const next = r.pool.get('B', undefined).then((browser) => { events.push(`B launched on slot ${browser.slot}`); return browser; });
    await sleep(50);
    expect(a.closed).toBe(true);
    expect(events).toEqual([]); // A のプロセスがまだ動いている間は、B を、同じ番号で起動しない
    expect(r.launched).toHaveLength(1);
    a.child.exit();
    const b = await next;
    expect(b.slot).toBe(a.slot);
    expect(events).toEqual([`B launched on slot ${a.slot}`]);
  });

  test('閉じても子プロセスが終わらなければ、強制終了（SIGKILL）して、終わるのを待つ', async () => {
    const r = rig(400); // 強制終了までの時間を長くして、「すぐには撃たない」を、時間の余裕をもって確かめる
    r.max.value = 1;
    r.hold.value = true;
    const a = await r.pool.get('A', undefined);
    const next = r.pool.get('B', undefined);
    await sleep(50);
    expect(a.child.killed).toEqual([]); // すぐには、強制終了しない（閉じる時間を与える）
    await until(() => a.child.killed.includes('SIGKILL'));
    a.child.exit();
    expect((await next).slot).toBe(a.slot);
  });

  test('無操作の時間が過ぎたら、そのプロセスは閉じて、番号を手放す', async () => {
    const r = rig();
    r.ttl.value = 50;
    const a = await r.pool.get('A', undefined);
    await until(() => a.closed && r.pool.size === 0);
    expect(a.closed).toBe(true);
    expect(r.pool.size).toBe(0);
    const b = await r.pool.get('B', undefined);
    expect(b.slot).toBe(a.slot);
  });

  test('使っている間は、無操作の時間が過ぎても閉じない', async () => {
    const r = rig();
    r.ttl.value = 50;
    const a = await r.pool.get('A', undefined);
    r.inUse.add('A');
    await sleep(250);
    expect(a.closed).toBe(false);
    expect(r.pool.size).toBe(1);
  });

  test('起動に失敗した tenant は、番号を持ち続けない（無操作の時間のあとに、番号を手放す）', async () => {
    const r = rig();
    r.ttl.value = 50;
    r.launchFails.value = true;
    await expect(r.pool.get('A', undefined)).rejects.toThrow('launch failed');
    expect(r.pool.size).toBe(1);
    await until(() => r.pool.size === 0);
    expect(r.pool.size).toBe(0);
  });

  test('閉じられた（役目を終えた）handle を持っていた呼び出しは、池から取り直して続ける', async () => {
    const r = rig();
    r.max.value = 2;
    const a = await r.pool.get('A', undefined);
    const handle = r.pool.handleOf('A')!;
    await handle.retire();
    await expect(handle.get(undefined)).rejects.toBeInstanceOf(HandleRetiredError);
    const again = await r.pool.get('A', undefined);
    expect(again).not.toBe(a);
    expect(again.connected).toBe(true);
  });

  test('役目を終える最中（プロセスがまだ動いている）の tenant が、また取りに来たら、終わるのを待ってから起動する（同じ番号で、2 つ目のプロセスを並べない）', async () => {
    const r = rig();
    r.hold.value = true;
    const a = await r.pool.get('A', undefined);
    const retiring = r.pool.handleOf('A')!.retire();
    const next = r.pool.get('A', undefined);
    await sleep(20);
    expect(r.launched).toHaveLength(1); // 古いプロセスが終わるまで、起動しない
    a.child.exit();
    await retiring;
    const again = await next;
    expect(r.launched).toHaveLength(2);
    expect(again).not.toBe(a);
    expect(again.slot).toBe(a.slot);
  });

  test('役目を終えたプロセスが、強制終了しても終わらないときは、同じ番号で起動せず、断る（番号は手放さない）', async () => {
    const r = rig();
    r.hold.value = true;
    await r.pool.get('A', undefined);
    void r.pool.handleOf('A')!.retire();
    const error = await r.pool.get('A', undefined).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error).toMatchObject({ reason: 'process_limit' });
    expect(r.launched).toHaveLength(1);
  });

  describe('役目を終えた handle が、新しいプロセスを起動しない（疎通確認・起動の最中に、役目を終えた）', () => {
    test('get() が version() を待っている間に retire() が走っても、新しいプロセスを起動しない', async () => {
      const r = rig();
      r.max.value = 1;
      const a = await r.pool.get('A', undefined);
      const handle = r.pool.handleOf('A')!;
      a.versionDelay = 40; // CDP の往復
      const getting = handle.get(undefined).then((browser) => ({ browser }), (error: unknown) => ({ error }));
      await sleep(5);
      await handle.retire();
      expect('error' in (await getting) && (await getting as { error: unknown }).error).toBeInstanceOf(HandleRetiredError);
      expect(r.launched).toHaveLength(1);
      // 番号は手放された。別の tenant が同じ番号で起動しても、動いているプロセスは 1 つだけ
      const b = await r.pool.get('B', undefined);
      expect(r.launched.filter((browser) => !browser.closed)).toEqual([b]);
    });

    test('起動している最中に retire() が走ったら、起動したプロセスは、受け取る人がいないので閉じる。呼び出しは、池から取り直して、新しいプロセスを 1 つだけ受け取る', async () => {
      const r = rig();
      r.max.value = 1;
      r.launchDelay.value = 40;
      const getting = r.pool.get('A', undefined);
      await until(() => r.pool.size === 1);
      const handle = r.pool.handleOf('A')!;
      await sleep(5);
      await handle.retire();
      const received = await getting; // 取り直して、新しいプロセスを受け取る
      expect(r.launched.length).toBe(2);
      expect(r.launched[0].closed).toBe(true); // 最初のプロセスは、誰にも渡されず、閉じられた
      expect(r.launched[0].child.exitCode).not.toBeNull();
      expect(received).toBe(r.launched[1]);
      expect(r.launched.filter((browser) => !browser.closed)).toEqual([received]);
      expect(received.slot).toBe(r.launched[0].slot);
    });
  });

  describe('凍った（応答しない）ブラウザが、ほかの tenant を止めない', () => {
    test('close() が返らない（凍った）ブラウザの追い出しは、時間の上限のあと、強制終了で終わる。そのあと、新しい tenant に渡す', async () => {
      const r = rig(60);
      r.max.value = 1;
      const a = await r.pool.get('A', undefined);
      a.closeHangs = true;
      a.child.killExits = true;
      const startedAt = Date.now();
      const b = await r.pool.get('B', undefined);
      expect(b.slot).toBe(a.slot);
      expect(a.child.killed).toContain('SIGKILL');
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    test('追い出しの最中（凍ったブラウザを閉じている間）も、ほかの tenant の get() は、待たされない', async () => {
      const r = rig(300);
      r.max.value = 3;
      const warm = await r.pool.get('W', undefined);
      const frozen = await r.pool.get('F', undefined);
      await r.pool.get('Z', undefined);
      frozen.closeHangs = true;
      frozen.child.killExits = true;
      r.inUse.add('W');
      r.inUse.add('Z');
      // F（最も古く使われた、使っていない）が、新しい tenant N に追い出される。閉じる間（300 ミリ秒の上限まで）、ロックを持たない
      const evicting = r.pool.get('N', undefined);
      await sleep(20);
      const startedAt = Date.now();
      expect(await r.pool.get('W', undefined)).toBe(warm); // 動いている tenant は、すぐ受け取れる
      expect(Date.now() - startedAt).toBeLessThan(150);
      await evicting;
    });

    test('close() が時間の上限までに返らなければ、そのあと、強制終了の前の待ちを省いて、すぐ SIGKILL を送る', async () => {
      const r = rig(300);
      r.max.value = 1;
      const a = await r.pool.get('A', undefined);
      a.closeHangs = true;
      const killedAt: number[] = [];
      a.child.killExits = true;
      const kill = a.child.kill.bind(a.child);
      a.child.kill = (signal?: NodeJS.Signals | number) => { killedAt.push(Date.now()); return kill(signal); };
      const startedAt = Date.now();
      await r.pool.handleOf('A')!.retire();
      expect(killedAt.length).toBeGreaterThan(0);
      // close の上限（300）のあと、すぐ（さらに 300 待った 600 ではなく）
      expect(killedAt[0] - startedAt).toBeGreaterThanOrEqual(250);
      expect(killedAt[0] - startedAt).toBeLessThan(480);
    });

    test('追い出しの候補が全部凍っていても、調べる待ちは 1 回分（並行して調べる）', async () => {
      const r = rig(60);
      r.max.value = 3;
      const browsers = [];
      for (const key of ['A', 'B', 'C']) browsers.push(await r.pool.get(key, undefined));
      for (const browser of browsers) {
        browser.pagesDelay = Number.POSITIVE_INFINITY;
        browser.child.killExits = true;
      }
      const startedAt = Date.now();
      await r.pool.get('D', undefined);
      // 調べる待ち（EVICT_PROBE_MS = 500）が 3 回分（1500）なら、遅すぎる
      expect(Date.now() - startedAt).toBeLessThan(1200);
    });

    test('pages() が返らない（凍った）使っていないブラウザは、閉じてよいものとみなす（追い出しが、止まらない）', async () => {
      const r = rig(60);
      r.max.value = 1;
      const a = await r.pool.get('A', undefined);
      a.pagesDelay = Number.POSITIVE_INFINITY;
      a.child.killExits = true;
      const b = await r.pool.get('B', undefined);
      expect(b.slot).toBe(a.slot);
    });

    test('開いたコンテキストがある（使用中の）ブラウザは、pages() が返らなくても、閉じてよいとはみなさない', async () => {
      const r = rig(60);
      r.max.value = 1;
      const a = await r.pool.get('A', undefined);
      a.contexts = 2;
      a.pagesDelay = Number.POSITIVE_INFINITY;
      await expect(r.pool.get('B', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
    });
  });

  describe('番号を手放す条件（その uid のプロセスが残っていないこと）', () => {
    test('番号を手放す前に、その番号の uid のプロセスが残っていないことを確かめる（reap。番号を渡す）', async () => {
      const r = rig();
      r.max.value = 3;
      const a = await r.pool.get('A', undefined);
      await r.pool.get('B', undefined);
      await r.pool.handleOf('B')!.retire();
      expect(r.reap.calls).toEqual([1]);
      expect(a.closed).toBe(false);
    });

    test('uid のプロセスが残っている（reap が false）間は、番号を手放さない（別の tenant に渡さない）', async () => {
      const r = rig();
      r.max.value = 1;
      r.reap.result = false;
      await r.pool.get('A', undefined);
      await expect(r.pool.get('B', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
      expect(r.pool.size).toBe(1);
      expect(r.launched).toHaveLength(1);
    });

    test('起動に失敗した handle も、番号を手放す前に、reap で確かめる（失敗した起動の残りのプロセス）', async () => {
      const r = rig();
      r.ttl.value = 30;
      r.launchFails.value = true;
      await expect(r.pool.get('A', undefined)).rejects.toThrow('launch failed');
      await until(() => r.pool.size === 0);
      expect(r.reap.calls).toEqual([0]);
    });

    test('共有ブラウザ（番号なし）は、reap しない', async () => {
      const r = rig();
      const shared = r.handleFor('s');
      await shared.get(undefined);
      await shared.close();
      expect(r.reap.calls).toEqual([]);
    });

    test('強制終了のあとも終わらなかった子プロセスが、あとで終わったら、そのときに番号を手放す', async () => {
      const r = rig();
      r.max.value = 1;
      r.hold.value = true;
      const a = await r.pool.get('A', undefined);
      await r.pool.handleOf('A')!.retire(); // 終わらないまま、retire が終わる
      expect(r.pool.size).toBe(1);
      a.child.exit(); // あとで終わった
      await until(() => r.pool.size === 0);
      const b = await r.pool.get('B', undefined);
      expect(b.slot).toBe(a.slot);
    });

    test('強制終了は、プロセスグループ（-pid）にも送る（子孫のプロセスも終わらせる）', async () => {
      const r = rig(40);
      r.max.value = 1;
      r.hold.value = true;
      const a = await r.pool.get('A', undefined);
      (a.child as { pid?: number }).pid = 2_000_000_000; // 存在しない pid（実際の process.kill は ESRCH で、握られる）
      a.child.killExits = true;
      await r.pool.handleOf('A')!.retire();
      expect(a.child.killed).toContain('SIGKILL');
    });
  });

  describe('終わらない（詰まった）handle が、池を詰まらせない', () => {
    test('役目を終えたまま終わらない handle は、追い出しの候補から外し、ほかの使っていないプロセスを閉じる', async () => {
      const r = rig(40);
      r.max.value = 2;
      r.hold.value = true;
      const a = await r.pool.get('A', undefined); // 古い
      await sleep(5);
      const b = await r.pool.get('B', undefined);
      void r.pool.handleOf('A')!.retire(); // A: 終わらない（hold）まま、役目を終える
      await sleep(200);
      b.holdExit = false; // B は、閉じれば終わる
      const c = await r.pool.get('C', undefined);
      expect(b.closed).toBe(true);
      expect(c.slot).toBe(b.slot);
      expect(a.child.exitCode).toBeNull();
    });
  });

  describe('使っていないものが無いとき、少し待つ（waitMs）', () => {
    test('待つ間に、使っていないものができたら、それを閉じて渡す', async () => {
      const r = rig();
      r.max.value = 1;
      r.waitMs.value = 2000;
      const a = await r.pool.get('A', undefined);
      r.inUse.add('A');
      setTimeout(() => r.inUse.delete('A'), 120);
      const b = await r.pool.get('B', undefined);
      expect(a.closed).toBe(true);
      expect(b.slot).toBe(a.slot);
    });

    test('待っても空かなければ、waitMs のあと、ResourceBusyError（process_limit）', async () => {
      const r = rig();
      r.max.value = 1;
      r.waitMs.value = 150;
      await r.pool.get('A', undefined);
      r.inUse.add('A');
      const startedAt = Date.now();
      await expect(r.pool.get('B', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
      expect(getSecurityMetrics()['sora_browser_busy_process_limit_total']).toBe(1);
    });

    test('waitMs が 0 なら、待たずに断る', async () => {
      const r = rig();
      r.max.value = 1;
      await r.pool.get('A', undefined);
      r.inUse.add('A');
      const startedAt = Date.now();
      await expect(r.pool.get('B', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
      expect(Date.now() - startedAt).toBeLessThan(100);
    });
  });

  test('上限で、2 つの新しい tenant が同時に来ても、別々のプロセスを閉じて、両方に渡す（ロックで直列にする）', async () => {
    const r = rig();
    r.max.value = 2;
    await r.pool.get('A', undefined);
    await sleep(5);
    await r.pool.get('B', undefined);
    const results = await Promise.allSettled([r.pool.get('C', undefined), r.pool.get('D', undefined)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const slots = results.map((result) => (result as PromiseFulfilledResult<FakeBrowser>).value.slot);
    expect(new Set(slots).size).toBe(2);
  });

  test('回転: 使っていないかの判定の最中（pages() の待ち）に、使われ始めたら、閉じない', async () => {
    const r = rig();
    const a = await r.pool.get('A', undefined);
    for (let i = 0; i < 200; i++) r.pool.recordUsage('A');
    a.pagesDelay = 60; // 判定が、往復を待つ
    r.pool.rotateWorn();
    await sleep(10);
    r.inUse.add('A'); // 判定の最中に、枠を取って、使い始めた
    await r.pool.get('A', undefined);
    await sleep(120);
    expect(a.closed).toBe(false);
  });

  test('closeAll: すべてのプロセスを閉じて、番号を手放す。閉じたあとも使える', async () => {
    const r = rig();
    const browsers = await Promise.all(['A', 'B', 'C'].map((key) => r.pool.get(key, undefined)));
    expect(r.pool.anyConnected()).toBe(true);
    await r.pool.closeAll();
    expect(browsers.every((browser) => browser.closed)).toBe(true);
    expect(r.pool.size).toBe(0);
    expect(r.pool.anyConnected()).toBe(false);
    const again = await r.pool.get('A', undefined);
    expect(again.slot).toBe(0);
  });

  test('rotateWorn: 使った回数が上限を超えたプロセスだけ閉じる', async () => {
    const r = rig();
    const a = await r.pool.get('A', undefined);
    const b = await r.pool.get('B', undefined);
    for (let i = 0; i < 200; i++) r.pool.recordUsage('A');
    r.pool.recordUsage('B');
    r.pool.rotateWorn();
    await sleep(50);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });

  test('rotateWorn: 使っているプロセスは、回数が上限でも閉じない（セッションを壊さない）。使っていないときの、次の機会に閉じる', async () => {
    const r = rig();
    const a = await r.pool.get('A', undefined);
    for (let i = 0; i < 200; i++) r.pool.recordUsage('A');
    r.inUse.add('A');
    r.pool.rotateWorn();
    await sleep(50);
    expect(a.closed).toBe(false);
    r.inUse.delete('A');
    r.pool.rotateWorn();
    await sleep(50);
    expect(a.closed).toBe(true);
  });

  test('番号の数の上限（max）が、呼ぶたびに読まれる（水準の切り替え）', async () => {
    const r = rig();
    r.max.value = 1;
    const a = await r.pool.get('A', undefined);
    r.inUse.add('A');
    await expect(r.pool.get('B', undefined)).rejects.toBeInstanceOf(ResourceBusyError);
    r.max.value = 2;
    const b = await r.pool.get('B', undefined);
    expect(b.slot).toBe(1);
    expect(a.closed).toBe(false);
  });
});
