// 日次クォータ（SORA_AUTH_DAILY_LIMIT）の重み（設計 6。穴 26）。
// 認証のミドルウェアは、要求 1 つを 1 回と数える。一括（最大 20 URL）や crawl（最大 50 ページ）は、1 回の要求で何件も取るので、
// 件数分を足して数える（最初の 1 回は、ミドルウェアがもう数えている）。数える先は、ミドルウェアと同じ表（api_usage）の同じ行。
import { envInt } from '../config.js';
import { dbAddApiUsage, dbGetApiUsage } from '../db.js';
import { QuotaExceededError } from '../errors.js';
import { PUBLIC_TENANT_ID } from './tenant_context.js';

/** 今日（UTC）の日付。crawl のように日をまたぎうる呼び出しは、始めに 1 回取って、足す・戻すに同じ日を渡す */
export const quotaDay = (): string => new Date().toISOString().slice(0, 10);

/** 数えるか。stdio（待ち受けも認証も無く、要求の 1 回を数える層も無い）は、無効にする。ほかは有効 */
let enabled = true;
export function setQuotaEnabled(value: boolean): void {
  enabled = value;
}

/**
 * tenant の ID から、使用量の表の鍵を引く。認証のミドルウェアの数え方と同じ:
 * 単一の鍵は鍵のハッシュ（tenant の ID は `key:` + 同じハッシュ）、匿名（legacy）は 'anonymous'、鍵ファイルは tenant の ID（`name:<name>`）。
 * Sora 自身の取得（public）は、利用者の要求ではないので、数えない（undefined）
 */
export function usageKeyForTenant(tenantId: string): string | undefined {
  if (tenantId === PUBLIC_TENANT_ID) return undefined;
  if (tenantId.startsWith('key:')) return tenantId.slice('key:'.length);
  if (tenantId === 'legacy') return 'anonymous';
  return tenantId;
}

/** 足してよい件数か（正の整数だけ。0・負・小数・数でないものは、足さない） */
const validUnits = (units: number): boolean => Number.isInteger(units) && units > 0;

/** 上限を超えるなら、足さずに断る。上限を決めていなければ（既定）、何もしない。day は数える日（省くと今日） */
export function checkQuota(tenantId: string, units: number, day = quotaDay()): void {
  const key = usageKeyForTenant(tenantId);
  const limit = envInt('SORA_AUTH_DAILY_LIMIT');
  if (!enabled || key === undefined || limit === undefined || !validUnits(units)) return;
  const current = dbGetApiUsage(key, day);
  if (current + units > limit) throw new QuotaExceededError(limit, current, units);
}

/** units 回ぶんを足す。上限を超えるなら、何も足さずに QuotaExceededError。上限を決めていなくても、数える（使用量の記録のため） */
export function chargeQuota(tenantId: string, units: number, day = quotaDay()): void {
  const key = usageKeyForTenant(tenantId);
  if (!enabled || key === undefined || !validUnits(units)) return;
  checkQuota(tenantId, units, day); // 同期のまま足すので、ここと足す間に、ほかの呼び出しは入らない
  dbAddApiUsage(key, day, units);
}

/** 足した分を戻す（crawl が、実際に試みた数より多く数えた分）。足した日を day に渡す（日をまたいだら、翌日の行を減らさない）。0 より下にはしない */
export function refundQuota(tenantId: string, units: number, day = quotaDay()): void {
  const key = usageKeyForTenant(tenantId);
  if (!enabled || key === undefined || !validUnits(units)) return;
  dbAddApiUsage(key, day, -units);
}
