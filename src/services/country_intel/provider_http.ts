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
  maxConcurrency?: number;
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
let activeRequests = 0;
const waiters: Array<() => void> = [];

export function resetProviderHttpState(): void {
  lastFetchAt.clear();
  waiters.length = 0;
  activeRequests = 0;
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

async function acquire(maxConcurrency: number): Promise<void> {
  while (activeRequests >= maxConcurrency) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  activeRequests += 1;
}

function release(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next();
}

export async function fetchProviderResponse(url: string, options: ProviderHttpOptions): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const host = hostOf(url);
  const minInterval = options.minIntervalMs ?? defaultMinIntervalMs(host);
  const maxConcurrency = options.maxConcurrency ?? 4;
  const previous = lastFetchAt.get(host) ?? Number.NEGATIVE_INFINITY;
  const waitMs = previous + minInterval - now();
  if (waitMs > 0) await sleep(waitMs);
  await acquire(maxConcurrency);
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
