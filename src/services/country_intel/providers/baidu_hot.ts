import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
export const BAIDU_HOT_URL = 'https://top.baidu.com/board?tab=realtime';
export const BAIDU_HOT_MAX_ITEMS = 30;
export interface BaiduHotEntry { rank: number; query: string; desc: string; hotIndex: string; url: string; }
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
/** 埋め込みJSONから話題配列を探す。キー名の固定化を避け汎用走査。 */
export function findHotLists(node: unknown, out: Array<Array<Record<string, unknown>>> = []): Array<Array<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    if (node.length > 3 && node.every((e) => asRecord(e) && (asText(asRecord(e)?.['query']) || asText(asRecord(e)?.['word']) || asText(asRecord(e)?.['title'])))) {
      out.push(node as Array<Record<string, unknown>>);
    }
    for (const e of node) findHotLists(e, out);
    return out;
  }
  const record = asRecord(node);
  if (!record) return out;
  for (const value of Object.values(record)) findHotLists(value, out);
  return out;
}
export function entriesFromHotList(list: readonly Record<string, unknown>[]): BaiduHotEntry[] {
  return list.slice(0, BAIDU_HOT_MAX_ITEMS).flatMap((item, index) => {
    const query = asText(item['query']) || asText(item['word']) || asText(item['title']);
    if (!query.trim()) return [];
    return [{
      rank: index + 1,
      query: query.trim(),
      desc: asText(item['desc']) || asText(item['digest']) || asText(item['content']),
      hotIndex: asText(item['hotScore']) || asText(item['hot_index']) || asText(item['heatScore']) || asText(item['score']) || asText(item['hotValue']),
      url: asText(item['url']) || asText(item['link']) || BAIDU_HOT_URL,
    }];
  });
}
/** HTML埋め込みJSON優先。構造特定前につき検出失敗は正直に空にしない（502で欠落明示）。 */
export function parseBaiduHotHtml(html: string): BaiduHotEntry[] {
  const scripts: string[] = [];
  const re = /window\.__[A-Z_]+__\s*=\s*(\{[\s\S]*?\});?\s*</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) scripts.push(m[1] ?? '');
  for (const src of scripts) {
    try {
      const lists = findHotLists(JSON.parse(src) as unknown);
      for (const list of lists) {
        const entries = entriesFromHotList(list);
        if (entries.length >= 5) return entries;
      }
    } catch { /* next candidate */ }
  }
  return [];
}
export function createBaiduHotProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'baidu_hot', areas: ['media_activity', 'current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        res = await fetchProviderResponse(BAIDU_HOT_URL, { sourceId: 'baidu_hot', timeoutMs: 8000, format: 'text', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseBaiduHotHtml(await res.text());
      if (!entries.length) throw new ProviderHttpError(502, undefined, 'Baidu hot list envelope unexpected');
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry) => {
        const excerpt = entry.hotIndex ? entry.query + ' (hot ' + entry.hotIndex + ') ' + entry.desc : (entry.query + ' ' + entry.desc);
        const evidence = normalizeEvidence({ url: entry.url, title: '#' + String(entry.rank) + ' ' + entry.query, excerpt: excerpt.slice(0, 2000), publisher: 'Baidu Hot Search', language: 'zh', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'baidu_hot', providerItemId: 'hot-' + String(entry.rank), sourceRecordUrl: entry.url, contentKind: 'excerpt', language: 'zh', blocks: [{ index: entry.rank, text: excerpt.slice(0, 2000) }], structuredData: { rank: entry.rank, hotIndex: entry.hotIndex }, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: excerpt.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
