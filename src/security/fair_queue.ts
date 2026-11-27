import { type BusyReason, type BusyResource, ResourceBusyError } from '../errors.js';
import { incrementSecurityCounter } from './metrics.js';

/**
 * 公平な待ち行列つきの枠（同時に動かす数の制限）。設計 6（穴 25）。ブラウザの枠のほか、共有の外部資源（地名の検索・Yahoo・国の情報の提供元・住所データの構築）にも使う。
 *
 *  - 枠は、tenant ごとに公平に渡す。待っている tenant を順番に回し、1 回に 1 つずつ渡す（先に大量に並べた tenant の後ろで、ほかの tenant が、その全部が終わるまで待たされない）
 *  - 1 つの tenant が同時に持てる枠に、割合の上限を置ける（上限に達した tenant は、空きがあっても持てず、ほかの tenant がすぐ持てる）
 *  - 待つ数（tenant ごと・全体）と待つ時間に上限を置ける。超えたら ResourceBusyError（REST では 429）。断った文・カウンターの名前は、資源（resource）ごと
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
  /** 何の枠か（断った文・カウンターの名前・例外の resource になる）。既定はブラウザ */
  resource?: BusyResource;
  /** 待ち行列の方針。呼ぶたびに読む。無ければ制限なし */
  policy?: () => QueuePolicy;
  /** 最後の 1 つが手放され、待ちも無くなったときに呼ぶ（使い終わった共有ブラウザの入れ替え） */
  onIdle?: () => void;
}

const UNBOUNDED: QueuePolicy = { perTenant: Infinity, total: Infinity, waitMs: Infinity, sharePercent: 100 };

/** 断ったときに、再試行までに空けてほしい秒数（Retry-After） */
const RETRY_AFTER_SEC = 5;

/** 枠の待ち行列が断る理由（session_limit は、セッションの登録簿の理由。tenant_budget は、利用者ごとの予算 tenant_budget.ts の理由） */
type QueueBusyReason = Exclude<BusyReason, 'session_limit' | 'tenant_budget' | 'process_limit' | 'connection_limit'>;

/** 資源ごとの、断る文の言葉。subject は「〜を待つ要求が」、waiting は「〜を N 秒待ちましたが、空きませんでした」の前半 */
export const RESOURCE_WORDS: Record<BusyResource, { subject: string; waiting: string }> = {
  browser: { subject: 'ブラウザの枠', waiting: 'ブラウザの枠が空くのを' },
  geocoding: { subject: '地名の検索（外部の地図の問い合わせ）の順番', waiting: '地名の検索の順番が来るのを' },
  yahoo: { subject: 'Yahoo への問い合わせの順番', waiting: 'Yahoo への問い合わせの順番が来るのを' },
  country_intel: { subject: '国の情報の取得の順番', waiting: '国の情報の取得の順番が来るのを' },
  address: { subject: '住所データの構築の順番', waiting: '住所データの構築の順番が来るのを' },
  pdf: { subject: 'PDF の解析の順番', waiting: 'PDF の解析の順番が来るのを' },
  convert: { subject: 'ページの変換の順番', waiting: 'ページの変換の順番が来るのを' },
  egress: { subject: '外への接続', waiting: '外への接続が空くのを' },
};

/** 待ち行列が断る例外を作る（カウンターを 1 回数える）。SimpleSemaphore のほか、自前の待ち行列（住所データの構築）も使う */
export function queueBusyError(resource: BusyResource, reason: QueueBusyReason, policy: QueuePolicy): ResourceBusyError {
  incrementSecurityCounter(`sora_${resource}_busy_${reason}_total`);
  const words = RESOURCE_WORDS[resource];
  const message = {
    tenant_queue_full: `${words.subject}を待つ要求が、この利用者の上限（${policy.perTenant} 件）に達しています。実行中の要求が終わってから、もう一度試してください`,
    queue_full: `${words.subject}を待つ要求が、全体の上限（${policy.total} 件）に達しています。しばらくしてから、もう一度試してください`,
    queue_timeout: `${words.waiting} ${Math.round(policy.waitMs / 1000)} 秒待ちましたが、空きませんでした。しばらくしてから、もう一度試してください`,
  }[reason];
  return new ResourceBusyError(message, reason, RETRY_AFTER_SEC, resource);
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
  private readonly resource: BusyResource;
  private readonly policy: () => QueuePolicy;
  private readonly onIdle?: () => void;

  constructor(
    public readonly max: number,
    options: SemaphoreOptions = {},
  ) {
    this.resource = options.resource ?? 'browser';
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
    try {
      this.assertRoomToWait(tenantId, policy);
    } catch (error) {
      return Promise.reject(error);
    }
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
          reject(queueBusyError(this.resource, 'queue_timeout', policy));
        }, policy.waitMs);
        timer.unref?.();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.enqueue(waiter);
    });
  }

  /**
   * 待たされるとして、待てる数（利用者ごと・全体）に余裕があるかを、待ちに入らず、枠を取らずに確かめる。余裕が無ければ、acquire と同じ断り（ResourceBusyError）を、
   * 待たせずに投げる（カウンターも 1 回）。空きがすぐ取れるときは、何もしない。
   * 予算（TenantBudget）を使う前に呼ぶ: 同時に出した要求が、順番で断られる前に（断りが返るのは非同期で、遅れる）予算を使い、予算の断りに化けないように
   */
  assertCanWait(tenantId = 'legacy'): void {
    const policy = this.policy();
    if (this.canGrant(tenantId, policy)) return;
    this.assertRoomToWait(tenantId, policy);
  }

  private assertRoomToWait(tenantId: string, policy: QueuePolicy): void {
    if ((this.queues.get(tenantId)?.length ?? 0) >= policy.perTenant) throw queueBusyError(this.resource, 'tenant_queue_full', policy);
    if (this.waitingTotal >= policy.total) throw queueBusyError(this.resource, 'queue_full', policy);
  }

  get activeCount(): number {
    return this.current;
  }

  /** 1 つの tenant が、いま持っている枠の数（ブラウザを tenant ごとのプロセスで動かすとき、使っているプロセスを閉じない判断に使う） */
  heldBy(tenantId = 'legacy'): number {
    return this.held.get(tenantId) ?? 0;
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
