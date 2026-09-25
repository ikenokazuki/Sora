import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import type { EvidenceDetail } from '../detail.js';

export interface WebSearchItem { url: string; title?: string; snippet?: string; domain?: string; publishedAt?: string; }
export interface ScrapedArticle { markdown?: string; content?: string; title?: string; }
export interface OfficialWebDeps {
  searchWeb?: (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]>;
  searchYahooWeb?: (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]>;
  scrapeArticle?: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>;
  scrapeUrl?: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>;
  verifiedDomains?: readonly string[];
  maxArticles?: number;
  /** 本文取得の1件あたりの上限ms。既定 4000。残り時間と小さい方を使う。 */
  scrapeBudgetMs?: number;
}
function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return undefined; }
}
function isOfficialHost(host?: string): boolean {
  if (!host) return false;
  return host.endsWith('.go.jp') || host.endsWith('.go.kr') || host.endsWith('.gov') || host.endsWith('.gouv.fr') || host.endsWith('.gov.tw') || host.endsWith('.go.id') || host.includes('mofa.go');
}
export function classifyWebItem(item: WebSearchItem, verifiedDomains: readonly string[] = []): 'official_evidence' | 'official_candidate' | 'media' {
  const host = hostOf(item.url) ?? item.domain?.toLowerCase();
  if (!host) return 'media';
  const verified = new Set(verifiedDomains.map((d) => d.toLowerCase().replace(/^www\./, '')));
  if (verified.has(host)) return 'official_evidence';
  if (isOfficialHost(host)) return 'official_candidate';
  return 'media';
}
export function webItemsToAcquisition(items: WebSearchItem[], input: ProviderInput, verifiedDomains: readonly string[] = [], now = new Date()): AcquisitionItem[] {
  const out: AcquisitionItem[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const kind = classifyWebItem(item, verifiedDomains);
    if (kind === 'official_candidate') {
      out.push({ source: { id: 'web:' + hostOf(item.url), regionId: input.region.id, domain: hostOf(item.url)!, sourceType: 'official', discoveredAt: now.toISOString(), verificationStatus: 'candidate', discoveryMethod: 'search' } });
    } else {
      const evidence = normalizeEvidence({ url: item.url, title: item.title, excerpt: item.snippet, publisher: item.domain ?? hostOf(item.url), sourceType: kind === 'official_evidence' ? 'official' : 'international_media', publishedAt: item.publishedAt, primarySource: kind === 'official_evidence', latencyClass: 'near_realtime' }, input.region, now);
      out.push({ evidence, detail: snippetDetail(evidence.id, item, input, now) });
    }
  }
  return out;
}
function snippetDetail(evidenceId: string, item: WebSearchItem, input: ProviderInput, now: Date): EvidenceDetail {
  void input;
  return {
    evidenceId, providerId: 'official_web', providerItemId: item.url, sourceRecordUrl: item.url,
    contentKind: item.snippet ? 'excerpt' : 'title_only',
    blocks: item.snippet ? [{ index: 0, text: item.snippet }] : [],
    publishedAt: item.publishedAt, retrievedAt: now.toISOString(),
    timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false,
  };
}
export function articleBlocks(markdown: string, maxChars = 12000): { blocks: { index: number; text: string }[]; truncated: boolean } {
  const paragraphs = markdown.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: { index: number; text: string }[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    if (used >= maxChars) return { blocks, truncated: true };
    const slice = paragraph.slice(0, Math.min(2000, maxChars - used));
    blocks.push({ index: blocks.length, text: slice });
    used += slice.length;
    if (slice.length < paragraph.length) return { blocks, truncated: true };
  }
  return { blocks, truncated: false };
}

/** アクセス遮断ページやメタデータだけのページを記事本文として採用しない。 */
export function isUsefulArticleText(markdown: string): boolean {
  const body = markdown.trim().replace(/^---\s*\n[\s\S]*?\n---\s*/u, '').trim();
  if (!body) return false;
  return !/^(?:#{1,6}\s*)?(?:why have i been blocked\?|access denied|attention required!?|403 forbidden|verify you are human|just a moment\b)/iu.test(body);
}
export function createOfficialWebProvider(deps: OfficialWebDeps): CountryIntelProvider {
  const searchWeb = deps.searchWeb ?? deps.searchYahooWeb ?? (async () => []);
  const scrape = deps.scrapeArticle ?? deps.scrapeUrl;
  const maxArticles = deps.maxArticles ?? 5;
  return {
    id: 'official_web', areas: ['official', 'media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 3600,
    async run(input: ProviderInput, signal: AbortSignal) {
      const queries = input.queries.filter((q) => q.providerId === 'official_web').slice(0, 12);
      const all: AcquisitionItem[] = [];
      try {
        for (const q of queries.length ? queries : [{ pass: 1 as const, providerId: 'official_web', query: input.region.name, topics: [], maxItems: 10 }]) {
          const items = await searchWeb(q.query, Math.min(q.maxItems, 20), signal);
          all.push(...webItemsToAcquisition(items, input, deps.verifiedDomains, new Date()));
          if (signal.aborted) throw signal.reason;
        }
      } catch (e) {
        if (e instanceof ProviderHttpError || e instanceof ProviderNetworkError) throw e;
        if (signal.aborted) throw e;
        throw new ProviderNetworkError(String(e));
      }
      if (scrape) await upgradeWithArticles(all, scrape, maxArticles, signal, deps.scrapeBudgetMs ?? 4000);
      return { items: all, coverage: ['official'] };
    },
  };
}
async function upgradeWithArticles(items: AcquisitionItem[], scrape: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>, maxArticles: number, parent: AbortSignal, budgetMs: number): Promise<void> {
  const targets = items.filter((item) => item.evidence && item.detail).slice(0, Math.max(0, maxArticles));
  let cursor = 0;
  const workers = [0, 1].map(async () => {
    while (cursor < targets.length) {
      if (parent.aborted) return;
      const item = targets[cursor];
      cursor += 1;
      const url = item.evidence!.url;
      try {
        const timeout = AbortSignal.timeout(Math.max(500, budgetMs));
        const signal = parent.aborted ? parent : AbortSignal.any([parent, timeout]);
        const scraped = await scrape(url, signal);
        const markdown = scraped.markdown ?? scraped.content;
        if (!markdown || !isUsefulArticleText(markdown) || parent.aborted) continue;
        const split = articleBlocks(markdown);
        if (split.blocks.length === 0) continue;
        item.detail = { ...item.detail!, contentKind: 'extracted_text', blocks: split.blocks, contentTruncated: split.truncated };
        if (scraped.title && !item.evidence!.title) item.evidence!.title = scraped.title;
      } catch { /* per-URL scrape failure keeps the snippet detail */ }
    }
  });
  await Promise.all(workers);
}
