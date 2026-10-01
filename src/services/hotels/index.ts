import {
  HotelSearchInputSchema,
  isRakutenTravelEnabled,
  type HotelFailureCode,
  type HotelSearchInput,
  type HotelSearchQuery,
  type HotelSearchResult,
} from './types.js';
import {
  encodeRakutenSearch,
  parseRakutenResponse,
  RakutenHotelError,
  resolveRakutenLocation,
  type ResolvedRakutenLocation,
} from './rakuten.js';

export interface HotelFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HotelFetchFn = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
) => Promise<HotelFetchResponse>;

export interface HotelServiceOptions {
  fetchImpl?: HotelFetchFn;
  now?: () => number;
  /** Upstream start spacing. Default 3000 per the research plan. */
  minIntervalMs?: number;
  /** Total budget per call including queueing. Default 20000. */
  callBudgetMs?: number;
  /** Upstream requests per call. Default 6. */
  maxUpstreamRequests?: number;
  /** Suppression after 429 without Retry-After. Default 60000. */
  defaultSuppressionMs?: number;
}

export interface HotelCallContext {
  signal: AbortSignal;
  deadlineAt: number;
}

export interface HotelService {
  searchHotelAvailability(input: HotelSearchQuery, context: HotelCallContext): Promise<HotelSearchResult>;
}

const jstDateOf = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

function parseRetryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isNaN(at)) {
    const diff = at - Date.now();
    if (diff > 0) return diff;
  }
  return fallbackMs;
}

export function createHotelService(options: HotelServiceOptions = {}): HotelService {
  const fetchImpl: HotelFetchFn = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? 3000;
  const callBudgetMs = options.callBudgetMs ?? 20000;
  const maxUpstreamRequests = options.maxUpstreamRequests ?? 6;
  const defaultSuppressionMs = options.defaultSuppressionMs ?? 60000;

  let mutex: Promise<void> = Promise.resolve();
  let lastStart = 0;
  let suppressedUntil = 0;
  interface Shared {
    promise: Promise<HotelSearchResult>;
    controller: AbortController;
    waiters: Set<symbol>;
  }
  const inflight = new Map<string, Shared>();

  const failed = (
    valid: HotelSearchInput,
    code: HotelFailureCode,
    message: string,
  ): HotelSearchResult => ({
    source: 'rakuten_travel',
    status: 'unavailable',
    query: {
      location: valid.location,
      checkIn: valid.checkIn,
      checkOut: valid.checkOut,
      adults: valid.adults,
      rooms: valid.rooms,
      limit: valid.limit,
    },
    retrievedAt: new Date(now()).toISOString(),
    hotels: [],
    warnings: [],
    failures: [{ code, message }],
  });

  const timedOut = (valid: HotelSearchInput, message: string): HotelSearchResult =>
    failed(valid, 'TIMEOUT', message);

  /**
   * Races one waiter against the shared fetch. The waiter must already be in
   * `waiters`. Leaving aborts the upstream fetch only when nobody remains.
   * The shared deadline is never extended by late joiners.
   */
  async function raceShared(
    shared: Shared,
    waiter: symbol,
    valid: HotelSearchInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<HotelSearchResult> {
    try {
      if (signal.aborted) return timedOut(valid, '呼び出しが中断されました');
      const waitMs = deadlineAt - now();
      if (waitMs <= 0) return timedOut(valid, '待ち時間の期限が切れています');
      return await new Promise<HotelSearchResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RakutenHotelError('TIMEOUT', '待ち時間の期限が切れました')), waitMs);
        const onAbort = () => reject(new RakutenHotelError('TIMEOUT', '呼び出しが中断されました'));
        signal.addEventListener('abort', onAbort, { once: true });
        shared.promise.then(
          (result) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    } catch (err) {
      if (err instanceof RakutenHotelError && err.code === 'TIMEOUT') {
        return timedOut(valid, err.message);
      }
      throw err;
    } finally {
      shared.waiters.delete(waiter);
      if (shared.waiters.size === 0) shared.controller.abort();
    }
  }

  /** Waits for the previous slot holder. False when nobody waits or the deadline passed. */
  async function waitForTurn(prev: Promise<void>, waiters: Set<symbol>, deadlineAt: number): Promise<boolean> {
    let released = false;
    void prev.then(() => {
      released = true;
    });
    while (!released) {
      if (waiters.size === 0 || now() >= deadlineAt) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return waiters.size > 0 && now() < deadlineAt;
  }

  async function runExclusive(
    valid: HotelSearchInput,
    resolved: ResolvedRakutenLocation,
    controller: AbortController,
    waiters: Set<symbol>,
    deadlineAt: number,
  ): Promise<HotelSearchResult> {
    const prev = mutex;
    let release!: () => void;
    mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (!(await waitForTurn(prev, waiters, deadlineAt))) {
        return timedOut(valid, '待ち時間の期限が切れました');
      }
      if (now() < suppressedUntil) {
        return failed(valid, 'RATE_LIMITED', '混雑のため取得を抑制しています。しばらく待って再試行してください');
      }
      const gap = lastStart + minIntervalMs - now();
      if (gap > 0) {
        if (now() + gap > deadlineAt || waiters.size === 0) {
          return timedOut(valid, '待ち時間の期限が切れました');
        }
        await new Promise((resolve) => setTimeout(resolve, gap));
      }
      if (waiters.size === 0 || now() >= deadlineAt) {
        return timedOut(valid, '待ち時間の期限が切れました');
      }
      const url = encodeRakutenSearch(valid, resolved);
      const remaining = Math.min(deadlineAt - now(), callBudgetMs);
      if (remaining <= 0) return timedOut(valid, '待ち時間の期限が切れました');
      let upstreamCount = 0;
      lastStart = now();
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
      let res: HotelFetchResponse;
      try {
        if (++upstreamCount > maxUpstreamRequests) {
          throw new RakutenHotelError('UPSTREAM_ERROR', '上流要求の上限を超えました');
        }
        res = await fetchImpl(url.toString(), { redirect: 'manual', signal: combined });
      } catch {
        return timedOut(valid, '取得が時間内に終わりませんでした');
      }
      if (res.status === 429) {
        suppressedUntil = now() + parseRetryAfterMs(res.headers.get('retry-after'), defaultSuppressionMs);
        return failed(valid, 'RATE_LIMITED', '混雑のため取得できませんでした。しばらく待って再試行してください');
      }
      if (res.status === 403) {
        return failed(valid, 'ACCESS_DENIED', '上流へのアクセスが拒否されました');
      }
      if (res.status !== 200) {
        return failed(valid, 'UPSTREAM_ERROR', '上流の応答が異常です (HTTP ' + res.status + ')。リダイレクトは自動追従しません');
      }
      let html: string;
      try {
        html = await res.text();
      } catch {
        return timedOut(valid, '取得が時間内に終わりませんでした');
      }
      try {
        return parseRakutenResponse(
          { status: 200, html, url: url.toString() },
          valid,
          new Date(now()).toISOString(),
        );
      } catch {
        return failed(valid, 'UPSTREAM_ERROR', '応答の解析中に予期しないエラーが発生しました');
      }
    } finally {
      release();
    }
  }

  async function searchHotelAvailability(
    input: HotelSearchQuery,
    context: HotelCallContext,
  ): Promise<HotelSearchResult> {
    if (!isRakutenTravelEnabled()) {
      return failed(
        { ...input, rooms: input.rooms ?? 1, limit: input.limit ?? 5 },
        'UNSUPPORTED_CONDITION',
        'ホテル検索は無効です (SORA_RAKUTEN_TRAVEL_ENABLED=true で有効化)',
      );
    }
    const parsed = HotelSearchInputSchema.safeParse(input);
    if (!parsed.success) {
      return failed(
        { ...input, rooms: input.rooms ?? 1, limit: input.limit ?? 5 },
        'UNSUPPORTED_CONDITION',
        '入力が不正です: ' + parsed.error.issues[0]?.message,
      );
    }
    const valid = parsed.data;
    if (valid.checkIn < jstDateOf(now())) {
      return failed(valid, 'UNSUPPORTED_CONDITION', '過去の日付には対応していません: ' + valid.checkIn);
    }
    let resolved: ResolvedRakutenLocation;
    try {
      resolved = resolveRakutenLocation(valid.location);
    } catch (err) {
      if (err instanceof RakutenHotelError) return failed(valid, err.code, err.message);
      throw err;
    }
    if (context.signal.aborted || now() >= context.deadlineAt) {
      return timedOut(valid, '待ち時間の期限が切れています');
    }
    const key = [resolved.id, valid.checkIn, valid.checkOut, valid.adults, valid.rooms, valid.limit].join('|');
    const existing = inflight.get(key);
    if (existing) {
      const waiter = Symbol();
      existing.waiters.add(waiter);
      return raceShared(existing, waiter, valid, context.signal, context.deadlineAt);
    }
    const controller = new AbortController();
    const waiters = new Set<symbol>();
    const waiter = Symbol();
    waiters.add(waiter);
    const shared: Shared = {
      controller,
      waiters,
      promise: runExclusive(valid, resolved, controller, waiters, context.deadlineAt).catch(
        (): HotelSearchResult => failed(valid, 'UPSTREAM_ERROR', '応答の処理中に予期しないエラーが発生しました'),
      ),
    };
    shared.promise.finally(() => {
      if (inflight.get(key) === shared) inflight.delete(key);
    });
    inflight.set(key, shared);
    return raceShared(shared, waiter, valid, context.signal, context.deadlineAt);
  }

  return { searchHotelAvailability };
}

/** Shared production instance behind the experimental flag. */
export const hotelService = createHotelService();
