import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';

export const SO360_SEARCH_BASE = 'https://www.so.com/s';
export const SO360_MAX_ITEMS = 10;
const SO360_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface So360Entry { title: string; url: string; snippet: string; }

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** SSR結果をパースする。発行者直URL (data-mdurl) のある項目のみ採用し、暗号リダイレクトだけの項目は捨てる。 */
export function parseSo360Html(html: string): So360Entry[] {
  const entries: So360Entry[] = [];
  const blocks = html.split('<li class="res-list"');
  for (const block of blocks.slice(1)) {
    const mdurl = /data-mdurl="(https?:\/\/[^"\s<>]+)"/.exec(block)?.[1];
    if (!mdurl) continue;
    const titleRaw = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/.exec(block)?.[1] ?? '';
    const descRaw = /<p class="res-desc">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '';
    const title = stripTags(titleRaw);
    if (!title) continue;
    entries.push({ title, url: mdurl, snippet: stripTags(descRaw) });
    if (entries.length >= SO360_MAX_ITEMS) break;
  }
  return entries;
}

export function buildSo360SearchUrl(query: string): string {
  return SO360_SEARCH_BASE + '?q=' + encodeURIComponent(query).replace(/%20/g, '+');
}

export function createSo360SearchProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'so360_search', areas: ['media_activity', 'current_events'], regions: ['CN'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    /** Cookie配布302の2段取得を外側10秒既定内に収める。 */
    timeoutMs: 14000,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (input.region.countryCode !== 'CN') return { items: [] as AcquisitionItem[], coverage: [] };
      const planned = input.queries.map((q) => q.query).find((q) => q && q.trim());
      const query = planned?.trim() ? planned.trim() : input.region.name?.trim();
      if (!query) return { items: [] as AcquisitionItem[], coverage: [] };
      const fetchOnce = async (url: string, cookie?: string): Promise<Response> => {
        const timeout = AbortSignal.timeout(6000);
        const combined = signal.aborted ? signal : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout);
        try {
          return await runFetch(url, {
            signal: combined,
            redirect: 'manual',
            headers: { 'User-Agent': SO360_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...(cookie ? { Cookie: cookie } : {}) },
          });
        } catch (e) {
          if (signal.aborted) throw e;
          throw new ProviderNetworkError(String(e));
        }
      };
      let res = await fetchOnce(buildSo360SearchUrl(query));
      // 初回302はCookie配布。Cookieを添えて同所へ1回だけ追随する。
      if ((res.status === 301 || res.status === 302) && res.headers.get('location')) {
        const rawCookies = typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
        const cookie = rawCookies.map((c) => c.split(';')[0]?.trim()).filter(Boolean).join('; ');
        const next = new URL(res.headers.get('location') as string, SO360_SEARCH_BASE).toString();
        try {
          await res.arrayBuffer().catch(() => undefined);
        } catch { /* body破棄の失敗は無視 */ }
        res = await fetchOnce(next, cookie || undefined);
      }
      if (!res.ok) throw new ProviderHttpError(res.status, res.headers.get('retry-after') ?? undefined, 'Provider HTTP ' + res.status);
      const html = await res.text();
      const entries = parseSo360Html(html);
      if (!entries.length) throw new ProviderHttpError(502, undefined, 'so360 result list envelope unexpected');
      const at = new Date().toISOString();
      const now = new Date();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        let publisher = 'so360';
        try {
          publisher = new URL(entry.url).hostname.replace(/^www\./, '');
        } catch { /* 既定のまま */ }
        const evidence = normalizeEvidence({ url: entry.url, title: entry.title, excerpt: entry.snippet.slice(0, 2000) || undefined, publisher, language: 'zh', sourceType: 'international_media', primarySource: false, latencyClass: 'near_realtime' }, input.region, now);
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'so360_search', providerItemId: 'so-' + String(index + 1), sourceRecordUrl: entry.url, contentKind: entry.snippet ? 'excerpt' : 'title_only', language: 'zh', blocks: entry.snippet ? [{ index, text: entry.snippet.slice(0, 2000) }] : [], structuredData: { rank: index + 1 }, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: entry.snippet.length > 2000 };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
