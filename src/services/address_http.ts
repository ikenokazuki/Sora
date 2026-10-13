import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const ABR_BASE = 'https://data.address-br.digital.go.jp';
/** 旧ページの URL。新しいページへ 301 で転送される。zip のリンクはここから解決する。 */
export const JAPANPOST_KEN_ALL_PAGE = 'https://www.post.japanpost.jp/zipcode/dl/utf-zip.html';
export const JAPANPOST_JIGYOSYO_PAGE = 'https://www.post.japanpost.jp/zipcode/dl/jigyosyo/index-zip.html';
/** ページからリンクを解決できないときに使う、確認済みの直 URL。 */
export const JAPANPOST_FALLBACK = {
  kenAll: 'https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip',
  jigyosyo: 'https://www.post.japanpost.jp/service/search/zipcode/download/office/zip/jigyosyo.zip',
} as const;
export const ADDRESS_USER_AGENT = 'Sora-Address-Data/1.0 (+https://github.com/ikenokazuki/Sora)';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
}

export class AddressHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly blocked: boolean, readonly retryable: boolean) {
    super(message);
    this.name = 'AddressHttpError';
  }
}

export interface Signature {
  url: string;
  etag: string | null;
  lastModified: string | null;
  size: number | null;
}

/** 403 は国外 IP の拒否として再試行せず、429 / 5xx / 通信エラーは待って再試行する。404 はそのまま返す。 */
async function request(url: string, method: 'GET' | 'HEAD', deps: HttpDeps): Promise<Response> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((target, init) => fetch(target, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.retries ?? 3;
  let lastError: AddressHttpError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        redirect: 'follow',
        headers: { 'User-Agent': ADDRESS_USER_AGENT, Accept: '*/*' },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
      });
    } catch (error) {
      lastError = new AddressHttpError(`${url}: ${error instanceof Error ? error.message : String(error)}`, null, false, true);
      continue;
    }
    if (response.status === 403) {
      throw new AddressHttpError(`${url}: HTTP 403（国外 IP からの接続は拒否されます）`, 403, true, false);
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, true);
      continue;
    }
    return response;
  }
  throw lastError ?? new AddressHttpError(`${url}: request failed`, null, false, true);
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signatureOf(url: string, response: Response): Signature {
  return {
    url,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    size: numberOrNull(response.headers.get('content-length')),
  };
}

export async function headSignature(url: string, deps: HttpDeps = {}): Promise<Signature | null> {
  const response = await request(url, 'HEAD', deps);
  if (response.status === 404) return null;
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  return signatureOf(url, response);
}

/** 取得元の変化を 1 つの値にまとめる。並び順は呼び出し側で固定する。 */
export function combineSignatures(signatures: ReadonlyArray<Signature | null>): string {
  const parts = signatures.map((s) => (s ? [s.url, s.etag, s.lastModified, s.size] : null));
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function latestSourceDate(signatures: ReadonlyArray<Signature | null>): string | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (const signature of signatures) {
    const time = signature?.lastModified ? Date.parse(signature.lastModified) : Number.NaN;
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString().slice(0, 10) : undefined;
}

export async function downloadToFile(url: string, destPath: string, deps: HttpDeps = {}): Promise<{ signature: Signature; bytes: number } | null> {
  const response = await request(url, 'GET', deps);
  if (response.status === 404) return null;
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  mkdirSync(dirname(destPath), { recursive: true });
  const part = `${destPath}.part`;
  await Bun.write(part, response);
  renameSync(part, destPath);
  return { signature: signatureOf(url, response), bytes: statSync(destPath).size };
}

export async function fetchText(url: string, deps: HttpDeps = {}): Promise<{ text: string; finalUrl: string }> {
  const response = await request(url, 'GET', deps);
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  return { text: await response.text(), finalUrl: response.url || url };
}

async function resolveLink(page: string, pattern: RegExp, fallback: string, deps: HttpDeps): Promise<string> {
  try {
    const { text, finalUrl } = await fetchText(page, deps);
    const href = text.match(pattern)?.[1];
    if (href) return new URL(href, finalUrl).toString();
  } catch { /* 既知の直 URL に落とす。以降の HEAD で本当の失敗を拾う */ }
  return fallback;
}

/** 日本郵便は URL を動かすことがあるので、ページから zip のリンクを解決する。 */
export async function resolveJapanPostLinks(deps: HttpDeps = {}): Promise<{ kenAll: string; jigyosyo: string }> {
  const [kenAll, jigyosyo] = await Promise.all([
    resolveLink(JAPANPOST_KEN_ALL_PAGE, /href="([^"]*utf_ken_all\.zip)"/, JAPANPOST_FALLBACK.kenAll, deps),
    resolveLink(JAPANPOST_JIGYOSYO_PAGE, /href="([^"]*jigyosyo\.zip)"/, JAPANPOST_FALLBACK.jigyosyo, deps),
  ]);
  return { kenAll, jigyosyo };
}
