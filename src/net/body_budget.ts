/**
 * 読み込み中の本文の量（バイト）の上限（readBodyWithLimit が使う）。止まる大きな本文を同時に何本も取ると、1 本ごとに本文の大きさだけ
 * メモリを使い続ける（29MB の本文で 1 本 約 34MB。2026-11-27 の実測）。全体は機械のメモリから決め（standard も）、strict は 1 人分の上限も置く
 * （limits の bodyBytesPerTenantMb）。予約は読んだ分ずつで、読み終えたとき（失敗も）に返す。
 */
import { ResourceBusyError } from '../errors.js';
import { detectMemoryLimitBytes } from '../memory_limit.js';
import { limits } from '../security/limits.js';
import { incrementSecurityCounter } from '../security/metrics.js';

const MB = 1024 * 1024;

/** 全体の上限: 機械のメモリ（コンテナのメモリの上限と搭載メモリの小さい方）の 25% を、256MB〜1GB に丸める。分からなければ 1GB */
export function bodyBudgetTotalBytes(machineBytes: number | undefined): number {
  if (machineBytes === undefined) return 1024 * MB;
  return Math.min(1024 * MB, Math.max(256 * MB, Math.round(machineBytes / 4)));
}

export class BodyBudget {
  private total = 0;
  private readonly byOwner = new Map<string, number>();

  /** perOwnerBytes が 0 のときは、利用者ごとの上限を置かない */
  constructor(
    private readonly totalBytes: () => number,
    private readonly perOwnerBytes: () => number,
  ) {}

  /** owner の分に n バイトを予約する。全体か、その利用者の上限を超えるなら、予約せずに ResourceBusyError（REST では 429） */
  reserve(owner: string, n: number): void {
    const own = this.byOwner.get(owner) ?? 0;
    const perOwner = this.perOwnerBytes();
    const overOwner = perOwner > 0 && own + n > perOwner;
    if (overOwner || this.total + n > this.totalBytes()) {
      incrementSecurityCounter('sora_body_busy_memory_limit_total');
      throw new ResourceBusyError(
        overOwner
          ? `読み込み中の本文の量が、この利用者の上限（${Math.round(perOwner / MB)} MB）に達しています。実行中の取得が終わってから、もう一度試してください`
          : 'サーバーが同時に読み込める本文の量の上限に達しています。しばらくしてから、もう一度試してください',
        'memory_limit',
        5,
        'body',
      );
    }
    this.byOwner.set(owner, own + n);
    this.total += n;
  }

  /** reserve した分を返す */
  release(owner: string, n: number): void {
    if (n <= 0) return;
    const left = (this.byOwner.get(owner) ?? 0) - n;
    if (left > 0) this.byOwner.set(owner, left);
    else this.byOwner.delete(owner);
    this.total = Math.max(0, this.total - n);
  }

  used(): number {
    return this.total;
  }

  usedBy(owner: string): number {
    return this.byOwner.get(owner) ?? 0;
  }
}

const TOTAL_BYTES = bodyBudgetTotalBytes(detectMemoryLimitBytes());

/** プロセスで 1 つの予算。1 人分の上限は、水準の表を呼ぶたびに読む */
export const bodyBudget = new BodyBudget(() => TOTAL_BYTES, () => limits().bodyBytesPerTenantMb * MB);
