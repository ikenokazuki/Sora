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
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? 'SIGTERM'));
    return true;
  }
  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

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
  constructor(readonly slot: number | undefined) {}
  async version(): Promise<string> {
    if (!this.connected) throw new Error('disconnected');
    return 'fake';
  }
  async close(): Promise<void> {
    this.connected = false;
    this.closed = true;
    if (!this.holdExit) queueMicrotask(() => this.child.exit());
  }
  process(): ChildLike {
    return this.child;
  }
  browserContexts(): unknown[] {
    return new Array(this.contexts);
  }
  async pages(): Promise<unknown[]> {
    return new Array(this.pageCount);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
}

function rig(): Rig {
  const launched: FakeBrowser[] = [];
  const inUse = new Set<string>();
  const ttl = { value: 0 };
  const max = { value: 3 };
  const hold = { value: false };
  const launchDelay = { value: 0 };
  const launchFails = { value: false };
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
        exitGraceMs: 60,
      },
      onReleased,
    );
  const pool = new BrowserPool<FakeBrowser, undefined>({ max: () => max.value, makeHandle });
  const shared = makeHandle('*shared*', undefined);
  return { launched, inUse, ttl, max, hold, launchDelay, launchFails, pool, handleFor: () => shared };
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
    const r = rig();
    r.max.value = 1;
    r.hold.value = true;
    const a = await r.pool.get('A', undefined);
    const next = r.pool.get('B', undefined);
    await sleep(25);
    expect(a.child.killed).toEqual([]); // すぐには、強制終了しない（閉じる時間を与える）
    await sleep(55);
    expect(a.child.killed).toContain('SIGKILL');
    a.child.exit();
    expect((await next).slot).toBe(a.slot);
  });

  test('無操作の時間が過ぎたら、そのプロセスは閉じて、番号を手放す', async () => {
    const r = rig();
    r.ttl.value = 50;
    const a = await r.pool.get('A', undefined);
    await sleep(250);
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
    await sleep(250);
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
