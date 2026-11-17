import { ResourceBusyError } from '../../errors.js';
import { currentCaller } from '../../security/caller.js';
import { type Lease, type QueuePolicy, SimpleSemaphore } from '../../security/fair_queue.js';
import { limits } from '../../security/limits.js';
import { TenantBudget } from '../../security/tenant_budget.js';
import { ProviderHttpError } from './provider_registry.js';

export type ProviderBodyFormat = 'json' | 'xml' | 'text';

export interface ProviderHttpOptions {
  sourceId: string;
  timeoutMs: number;
  format: ProviderBodyFormat;
  signal?: AbortSignal;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  /** 順番・予算の入口。既定はこのプロセスのもの（providerHttpGate）。テストが、同時数や上限の違う入口を渡す */
  gate?: ProviderHttpGate;
}

const FORMAT_TOKENS: Record<ProviderBodyFormat, readonly string[]> = {
  json: ['json'],
  xml: ['xml'],
  text: ['text', 'plain', 'csv'],
};

export function isExpectedContentType(contentType: string | null, format: ProviderBodyFormat): boolean {
  const value = (contentType ?? '').toLowerCase();
  return FORMAT_TOKENS[format].some((token) => value.includes(token));
}

const lastFetchAt = new Map<string, number>();

/** 同時に提供元へ出す取得の数（全体） */
const CONCURRENCY = 4;

/** 国の情報の提供元への取得の順番の方針（待てる数・待ち時間）。水準（SORA_ISOLATION）に追従する。値は limits.ts */
export function providerHttpQueuePolicy(): QueuePolicy {
  const current = limits();
  return { perTenant: current.countryIntelQueuePerTenant, total: current.countryIntelQueueTotal, waitMs: current.countryIntelQueueWaitMs, sharePercent: 100 };
}

export interface ProviderHttpGateOptions {
  concurrency?: number;
  queuePolicy?: () => QueuePolicy;
  budget?: TenantBudget;
  /** 既定の予算が見る時刻（ミリ秒）。既定は Date.now（テスト用） */
  now?: () => number;
}

/**
 * 国の情報の提供元への取得の入口（設計 6。穴 25）。予算 → 順番。
 * 順番は、利用者を順番に回して公平に渡し、待つ数（1 人・全体）と待ち時間に上限を置く。待っている間に取得が中止（signal）されたら、順番から外れる。
 * 予算は、1 人が 1 分に提供元へ出せる取得の回数。順番で断った回・待ちきれなかった回は、提供元へ出していないので、予算を返す。
 * 呼んでいる利用者は currentCaller()（呼び出しの外は legacy）
 */
export function createProviderHttpGate(options: ProviderHttpGateOptions = {}) {
  const newQueue = () => new SimpleSemaphore(options.concurrency ?? CONCURRENCY, { resource: 'country_intel', policy: options.queuePolicy ?? providerHttpQueuePolicy });
  const budget = options.budget ?? new TenantBudget({ resource: 'country_intel', policy: () => ({ perWindow: limits().countryIntelBudgetPerMinute, windowMs: 60_000 }), now: options.now });
  let queue = newQueue();
  return {
    get queue(): SimpleSemaphore {
      return queue;
    },
    budget,
    /** 取得の前に呼ぶ。順番が来たら、手放す関数を返す（取得が終わったら呼ぶ）。断るときは ResourceBusyError */
    async admit(signal?: AbortSignal): Promise<Lease> {
      const tenantId = currentCaller();
      // 待てる数の確認は、予算を使う前（同時に出した要求が、順番で断られる前に予算を使い、予算の断りに化けないように）
      queue.assertCanWait(tenantId);
      const refund = budget.spend(tenantId);
      try {
        return await queue.acquire(tenantId, { signal });
      } catch (error) {
        refund();
        throw error;
      }
    },
    /** 順番・予算を最初に戻す（テスト用） */
    reset(): void {
      queue = newQueue();
      budget.clear();
    },
  };
}

export type ProviderHttpGate = ReturnType<typeof createProviderHttpGate>;

/** このプロセスの入口（既定の取得が、これを通る） */
export const providerHttpGate = createProviderHttpGate();

export function resetProviderHttpState(): void {
  lastFetchAt.clear();
  providerHttpGate.reset();
}

/**
 * 順番・予算の断り（ResourceBusyError）は、握らず・包まず、そのまま投げる。
 * 提供元の失敗（ProviderNetworkError など）にすると、再試行され、部分的な結果になり、共有のキャッシュに入って、予算に余裕のある別の利用者にも返る
 */
export function rethrowIfBusy(error: unknown): void {
  if (error instanceof ResourceBusyError) throw error;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

function defaultMinIntervalMs(host: string): number {
  if (host === 'api.gdeltproject.org') return 6000;
  return 0;
}

export async function fetchProviderResponse(url: string, options: ProviderHttpOptions): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const host = hostOf(url);
  const minInterval = options.minIntervalMs ?? defaultMinIntervalMs(host);
  const gate = options.gate ?? providerHttpGate;
  const previous = lastFetchAt.get(host) ?? Number.NEGATIVE_INFINITY;
  const waitMs = previous + minInterval - now();
  if (waitMs > 0) await sleep(waitMs);
  const release = await gate.admit(options.signal);
  try {
    lastFetchAt.set(host, now());
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const res = await fetchFn(url, { signal });
    if (res.status === 204) throw new ProviderHttpError(204, undefined, 'Provider returned no content');
    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      throw new ProviderHttpError(res.status, retryAfter ?? undefined, 'Provider HTTP ' + res.status);
    }
    return res;
  } finally {
    release();
  }
}
