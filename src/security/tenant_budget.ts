// 利用者ごとの予算（一定の時間あたりの回数。すべる窓）。設計 6（穴 25）。
//
// 共有の外部資源（Nominatim・Yahoo）は、提供元が、1 つの出口（Sora）を 1 人の利用者として見て制限する。
// 1 人の連打が提供元の制限（429）に当たると、ブレーカーが開き、全員が止まる。そこで、提供元に当たる前に、
// 連打している利用者の分だけを、Sora の側で断る（ResourceBusyError。REST では 429）。ほかの利用者の予算は減らない。
//
//  - 数えるのは、提供元へ出す回（キャッシュ・ローカルで解決した分は数えない。呼ぶ側が、その位置で spend する）。順番を待って断られた回は、
//    spend が返す関数で返す（返さないと、Retry-After どおりに再試行するたびに予算を使い切り、自分で締め出される）
//  - 断った回は、予算を使わず、窓も延ばさない（連打しても、最初の窓が空けば通る）
//  - 0（制限なし）は、何も覚えない
//  - 覚える利用者の数に上限を置く（trimMap）。窓がすぎた利用者を先に、次に入れた順に古い方から外す。連打している利用者は、断られるたびに最後尾へ動くので外れない
import { ResourceBusyError, type BusyResource } from '../errors.js';
import { trimMap } from './bounded_map.js';
import { currentCaller } from './caller.js';
import { limits } from './limits.js';
import { incrementSecurityCounter } from './metrics.js';

/** 予算の方針。perWindow は 1 つの窓の中で使える回数（0 以下・NaN は制限なし）。windowMs は窓の幅（0 以下・NaN は制限なし） */
export interface BudgetPolicy {
  perWindow: number;
  windowMs: number;
}

export interface TenantBudgetOptions {
  /** 何の予算か（断った文・カウンターの名前・例外の resource になる） */
  resource: BusyResource;
  /** 予算の方針。呼ぶたびに読む（水準 SORA_ISOLATION の切り替えに追従する） */
  policy: () => BudgetPolicy;
  /** 現在の時刻（ミリ秒）。既定は Date.now */
  now?: () => number;
  /** 覚える利用者の数の上限。呼ぶたびに読む。既定は hostMapMaxEntries */
  maxTenants?: () => number;
}

/** 資源ごとの、予算の文の言葉 */
const BUDGET_WORDS: Record<BusyResource, string> = {
  browser: 'ブラウザの利用',
  geocoding: '地名の検索',
  yahoo: 'Yahoo への問い合わせ',
  country_intel: '国の情報の取得',
  address: '住所データの構築',
  pdf: 'PDF の解析',
};

/** 窓の幅の書き方（ちょうど分なら「1 分」、そうでなければ「30 秒」） */
function windowText(windowMs: number): string {
  return windowMs % 60_000 === 0 ? `${windowMs / 60_000} 分` : `${Math.round(windowMs / 1000)} 秒`;
}

const NOOP = (): void => undefined;

export class TenantBudget {
  /** tenant ごとの、予算を使った時刻（古い順）。覚える順は、最後に触った順（Map の挿入順） */
  private readonly spent = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: TenantBudgetOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 覚えている利用者の数 */
  get size(): number {
    return this.spent.size;
  }

  clear(): void {
    this.spent.clear();
  }

  /**
   * いま窓の中で使った回数（読むだけ。覚えを増やさず、触った順も動かさない）。制限なしのときは 0。
   * tenantId を渡さなければ、いま呼んでいる利用者（runAsCaller）。テスト・確認用
   */
  usedBy(tenantId: string = currentCaller()): number {
    const { perWindow, windowMs } = this.options.policy();
    if (!(perWindow > 0) || !(windowMs > 0)) return 0;
    const stamps = this.spent.get(tenantId);
    if (!stamps) return 0;
    const now = this.now();
    let used = 0;
    for (const at of stamps) if (!(now - at >= windowMs || now < at)) used++;
    return used;
  }

  /**
   * 提供元へ出す前に呼ぶ。予算の中なら 1 回使って、その 1 回を返す関数を返し、使い切っていれば ResourceBusyError（tenant_budget。待たせずに断る）。
   * 返す関数は、順番を待って断られた（提供元へ出さなかった）ときに呼ぶ。2 回呼んでも、1 回分だけ。覚えから外れたあとに呼んでも、何も起きない。
   * tenantId を渡さなければ、いま呼んでいる利用者（runAsCaller）
   */
  spend(tenantId: string = currentCaller()): () => void {
    const { perWindow, windowMs } = this.options.policy();
    if (!(perWindow > 0) || !(windowMs > 0)) return NOOP;
    // 小数は切り捨てる（予算が 1 未満の値でも、1 回は通す）
    const cap = Math.max(1, Math.floor(perWindow));
    const now = this.now();
    const stamps = this.spent.get(tenantId) ?? [];
    // 窓から出た回を外す（時計が戻って、未来になった回も外す。戻した時計で、ずっと断らない）
    while (stamps.length > 0 && (now - (stamps[0] as number) >= windowMs || now < (stamps[0] as number))) stamps.shift();
    this.touch(tenantId, stamps);
    if (stamps.length >= cap) {
      incrementSecurityCounter(`sora_${this.options.resource}_busy_tenant_budget_total`);
      const retryAfterSec = Math.max(1, Math.ceil(((stamps[0] as number) + windowMs - now) / 1000));
      throw new ResourceBusyError(
        `${BUDGET_WORDS[this.options.resource]}の、この利用者の予算（${windowText(windowMs)}に ${cap} 回）を使い切りました。${retryAfterSec} 秒たってから、もう一度試してください`,
        'tenant_budget',
        retryAfterSec,
        this.options.resource,
      );
    }
    stamps.push(now);
    this.trim(now, windowMs);
    let refunded = false;
    return () => {
      if (refunded) return;
      refunded = true;
      const current = this.spent.get(tenantId);
      if (!current) return;
      const index = current.lastIndexOf(now);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.spent.delete(tenantId);
    };
  }

  /** 触った利用者を、入れた順の最後に動かす（先に消してから入れ直す） */
  private touch(tenantId: string, stamps: number[]): void {
    this.spent.delete(tenantId);
    this.spent.set(tenantId, stamps);
  }

  private trim(now: number, windowMs: number): void {
    const max = this.options.maxTenants?.() ?? limits().hostMapMaxEntries;
    // いま入れた利用者の最後の時刻は now なので、窓がすぎた（stale）にならない（windowMs > 0）
    trimMap(this.spent, max, (stamps) => {
      const last = stamps[stamps.length - 1] as number;
      return now - last >= windowMs || now < last;
    });
  }
}
