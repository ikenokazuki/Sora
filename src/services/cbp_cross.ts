// 米国税関（CBP）の判例検索 CROSS（rulings.cbp.gov）。分類判例は「普段の言葉」と法令の用語をつなぐ手がかりになる。
// 一括取得の手段が無いため、推測が呼ばれたときだけ照会し、結果を 24 時間キャッシュする。
// 失敗しても推測は止めない（呼び出し側は HTS の全文検索だけで答える）。連続で失敗したときは 60 秒、照会を控える。
import { getFromCache, setToCache } from '../cache.js';
import { errorMessage } from '../errors.js';

export const CROSS_SEARCH_URL = 'https://rulings.cbp.gov/api/search';
export const CROSS_RULING_URL = 'https://rulings.cbp.gov/ruling/';
const CACHE_TTL_CROSS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const BREAKER_MS = 60_000;
const PAGE_SIZE = 10;
// ヒットが多すぎる語（model, table など）は、上位の判例が商品と無関係になるので使わない。
const MAX_TOTAL_HITS = 2000;

export interface CrossRuling {
  rulingNumber: string;
  subject: string;
  date: string;
  /** 判例が挙げた分類コード（数字のみ、6〜10 桁）。 */
  tariffs: string[];
  url: string;
}

export type CrossStatus = 'ok' | 'no_rulings' | 'unavailable';

export interface CrossLookup {
  status: CrossStatus;
  /** 判例が得られた照会語（最後に試したもの）。 */
  query?: string;
  rulings: CrossRuling[];
  error?: string;
}

interface RawRuling {
  rulingNumber?: string;
  subject?: string;
  categories?: string;
  rulingDate?: string;
  tariffs?: string;
  operationallyRevoked?: boolean;
  revokedBy?: unknown[];
}

let unavailableUntil = 0;

/** 判例の tariffs 欄（"6912.00.4400, 6912.00.4810" など）から、コードを数字だけにして取り出す。 */
export function parseCrossTariffs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const m of raw.matchAll(/\d{4}\.\d{2}(?:\.\d{4}|\.\d{2}(?:\.\d{2})?)?/g)) out.add(m[0].replace(/\D/g, ''));
  return [...out];
}

async function fetchRulings(term: string): Promise<{ rulings: CrossRuling[]; totalHits: number }> {
  const cacheKey = `trade:cross:${PAGE_SIZE}:${term.toLowerCase()}`;
  const cached = getFromCache<{ rulings: CrossRuling[]; totalHits: number }>(cacheKey);
  if (cached) return { rulings: cached.rulings, totalHits: cached.totalHits };

  const url = `${CROSS_SEARCH_URL}?term=${encodeURIComponent(term)}&collection=ALL&commodityGrouping=ALL&sortBy=RELEVANCE&pageSize=${PAGE_SIZE}&page=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Sora-Trade-Compliance-Fetcher/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CBP判例検索(CROSS)へのアクセスに失敗しました (HTTP ${res.status})`);
  const body = (await res.json()) as { rulings?: RawRuling[]; totalHits?: number };
  const rulings: CrossRuling[] = [];
  for (const r of body.rulings ?? []) {
    // 分類の判例だけを使う。取り消された判例は除く
    if (!r.rulingNumber || !/classification/i.test(r.categories ?? '')) continue;
    if (r.operationallyRevoked || (r.revokedBy?.length ?? 0) > 0) continue;
    const tariffs = parseCrossTariffs(r.tariffs);
    if (tariffs.length === 0) continue;
    rulings.push({
      rulingNumber: r.rulingNumber,
      subject: (r.subject ?? '').replace(/\s+/g, ' ').trim(),
      date: (r.rulingDate ?? '').slice(0, 10),
      tariffs,
      url: `${CROSS_RULING_URL}${encodeURIComponent(r.rulingNumber)}`,
    });
  }
  const totalHits = body.totalHits ?? rulings.length;
  setToCache(cacheKey, { rulings, totalHits }, CACHE_TTL_CROSS);
  return { rulings, totalHits };
}

/**
 * 照会語を順に試し、判例を target 件まで集める。検索は AND 条件で、語が多いと 0 件になる。
 * 具体的な照会語の判例（"leather coaster" の 4205.00 など少数でも的確なもの）を先頭に残し、足りない分を
 * 一般的な照会語（"coaster" の 132 件）で補う。照会語は具体的なものから渡す。
 */
export async function lookupCrossRulings(queries: string[], target = PAGE_SIZE): Promise<CrossLookup> {
  if (Date.now() < unavailableUntil) return { status: 'unavailable', rulings: [], error: '直前の照会に失敗したため、一時的に照会を控えています' };
  const seen = new Set<string>();
  const rulings: CrossRuling[] = [];
  const used: string[] = [];
  const found = (): CrossLookup => (rulings.length > 0 ? { status: 'ok', query: used.join(' / '), rulings } : { status: 'no_rulings', rulings: [] });
  for (const q of queries) {
    if (rulings.length >= target) break;
    try {
      const { rulings: got, totalHits } = await fetchRulings(q);
      if (totalHits > MAX_TOTAL_HITS) break; // これ以降の照会語はさらに短く、より一般的になる
      let added = false;
      for (const r of got) {
        if (seen.has(r.rulingNumber) || rulings.length >= target) continue;
        seen.add(r.rulingNumber);
        rulings.push(r);
        added = true;
      }
      if (added) used.push(q);
    } catch (err) {
      unavailableUntil = Date.now() + BREAKER_MS;
      return rulings.length > 0 ? found() : { status: 'unavailable', rulings: [], error: errorMessage(err) };
    }
  }
  return found();
}

/** テスト用: 照会を控える状態を解除する。 */
export function resetCrossBreakerForTest(): void {
  unavailableUntil = 0;
}
