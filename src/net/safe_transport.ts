// Shared safe-transport primitives (RFC P0-SEC-03/04).
// Call sites must validate before fetching and must never buffer
// unbounded bodies. New outbound code should build on safeFetch.
import { currentCaller } from '../security/caller.js';
import { incrementSecurityCounter } from '../security/metrics.js';
import { type BodyBudget, bodyBudget } from './body_budget.js';

export const DEFAULT_MAX_BODY_BYTES = 30 * 1024 * 1024;

/** 本文が、読む上限を超えた（読み込みの失敗と見分ける） */
export class BodyTooLargeError extends Error {}

/** 本文の読み込みが、時間の上限を超えた。文に「タイムアウト」を含める（REST で 408 に分類される） */
export class BodyTimeoutError extends Error {}

export interface BodyReadOptions {
  /** 読み始めからの時間の上限（ミリ秒） */
  timeoutMs: number;
  /** 中止されたら、読むのをやめて、その理由で失敗する（全体の時間の期限・クライアントの切断） */
  signal?: AbortSignal;
  /** 読み込み中の本文の量を数える予算（既定は、プロセスで 1 つの bodyBudget。試験が差し替える） */
  budget?: BodyBudget;
}

/**
 * Read a response body with a streaming byte cap (RFC P0-SEC-04) and a time limit.
 * 取得に渡す中止の信号は、wreq-js では、ヘッダーを受けるまでしか効かない（受けると、信号の登録を外す。本文は wreq-js の内部の上限の 300 秒まで待つ）。
 * 本文が終わらない応答が、共有の枠（PDF の解析など）を握り続けないように、ここで切る。切ると読み込みを取り消し、イメージの wreq-js の native
 * （vendor/wreq-js/body-cancel.patch を当てたもの）は、その接続もすぐ閉じる（npm 版の native は、300 秒まで残す）。時間は読み始めから数える（順番を待った時間は含めない）。
 * 読んだ量は、いま呼んでいる利用者の分に予約し（net/body_budget.ts）、上限を超えたら、読むのをやめて ResourceBusyError。読み終えたら（失敗も）返す
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  options: BodyReadOptions,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const stop = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  // 読み込みを中止すると、待っている read は done で返る（Streams の仕様）ので、下で、中止されたかを確かめる
  const cancel = () => { reader.cancel().catch(() => {}); };
  if (stop.aborted) cancel();
  else stop.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  const budget = options.budget ?? bodyBudget;
  const owner = currentCaller();
  let reserved = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (stop.aborted) {
        if (deadline.aborted && stop.reason === deadline.reason) throw new BodyTimeoutError(`本文の読み込みがタイムアウトしました（${options.timeoutMs}ms）`);
        throw stop.reason;
      }
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        incrementSecurityCounter('sora_response_size_abort_total');
        throw new BodyTooLargeError(`Response exceeds ${maxBytes} bytes`);
      }
      try {
        budget.reserve(owner, value.byteLength);
      } catch (error) {
        try { await reader.cancel(); } catch {}
        throw error;
      }
      reserved += value.byteLength;
      chunks.push(value);
    }
  } finally {
    budget.release(owner, reserved);
    stop.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch {}
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  validate?: (url: URL) => Promise<void> | void;
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !SENSITIVE_REDIRECT_HEADERS.has(k.toLowerCase())),
  );
}

/** SSRF-checked fetch with manual redirects, credential stripping and body cap. */
export async function safeFetch(
  input: string,
  options: SafeFetchOptions & { validate: (url: URL) => Promise<void> | void },
): Promise<{ finalUrl: string; body: Uint8Array; response: Response }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? 15000;
  let currentUrl = input;
  let headers = { ...(options.headers ?? {}) };
  let redirects = 0;
  for (;;) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Blocked protocol: ${parsed.protocol}`);
    await options.validate(parsed);
    const res = await fetch(currentUrl, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const len = res.headers.get('content-length');
    if (len && parseInt(len, 10) > maxBytes) {
      incrementSecurityCounter('sora_response_size_abort_total');
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return { finalUrl: currentUrl, body: await readBodyWithLimit(res, maxBytes, { timeoutMs }), response: res };
      const next = new URL(location, currentUrl);
      await options.validate(next);
      if (next.origin !== parsed.origin) {
        const before = Object.keys(headers).length;
        headers = stripSensitiveHeaders(headers);
        if (Object.keys(headers).length !== before) incrementSecurityCounter('sora_credential_strip_total');
      }
      currentUrl = next.href;
      if (++redirects > maxRedirects) throw new Error(`Redirect limit exceeded (${maxRedirects})`);
      continue;
    }
    return { finalUrl: currentUrl, body: await readBodyWithLimit(res, maxBytes, { timeoutMs }), response: res };
  }
}
