import { ResourceBusyError, ScrapeInputError } from './errors.js';
import { incrementSecurityCounter } from './security/metrics.js';

/**
 * ブラウザセッションの登録簿。設計 6（穴 22・23）。
 *
 *  - セッションの名前（ID）は、利用者（tenant）ごとの空間。同じ ID でも、tenant が違えば別のセッションで、
 *    ほかの tenant の ID を引いても見つからない（存在は分からない）
 *  - 数の上限は、利用者ごとと全体の 2 つ。利用者が自分の上限に達したら、その利用者の中で一番使われていない
 *    （使っていないものの中で、lastActive が一番古い）セッションを追い出す。全部が使用中なら、追い出さずに断る。
 *    全体がいっぱいなら、ほかの利用者のセッションは閉じずに、断る（ResourceBusyError）
 *  - 作成は、予約（reserve）→ 登録（commit）の 2 段。reserve は同期で、数の検査と同じ ID の重複の検査を一緒に行うので、
 *    await をまたぐ同時の作成でも、数も ID も食い違わない。断るときは、何も変えない
 *  - 同じ ID の作成が重なったとき、あとの呼び出しは、pending で先の作成が終わる（登録か取り消し）のを待ち、引き直す
 *    （空いている枠の数に左右されずに、同じ結果になる）
 */

export const DEFAULT_SESSION_TENANT = 'legacy';

/** 全体の上限で断ったときの、再試行までに空けてほしい秒数（Retry-After）。セッションは、使われなくなって 5 分で閉じる */
const RETRY_AFTER_SEC = 30;

export interface SessionCaps {
  /** 1 人の利用者が持てる数（作成中を含む） */
  perTenant: number;
  /** 全体で持てる数（作成中を含む） */
  total: number;
}

export interface RegistrySession {
  readonly id: string;
  readonly tenantId: string;
  lastActive: number;
  /** いま使っている呼び出しの数（枠を待っている間も含む）。1 以上のセッションは、追い出さない */
  inUse: number;
}

/** tenant と ID の組の鍵。区切りの曖昧さが無いよう JSON にする（別の組が同じ鍵にならない） */
export function sessionKey(tenantId: string | undefined, id: string): string {
  return JSON.stringify([tenantId || DEFAULT_SESSION_TENANT, id]);
}

function limitReached(message: string): ResourceBusyError {
  incrementSecurityCounter('sora_browser_busy_session_limit_total');
  return new ResourceBusyError(message, 'session_limit', RETRY_AFTER_SEC);
}

export class SessionRegistry<S extends RegistrySession> {
  private readonly sessions = new Map<string, S>();
  /** 作成中の予約。鍵 → tenant と、終わった（登録か取り消し）ことを知らせる関数・待つ Promise */
  private readonly creating = new Map<string, { tenant: string; finish: () => void; done: Promise<void> }>();

  /** 登録済みの数（作成中は含まない） */
  get size(): number {
    return this.sessions.size;
  }

  all(): S[] {
    return [...this.sessions.values()];
  }

  get(tenantId: string | undefined, id: string): S | undefined {
    return this.sessions.get(sessionKey(tenantId, id));
  }

  /** 利用者の数（登録済み + 作成中） */
  countFor(tenantId: string | undefined): number {
    const tenant = tenantId || DEFAULT_SESSION_TENANT;
    let count = 0;
    for (const s of this.sessions.values()) if (s.tenantId === tenant) count++;
    for (const entry of this.creating.values()) if (entry.tenant === tenant) count++;
    return count;
  }

  /** 同じ鍵の作成中なら、その作成が終わる（登録か取り消し）のを待つ Promise。作成中でなければ undefined。待ったあとは、get で引き直す */
  pending(tenantId: string | undefined, id: string): Promise<void> | undefined {
    return this.creating.get(sessionKey(tenantId, id))?.done;
  }

  /**
   * 作成を予約する（同期）。同じ ID が、すでにある・作成中なら ScrapeInputError。
   * 利用者が自分の上限に達していれば、その利用者の、使っていないセッションのうち一番使われていないものを登録簿から外して返す（呼ぶ側が閉じる）。
   * 追い出せるものが無ければ（全部が使用中か作成中）ResourceBusyError。
   * 全体がいっぱいなら ResourceBusyError（ほかの利用者のセッションは外さない）。断るときは、何も変えない
   */
  reserve(tenantId: string | undefined, id: string, caps: SessionCaps): S | undefined {
    const tenant = tenantId || DEFAULT_SESSION_TENANT;
    const key = sessionKey(tenant, id);
    if (this.sessions.has(key) || this.creating.has(key)) {
      throw new ScrapeInputError(`セッション ID「${id}」のセッションは、すでにあるか、作成中です。作成が終わってから、もう一度呼んでください`);
    }
    let evicted: S | undefined;
    if (this.countFor(tenant) >= caps.perTenant) {
      evicted = this.oldestOf(tenant);
      if (!evicted) throw limitReached(`この利用者のブラウザセッションが、すべて使用中か作成中です（上限 ${caps.perTenant} 件）。終わってから、もう一度試してください`);
    }
    const used = this.sessions.size + this.creating.size - (evicted ? 1 : 0);
    if (used >= caps.total) {
      throw limitReached(`ブラウザセッションが全体の上限（${caps.total} 件）に達しています。ほかの利用者のセッションは閉じません。しばらくしてから、もう一度試してください`);
    }
    if (evicted) this.sessions.delete(sessionKey(evicted.tenantId, evicted.id));
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.creating.set(key, { tenant, finish, done });
    return evicted;
  }

  /** 予約したセッションを登録する */
  commit(session: S): void {
    const key = sessionKey(session.tenantId, session.id);
    const entry = this.creating.get(key);
    this.creating.delete(key);
    this.sessions.set(key, session);
    entry?.finish();
  }

  /** 作成の予約を取り消す（作成に失敗したとき）。登録済みのセッションは消さない */
  cancel(tenantId: string | undefined, id: string): void {
    const key = sessionKey(tenantId, id);
    const entry = this.creating.get(key);
    this.creating.delete(key);
    entry?.finish();
  }

  /** 登録簿から外す。外したセッションを返す（無ければ undefined） */
  remove(tenantId: string | undefined, id: string): S | undefined {
    const key = sessionKey(tenantId, id);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    return session;
  }

  private oldestOf(tenant: string): S | undefined {
    let oldest: S | undefined;
    for (const s of this.sessions.values()) {
      if (s.tenantId === tenant && s.inUse === 0 && (!oldest || s.lastActive < oldest.lastActive)) oldest = s;
    }
    return oldest;
  }
}
