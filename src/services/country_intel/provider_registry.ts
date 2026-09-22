import { dbGetCache, dbSetCache } from '../../db.js';
import type {
  CalendarEvent,
  CountryEvidence,
  CountrySource,
  PollObservation,
  ProviderRun,
  ProviderRunStatus,
  TemporalMetric,
} from './types.js';
import type { ResearchPlan, ResearchQuery } from './query_planner.js';
import type { EvidenceDetail } from './detail.js';

export type { ProviderCapability, ResearchPlan, ResearchPlanLimits, ResearchQuery } from './query_planner.js';

export interface AcquisitionItem {
  evidence?: CountryEvidence;
  detail?: EvidenceDetail;
  poll?: PollObservation;
  calendar?: CalendarEvent;
  metric?: TemporalMetric;
  source?: CountrySource;
  /** レコード単位の分野。未指定時は provider 申告を使う。集約の media_activity 等で上書きしない。 */
  areas?: readonly string[];
}

/** provider identity を保持した取得アイテム。flatMap時に失わない。 */
export interface AcquiredItem {
  providerId: string;
  areas: readonly string[];
  item: AcquisitionItem;
}

export interface ProviderInput {
  request: ResearchPlan['request'];
  region: ResearchPlan['region'];
  queries: readonly ResearchQuery[];
}

export interface ProviderResult {
  items: AcquisitionItem[];
  coverage?: string[];
  status?: ProviderRunStatus;
  errorCode?: string;
}

export interface CountryIntelProvider {
  id: string;
  areas: readonly string[];
  /** 1回の実行で遡れる収集範囲（日数）。未申告は不明扱い。actualWindows の注記に使う。 */
  collectionWindowDays?: number;
  /** provider 固有の実行上限ms。未指定時は run 時の timeoutMs を使う。 */
  timeoutMs?: number;
  latencyClass: CountryEvidence['latencyClass'];
  defaultTtlSeconds: number;
  run(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult>;
}

export interface AcquisitionResult {
  items: AcquiredItem[];
  runs: ProviderRun[];
}

export interface ProviderCache {
  get(key: string): { value: ProviderResult; expiresAt: number } | undefined;
  set(key: string, value: ProviderResult, ttlSeconds: number): void;
}

export interface RunProviderOptions {
  timeoutMs?: number;
  noCache?: boolean;
  cache?: ProviderCache | null;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetryAfterMs?: number;
}

/** 本文補完の予算。未指定の項目は report 側の既定値を使う。 */
export interface EnrichBudget {
  maxItems?: number;
  concurrency?: number;
  perItemMs?: number;
  maxCharsPerItem?: number;
  totalChars?: number;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string | number,
    message = `Provider HTTP ${status}`,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export class ProviderNetworkError extends Error {
  constructor(message = 'Provider network error') {
    super(message);
    this.name = 'ProviderNetworkError';
  }
}

/** 外部HTTPではなく自側の処理（解凍・解析・依存欠落・予算切れ）の失敗。 */
export class ProviderLocalError extends Error {
  constructor(
    readonly code:
      | 'DECOMPRESS_FAILED'
      | 'DECOMPRESS_MISSING'
      | 'PARSE_FAILED'
      | 'SIZE_LIMIT'
      | 'BUDGET_EXHAUSTED',
    message?: string,
  ) {
    super(message ?? ('Provider local failure ' + code));
    this.name = 'ProviderLocalError';
  }
}

const persistentCache: ProviderCache = {
  get: (key) => dbGetCache<ProviderResult>(key),
  set: (key, value, ttlSeconds) => dbSetCache(key, value, ttlSeconds),
};

export function providerCacheKey(providerId: string, plan: ResearchPlan): string {
  const topics = [...(plan.request.topics ?? [])].sort();
  const queries = [...plan.pass1, ...plan.pass2]
    .filter((query) => query.providerId === providerId)
    .map((query) => query.query);
  return `country-intel:provider:v1:${encodeURIComponent(providerId)}:${JSON.stringify({
    region: plan.region.id,
    topics,
    period: plan.request.period ?? '30d',
    query: plan.request.query?.trim() ?? '',
    queries,
  })}`;
}

function retryAfterMs(value: string | number | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 1_000 : undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function isNetwork(error: unknown): boolean {
  return error instanceof ProviderNetworkError || error instanceof TypeError;
}

function failure(error: unknown): { status: ProviderRunStatus; errorCode: string } {
  if (isTimeout(error)) return { status: 'unavailable', errorCode: 'PROVIDER_TIMEOUT' };
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { status: 'unavailable', errorCode: 'PROVIDER_ABORTED' };
  }
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return { status: 'rate_limited', errorCode: 'PROVIDER_RATE_LIMITED' };
    if (error.status >= 500) return { status: 'unavailable', errorCode: 'PROVIDER_HTTP_5XX' };
    if (error.status >= 400) return { status: 'error', errorCode: 'PROVIDER_HTTP_4XX' };
  }
  if (isNetwork(error)) return { status: 'unavailable', errorCode: 'PROVIDER_NETWORK' };
  if (error instanceof ProviderLocalError) return { status: 'error', errorCode: 'PROVIDER_LOCAL_' + error.code };
  return { status: 'error', errorCode: 'PROVIDER_ERROR' };
}

function statusErrorCode(status: ProviderRunStatus | undefined): string | undefined {
  if (status === 'partial') return 'PROVIDER_PARTIAL';
  if (status === 'unavailable') return 'PROVIDER_UNAVAILABLE';
  if (status === 'rate_limited') return 'PROVIDER_RATE_LIMITED';
  if (status === 'error') return 'PROVIDER_ERROR';
  return undefined;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => rejectOnce(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolveOnce, rejectOnce);
    if (signal.aborted) onAbort();
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callProvider(
  provider: CountryIntelProvider,
  input: ProviderInput,
  signal: AbortSignal,
  options: RunProviderOptions,
): Promise<ProviderResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await raceAbort(provider.run(input, signal), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const retryTransient = attempt === 0
        && ((error instanceof ProviderHttpError && error.status >= 500) || isNetwork(error));
      if (retryTransient) continue;
      if (attempt === 0 && error instanceof ProviderHttpError && error.status === 429) {
        const delay = retryAfterMs(error.retryAfter, (options.now ?? Date.now)());
        if (delay !== undefined && delay <= (options.maxRetryAfterMs ?? 5_000)) {
          await raceAbort((options.sleep ?? defaultSleep)(delay), signal);
          continue;
        }
      }
      throw error;
    }
  }
}

async function runOne(
  plan: ResearchPlan,
  provider: CountryIntelProvider,
  options: RunProviderOptions,
): Promise<{ items: AcquiredItem[]; run: ProviderRun }> {
  const now = options.now ?? Date.now;
  const started = now();
  const startedAt = new Date(started).toISOString();
  const cache = options.cache === undefined ? persistentCache : options.cache;
  const key = providerCacheKey(provider.id, plan);

  try {
    let result: ProviderResult | undefined;
    if (!options.noCache && cache) result = cache.get(key)?.value;
    if (!result) {
      const signal = AbortSignal.timeout(provider.timeoutMs ?? options.timeoutMs ?? 10_000);
      result = await callProvider(provider, {
        request: plan.request,
        region: plan.region,
        queries: [...plan.pass1, ...plan.pass2].filter((query) => query.providerId === provider.id),
      }, signal, options);
      if (cache && (result.status === undefined || result.status === 'success' || result.status === 'partial')) {
        try { cache.set(key, result, provider.defaultTtlSeconds); } catch {}
      }
    }
    const finished = now();
    const items = result.items.map((item) => ({
      providerId: provider.id,
      areas: [...(item.areas ?? provider.areas)],
      item,
    }));
    return {
      items,
      run: {
        provider: provider.id,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        status: result.status ?? 'success',
        itemCount: items.length,
        coverage: result.coverage ?? [...provider.areas],
        latencyMs: Math.max(0, finished - started),
        errorCode: result.errorCode ?? statusErrorCode(result.status),
      },
    };
  } catch (error) {
    const finished = now();
    return {
      items: [],
      run: {
        provider: provider.id,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        ...failure(error),
        itemCount: 0,
        coverage: [...provider.areas],
        latencyMs: Math.max(0, finished - started),
      },
    };
  }
}

export async function runProviders(
  plan: ResearchPlan,
  providers: readonly CountryIntelProvider[],
  options: RunProviderOptions = {},
): Promise<AcquisitionResult> {
  const results = await Promise.all(providers.map((provider) => runOne(plan, provider, options)));
  return {
    items: results.flatMap((result) => result.items),
    runs: results.map((result) => result.run),
  };
}

/** 指定 pass の query のみを実行する。pass1 と pass2 を時系列で分離するために使う。 */
export async function runProviderPass(
  plan: ResearchPlan,
  pass: 1 | 2,
  providers: readonly CountryIntelProvider[],
  options: RunProviderOptions = {},
): Promise<AcquisitionResult> {
  const passPlan: ResearchPlan = {
    ...plan,
    pass1: pass === 1 ? [...plan.pass1] : [],
    pass2: pass === 2 ? [...plan.pass2] : [],
  };
  // その pass に query がない provider は実行しない (全取得の二重化を防ぐ)。
  const queries = pass === 1 ? passPlan.pass1 : passPlan.pass2;
  const withQueries = new Set(queries.map((query) => query.providerId));
  return runProviders(passPlan, providers.filter((provider) => withQueries.has(provider.id)), options);
}
