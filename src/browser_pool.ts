/**
 * ブラウザのプロセスの寿命の管理（設計 2。段階 6）。
 * - BrowserHandle: 1 つのブラウザ（Chromium のプロセス）の、起動（同時に呼んでも 1 つ）・再利用・無操作での終了・回転・終了。
 *   これまでの「全員で 1 つの共有ブラウザ」の挙動そのもの（browser_engine.ts から移した）に、「役目を終える（retire）」を足した。
 * - BrowserPool: tenant ごとに別の handle（= 別のプロセス）を持つ。プロセスごとに別の番号（BrowserSlots。uid の池の位置）を渡し、
 *   同時に持てる数に達したら、使っていないプロセスの最も古いものを閉じて渡す。
 *
 * 要の性質: 番号は、そのプロセスが完全に終わってから、別の tenant に渡す（終わる前に渡すと、2 つの tenant のプロセスが、同じ uid で並ぶ）。
 * 閉じても終わらないプロセスは、強制終了し、それでも終わらなければ、番号を手放さない（番号を 1 つ失うほうが、uid の衝突より安全）。
 */
import { BrowserSlots } from './browser_slots.js';
import { ResourceBusyError } from './errors.js';
import { incrementSecurityCounter } from './security/metrics.js';

/** 子プロセス（puppeteer の browser.process()）のうち、使う部分 */
export interface ChildLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

/** ブラウザ（puppeteer の Browser）のうち、使う部分 */
export interface BrowserLike {
  readonly connected: boolean;
  version(): Promise<string>;
  close(): Promise<void>;
  process(): ChildLike | null;
  browserContexts(): unknown[];
  pages(): Promise<unknown[]>;
}

/** 役目を終えた handle から get() を呼んだ。呼んだ側（BrowserPool）は、池から取り直す */
export class HandleRetiredError extends Error {
  constructor() {
    super('このブラウザは、役目を終えている');
    this.name = 'HandleRetiredError';
  }
}

export interface HandleDeps<B extends BrowserLike, A> {
  /** ブラウザを起動する。slot は、tenant ごとの番号（共有は undefined）。arg は、get() に渡された値（プロキシの設定など） */
  launch: (slot: number | undefined, arg: A) => Promise<B>;
  /** 枠を持っている・待っているなど、ブラウザの外から分かる「使用中」。true なら、閉じない */
  inUse: () => boolean;
  /** 無操作で閉じるまでの時間（ミリ秒。0 以下は閉じない）。呼ぶたびに読む */
  idleTtlMs: () => number;
  /** true なら、無操作のとき（起動していないときも）、閉じるだけでなく、役目を終える（tenant ごとのプロセス）。共有は false */
  retireWhenIdle: boolean;
  /** 閉じても終わらない子プロセスを、強制終了するまでの時間（ミリ秒）。強制終了のあとも、同じ時間、終わるのを待つ。既定 3000 */
  exitGraceMs?: number;
  now?: () => number;
}

/** 使った回数がこれに達したら、全体が空いたときに、入れ替える（長く動かしたブラウザのメモリの増えを戻す） */
export const MAX_BROWSER_USES = 200;
const DEFAULT_EXIT_GRACE_MS = 3000;

export class BrowserHandle<B extends BrowserLike, A> {
  instance: B | null = null;
  /** 起動している最中の Promise。同時に get() が呼ばれても、起動は 1 回だけにして、全員が同じブラウザを受け取る */
  private launching: Promise<B> | null = null;
  private lastUse = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  usageCount = 0;
  retired = false;
  private retiring: Promise<void> | null = null;
  /** 起動して、まだ終わっていない子プロセス */
  private readonly liveChildren = new Set<ChildLike>();

  constructor(
    readonly key: string,
    readonly slot: number | undefined,
    private readonly deps: HandleDeps<B, A>,
    /** 役目を終えて、子プロセスが全部終わったときに呼ぶ（BrowserPool が、番号を手放す） */
    private readonly onReleased?: (handle: BrowserHandle<B, A>) => void,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get connected(): boolean {
    return this.instance?.connected === true;
  }

  /** ブラウザを受け取る。起動済みならそれを、起動中ならその完了を待って、受け取る（同時に複数起動しない） */
  async get(arg: A): Promise<B> {
    // 待っている間に閉じられた場合に備え、起動の完了後は状態を見直す
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.retired) throw new HandleRetiredError();
      const existing = this.instance;
      if (existing?.connected) {
        try {
          await existing.version();
          // 疎通確認の await 中に閉じられた・差し替えられた場合は渡さず、次の周回で取り直す
          if (this.instance === existing) {
            this.markUsed();
            return existing;
          }
        } catch {
          if (this.instance === existing) this.instance = null;
        }
      }
      if (!this.launching) this.launching = this.launchOnce(arg);
      // 失敗したときは待っている全員に同じエラーが伝わり、次の呼び出しで起動をやり直せる
      await this.launching;
    }
    if (this.retired) throw new HandleRetiredError();
    throw new Error('共有ブラウザを起動できませんでした');
  }

  private launchOnce(arg: A): Promise<B> {
    const launched = this.deps.launch(this.slot, arg).then((browser) => {
      this.instance = browser;
      const child = browser.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        this.liveChildren.add(child);
        child.once('exit', () => this.liveChildren.delete(child));
      }
      this.markUsed();
      return browser;
    });
    const tracked: Promise<B> = launched.finally(() => {
      if (this.launching === tracked) this.launching = null;
    });
    return tracked;
  }

  /** 使った時刻を、いまにして、無操作の時間を数え直す */
  markUsed(): void {
    this.lastUse = this.now();
    this.armIdleTimer(this.deps.idleTtlMs());
  }

  private armIdleTimer(delayMs: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (delayMs <= 0 || this.retired) return;
    this.idleTimer = setTimeout(() => void this.closeIfIdle(), delayMs);
    this.idleTimer.unref?.();
  }

  /** 使っていない（枠・待ち・開いているページ／コンテキストが無い）か */
  async isIdle(): Promise<boolean> {
    if (this.launching) return false;
    if (this.deps.inUse()) return false;
    const browser = this.instance;
    if (!browser) return true;
    try {
      return !(browser.browserContexts().length > 1 || (await browser.pages()).length > 1);
    } catch {
      return true; // 接続が壊れている場合は閉じてよい
    }
  }

  private async closeIfIdle(): Promise<void> {
    this.idleTimer = undefined;
    const ttl = this.deps.idleTtlMs();
    if (ttl <= 0 || this.retired) return;
    const browser = this.instance;
    if (!browser) {
      // 起動していない（起動に失敗した・まだ始まっていない）。番号を持ち続けないよう、役目を終える
      if (!this.launching && this.deps.retireWhenIdle) await this.retire();
      return;
    }
    const remaining = ttl - (this.now() - this.lastUse);
    if (remaining > 0) return this.armIdleTimer(remaining);
    const checkedUse = this.lastUse;
    const idle = await this.isIdle();
    // 判定の await 中に get() で渡されていたら閉じない（その呼び出しがタイマーを張り直している）
    if (this.lastUse !== checkedUse) return;
    if (!idle) return this.armIdleTimer(ttl);
    if (browser !== this.instance) return;
    if (this.deps.retireWhenIdle) await this.retire();
    else await this.close();
  }

  /** 閉じる（また get() で起動できる）。起動の最中なら、完了を待ってから閉じる（起動途中のまま放置すると、管理されないブラウザが残る） */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const launching = this.launching;
    if (launching) {
      try {
        await launching;
      } catch {}
    }
    // 閉じる前に外し、閉じかけのブラウザを get() が渡さないようにする
    const browser = this.instance;
    this.instance = null;
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }

  /**
   * 役目を終える（もう get() は使えない）。閉じて、子プロセスが終わるのを待ち（閉じても終わらなければ強制終了する）、全部終わったら、onReleased を呼ぶ。
   * 終わらないプロセスが残るなら、onReleased は呼ばない（番号を手放さない）。
   */
  retire(): Promise<void> {
    if (this.retiring) return this.retiring;
    this.retired = true;
    this.retiring = (async () => {
      await this.close();
      await this.waitForChildren();
      if (this.liveChildren.size === 0) this.onReleased?.(this);
    })();
    return this.retiring;
  }

  private async waitForChildren(): Promise<void> {
    const grace = this.deps.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    const stillAlive = () => this.liveChildren.size > 0;
    const waitUntil = (ms: number) =>
      new Promise<void>((resolve) => {
        const started = this.now();
        const poll = setInterval(() => {
          if (!stillAlive() || this.now() - started >= ms) {
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });
    if (!stillAlive()) return;
    await waitUntil(grace);
    if (!stillAlive()) return;
    for (const child of this.liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    await waitUntil(grace);
  }

  recordUsage(): void {
    this.usageCount++;
  }

  /**
   * 使った回数が上限に達していれば、閉じる（待たない）。始めたら true。
   * 共有ブラウザは、これまでどおり、すぐ数え直して閉じる。tenant ごとのプロセスは、使っていないときだけ閉じる（セッションを持つプロセスを、回転で壊さない。使っていれば、次の機会に試す）
   */
  rotateIfWorn(): boolean {
    if (this.usageCount < MAX_BROWSER_USES) return false;
    if (!this.deps.retireWhenIdle) {
      this.usageCount = 0;
      void this.close();
      return true;
    }
    void this.isIdle().then((idle) => {
      if (!idle || this.retired) return;
      this.usageCount = 0;
      return this.retire();
    });
    return true;
  }
}

export interface PoolOptions<B extends BrowserLike, A> {
  /** 同時に持てるプロセスの数（呼ぶたびに読む） */
  max: () => number;
  makeHandle: (key: string, slot: number, onReleased: (handle: BrowserHandle<B, A>) => void) => BrowserHandle<B, A>;
}

/** tenant ごとのブラウザのプロセスの池 */
export class BrowserPool<B extends BrowserLike, A> {
  private readonly handles = new Map<string, BrowserHandle<B, A>>();
  private readonly slots: BrowserSlots;
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly options: PoolOptions<B, A>) {
    this.slots = new BrowserSlots(options.max);
  }

  /** 番号を持っているプロセスの数 */
  get size(): number {
    return this.slots.size;
  }

  handleOf(key: string): BrowserHandle<B, A> | undefined {
    return this.handles.get(key);
  }

  anyConnected(): boolean {
    for (const handle of this.handles.values()) if (handle.connected) return true;
    return false;
  }

  /** key（tenant）のブラウザを受け取る。なければ起動する。上限に達していれば、使っていないプロセスを閉じて渡し、閉じられるものが無ければ ResourceBusyError */
  async get(key: string, arg: A): Promise<B> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const handle = await this.handleFor(key);
      try {
        return await handle.get(arg);
      } catch (error) {
        // 受け取る前に、役目を終えた（無操作で閉じられた・追い出された）。取り直す
        if (error instanceof HandleRetiredError) continue;
        throw error;
      }
    }
    throw new Error('tenant ごとのブラウザを起動できませんでした');
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private handleFor(key: string): Promise<BrowserHandle<B, A>> {
    return this.serialize(async () => {
      const existing = this.handles.get(key);
      if (existing && !existing.retired) {
        this.slots.touch(key);
        existing.markUsed();
        return existing;
      }
      if (existing?.retired) {
        // 役目を終える最中（プロセスがまだ動いているかもしれない）。終わるのを待つ。番号は、終わってから手放される。
        // 終わらなければ（強制終了しても）、番号は残るので、同じ番号に 2 つ目のプロセスを並べず、断る
        await existing.retire();
        if (this.handles.get(key) === existing) throw this.busyError();
      }
      let slot = this.slots.allocate(key);
      if (slot === undefined) {
        // 使っていないプロセスのうち、最も長く使われていないものを閉じて、その番号をもらう
        for (const victimKey of this.slots.candidates()) {
          const victim = this.handles.get(victimKey);
          if (!victim || !(await victim.isIdle())) continue;
          await victim.retire();
          break;
        }
        slot = this.slots.allocate(key);
      }
      if (slot === undefined) throw this.busyError();
      const handle = this.options.makeHandle(key, slot, (released) => this.release(released));
      this.handles.set(key, handle);
      handle.markUsed();
      return handle;
    });
  }

  private busyError(): ResourceBusyError {
    incrementSecurityCounter('sora_browser_busy_process_limit_total');
    return new ResourceBusyError(
      `ブラウザのプロセスの上限（${this.options.max()} 個）に達していて、閉じてよいプロセス（使っていないもの）がありません。しばらくしてから、もう一度試してください`,
      'process_limit',
      5,
      'browser',
    );
  }

  /** 役目を終えて、子プロセスも終わった handle の番号を手放す */
  private release(handle: BrowserHandle<B, A>): void {
    if (this.handles.get(handle.key) === handle) {
      this.handles.delete(handle.key);
      this.slots.release(handle.key);
    }
  }

  recordUsage(key: string): void {
    this.handles.get(key)?.recordUsage();
  }

  /** 使った回数が上限に達したプロセスを、閉じる（全体が空いたとき） */
  rotateWorn(): void {
    for (const handle of [...this.handles.values()]) handle.rotateIfWorn();
  }

  /** すべてのプロセスを閉じて、番号を手放す */
  async closeAll(): Promise<void> {
    await Promise.all([...this.handles.values()].map((handle) => handle.retire()));
  }
}
