import { type BusyReason, ResourceBusyError } from './errors.js';
import { incrementSecurityCounter } from './security/metrics.js';

/**
 * ブラウザの枠（同時に動かすブラウザの数の制限）。設計 6（穴 25）。
 *
 *  - 枠は、tenant ごとに公平に渡す。待っている tenant を順番に回し、1 回に 1 つずつ渡す（先に大量に並べた tenant の後ろで、ほかの tenant が、その全部が終わるまで待たされない）
 *  - 1 つの tenant が同時に持てる枠に、割合の上限を置ける（上限に達した tenant は、空きがあっても持てず、ほかの tenant がすぐ持てる）
 *  - 待つ数（tenant ごと・全体）と待つ時間に上限を置ける。超えたら ResourceBusyError（REST では 429）
 *  - 枠を得ると、手放す関数（Lease）が返る。2 回呼んでも、1 回分だけ
 *
 * 上限の値は、呼ぶたびに policy で読む（水準 SORA_ISOLATION の切り替えに追従する）。policy を渡さなければ、制限なし（これまでの挙動）。
 */

/** 枠の待ち行列の方針 */
export interface QueuePolicy {
  /** 1 つの tenant が待てる数 */
  perTenant: number;
  /** 全体で待てる数 */
  total: number;
  /** 待てる時間（ミリ秒）。Infinity なら、時間切れにしない */
  waitMs: number;
  /** 1 つの tenant が同時に持てる枠の割合（1〜100 のパーセント。枠の数に掛けて切り捨て、最低 1 枠） */
  sharePercent: number;
}

/** 持っている枠を手放す関数。2 回呼んでも、1 回分だけ */
export type Lease = () => void;

export interface SemaphoreOptions {
  /** 待ち行列の方針。呼ぶたびに読む。無ければ制限なし */
  policy?: () => QueuePolicy;
  /** 最後の 1 つが手放され、待ちも無くなったときに呼ぶ（使い終わった共有ブラウザの入れ替え） */
  onIdle?: () => void;
}

const UNBOUNDED: QueuePolicy = { perTenant: Infinity, total: Infinity, waitMs: Infinity, sharePercent: 100 };

/** 断ったときに、再試行までに空けてほしい秒数（Retry-After） */
const RETRY_AFTER_SEC = 5;

function busy(reason: BusyReason, policy: QueuePolicy): ResourceBusyError {
  incrementSecurityCounter(`sora_browser_busy_${reason}_total`);
  const message = {
    tenant_queue_full: `ブラウザの枠を待つ要求が、この利用者の上限（${policy.perTenant} 件）に達しています。実行中の要求が終わってから、もう一度試してください`,
    queue_full: `ブラウザの枠を待つ要求が、全体の上限（${policy.total} 件）に達しています。しばらくしてから、もう一度試してください`,
    queue_timeout: `ブラウザの枠が空くのを ${Math.round(policy.waitMs / 1000)} 秒待ちましたが、空きませんでした。しばらくしてから、もう一度試してください`,
  }[reason];
  return new ResourceBusyError(message, reason, RETRY_AFTER_SEC);
}

interface Waiter {
  tenantId: string;
  grant: (lease: Lease) => void;
  /** タイマーと、中止のリスナーを外す */
  cleanup: () => void;
}

export class SimpleSemaphore {
  private current = 0;
  /** tenant ごとの、いま持っている枠の数 */
  private readonly held = new Map<string, number>();
  /** tenant ごとの待ち（先に待った順）。空の列は持たない */
  private readonly queues = new Map<string, Waiter[]>();
  /** 待っている tenant。先頭が、次に枠をもらう番（1 つ渡すと最後尾に回る） */
  private readonly order: string[] = [];
  private waitingTotal = 0;
  private readonly policy: () => QueuePolicy;
  private readonly onIdle?: () => void;

  constructor(
    public readonly max: number,
    options: SemaphoreOptions = {},
  ) {
    this.policy = options.policy ?? (() => UNBOUNDED);
    this.onIdle = options.onIdle;
  }

  /**
   * 枠を取る。空きがあり、その tenant が割合の上限に達していなければ、すぐ得る。そうでなければ、待つ（待つ数・待ち時間の上限を超えたら、ResourceBusyError）。
   * signal が中止されたら、待ちをやめて、その理由で失敗する
   */
  acquire(tenantId = 'legacy', options: { signal?: AbortSignal } = {}): Promise<Lease> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    const policy = this.policy();
    if (this.canGrant(tenantId, policy)) return Promise.resolve(this.grant(tenantId));
    if ((this.queues.get(tenantId)?.length ?? 0) >= policy.perTenant) return Promise.reject(busy('tenant_queue_full', policy));
    if (this.waitingTotal >= policy.total) return Promise.reject(busy('queue_full', policy));
    return new Promise<Lease>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.remove(waiter);
        waiter.cleanup();
        reject(signal?.reason ?? new Error('aborted'));
      };
      const waiter: Waiter = {
        tenantId,
        grant: resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      if (Number.isFinite(policy.waitMs)) {
        timer = setTimeout(() => {
          this.remove(waiter);
          waiter.cleanup();
          reject(busy('queue_timeout', policy));
        }, policy.waitMs);
        timer.unref?.();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.enqueue(waiter);
    });
  }

  get activeCount(): number {
    return this.current;
  }

  get pendingCount(): number {
    return this.waitingTotal;
  }

  /** 1 つの tenant が同時に持てる枠の数 */
  private tenantCap(policy: QueuePolicy): number {
    return Math.min(this.max, Math.max(1, Math.floor((this.max * policy.sharePercent) / 100)));
  }

  private canGrant(tenantId: string, policy: QueuePolicy): boolean {
    return this.current < this.max && (this.held.get(tenantId) ?? 0) < this.tenantCap(policy);
  }

  /** 枠を 1 つ渡す。数えるのは、渡した時点（待っていた要求の続きが動くより前に、ほかの acquire が同じ枠を取れないように） */
  private grant(tenantId: string): Lease {
    this.current++;
    this.held.set(tenantId, (this.held.get(tenantId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(tenantId);
    };
  }

  private release(tenantId: string): void {
    this.current = Math.max(0, this.current - 1);
    const held = (this.held.get(tenantId) ?? 1) - 1;
    if (held > 0) this.held.set(tenantId, held);
    else this.held.delete(tenantId);
    this.pump();
    if (this.current === 0) this.onIdle?.();
  }

  private enqueue(waiter: Waiter): void {
    let queue = this.queues.get(waiter.tenantId);
    if (!queue) {
      queue = [];
      this.queues.set(waiter.tenantId, queue);
      this.order.push(waiter.tenantId);
    }
    queue.push(waiter);
    this.waitingTotal++;
  }

  /** 待ちから外す（時間切れ・中止）。外せたら true */
  private remove(waiter: Waiter): boolean {
    const queue = this.queues.get(waiter.tenantId);
    const index = queue?.indexOf(waiter) ?? -1;
    if (!queue || index < 0) return false;
    queue.splice(index, 1);
    this.waitingTotal--;
    if (queue.length === 0) {
      this.queues.delete(waiter.tenantId);
      this.order.splice(this.order.indexOf(waiter.tenantId), 1);
    }
    return true;
  }

  /** 空いた枠を、待っている tenant に、順番に 1 つずつ渡す。割合の上限に達した tenant は飛ばす */
  private pump(): void {
    const cap = this.tenantCap(this.policy());
    while (this.current < this.max) {
      const index = this.order.findIndex((tenant) => (this.held.get(tenant) ?? 0) < cap);
      if (index < 0) return;
      const tenantId = this.order[index];
      const queue = this.queues.get(tenantId) as Waiter[];
      const waiter = queue.shift() as Waiter;
      this.waitingTotal--;
      this.order.splice(index, 1);
      if (queue.length > 0) this.order.push(tenantId);
      else this.queues.delete(tenantId);
      waiter.cleanup();
      waiter.grant(this.grant(tenantId));
    }
  }
}
