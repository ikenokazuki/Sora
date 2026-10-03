// Canonical tool + dependency ledger with live case definitions (Task 8).
// Live cases use real service paths through the public MCP/REST server.
import {
  LiveBlocked, LiveFail, LiveUnavailable, LiveUnverified,
  type CaseContext, type CaseObservation, type HealthCase, type ObservedSource,
} from './types.js';
import { getAllCarrierAdapters } from '../../src/services/tracking/registry.js';
import { SocialPlatformSchema } from '../../src/services/social/types.js';
import { defaultCountryIntelProviderIds } from '../../src/services/country_intel/runtime.js';
import { GLOBAL_FEED_CATALOG } from '../../src/services/country_intel/source_catalog.js';
import { FEDIVERSE_TAG_SOURCES } from '../../src/services/country_intel/providers/fediverse.js';
import { WORLD_BANK_INDICATORS } from '../../src/services/country_intel/providers/worldbank.js';
import { ProviderHttpError, ProviderNetworkError, type AcquisitionItem, type CountryIntelProvider, type ProviderInput } from '../../src/services/country_intel/provider_registry.js';
import { createGdeltExportProvider } from '../../src/services/country_intel/providers/gdelt_files.js';
import { createGdacsProvider } from '../../src/services/country_intel/providers/gdacs.js';
import { createUsgsProvider } from '../../src/services/country_intel/providers/usgs.js';
import { createEonetProvider } from '../../src/services/country_intel/providers/eonet.js';
import { createGlobalFeedsProvider } from '../../src/services/country_intel/providers/feeds.js';
import { createGoogleNewsProvider } from '../../src/services/country_intel/providers/google_news.js';
import { createBingNewsProvider } from '../../src/services/country_intel/providers/bing_news.js';
import { createWikiCurrentProvider } from '../../src/services/country_intel/providers/wiki_current.js';
import { createBaiduHotProvider } from '../../src/services/country_intel/providers/baidu_hot.js';
import { createSo360SearchProvider } from '../../src/services/country_intel/providers/so360_search.js';
import { createWeiboHotProvider } from '../../src/services/country_intel/providers/weibo_hot.js';
import { createZhihuHotProvider } from '../../src/services/country_intel/providers/zhihu_hot.js';
import { createToutiaoHotProvider } from '../../src/services/country_intel/providers/toutiao_hot.js';
import { createWallstreetLiveProvider } from '../../src/services/country_intel/providers/wallstreet_live.js';
import { createCctvNewsProvider } from '../../src/services/country_intel/providers/cctv_news.js';
import { createThepaperHotProvider } from '../../src/services/country_intel/providers/thepaper_hot.js';
import { createBlueskyProvider } from '../../src/services/country_intel/providers/bluesky.js';
import { createFediverseProvider } from '../../src/services/country_intel/providers/fediverse.js';
import { createSocialPostsProvider } from '../../src/services/country_intel/providers/social_posts.js';
import { createWorldBankProvider } from '../../src/services/country_intel/providers/worldbank.js';
import { createNagerProvider } from '../../src/services/country_intel/providers/nager.js';
import { createWikidataProvider } from '../../src/services/country_intel/providers/wikidata.js';

export interface RestRoute { method: string; path: string; }

export const CANONICAL_TOOLS: readonly string[] = [
  'scrape', 'scrape_batch', 'search_deep', 'map_site', 'crawl_site', 'search_web',
  'search_social_posts', 'fetch_social_post', 'browser_action', 'search_image', 'search_video',
  'search_news', 'search_chiebukuro', 'suggest_keywords', 'search_realtime', 'search_trend',
  'fetch_x_post', 'search_route', 'get_weather', 'get_flight_status', 'track_package',
  'search_hotel_availability', 'search_road_traffic', 'search_disaster_warnings', 'search_earthquake',
  'get_elevation', 'search_poi', 'watch_register', 'watch_check', 'watch_list', 'watch_delete',
  'search_song', 'search_artist', 'search_music', 'search_laws', 'get_law_text', 'search_diet_minutes',
  'check_cpsc_certificate', 'check_fda_regulated', 'verify_hts_code', 'predict_hts_code',
  'check_product_compliance', 'inspect_image', 'research_country_context', 'get_country_context',
  'get_country_context_evidence', 'get_country_context_updates', 'search_tools',
];

export const HOTEL_TOOL = 'search_hotel_availability';

export const REST_MAP: Record<string, RestRoute | null> = {
  scrape: { method: 'POST', path: '/scrape' },
  scrape_batch: { method: 'POST', path: '/scrape/batch' },
  search_deep: { method: 'POST', path: '/search/deep' },
  map_site: { method: 'POST', path: '/map' },
  crawl_site: { method: 'POST', path: '/crawl' },
  search_web: { method: 'POST', path: '/search/web' },
  search_social_posts: { method: 'POST', path: '/social/search' },
  fetch_social_post: { method: 'POST', path: '/social/fetch' },
  browser_action: { method: 'POST', path: '/browser/action' },
  search_image: { method: 'POST', path: '/search/image' },
  search_video: { method: 'POST', path: '/search/video' },
  search_news: { method: 'POST', path: '/search/news' },
  search_chiebukuro: { method: 'POST', path: '/search/chiebukuro' },
  suggest_keywords: { method: 'POST', path: '/search/suggest' },
  search_realtime: { method: 'POST', path: '/search/realtime' },
  search_trend: { method: 'POST', path: '/search/trend' },
  fetch_x_post: { method: 'POST', path: '/realtime/post' },
  search_route: { method: 'POST', path: '/transit/route' },
  get_weather: { method: 'POST', path: '/weather' },
  get_flight_status: { method: 'POST', path: '/traffic/flight' },
  track_package: { method: 'POST', path: '/tracking' },
  search_hotel_availability: { method: 'POST', path: '/hotels/availability' },
  search_road_traffic: { method: 'POST', path: '/traffic/road' },
  search_disaster_warnings: { method: 'POST', path: '/disaster/warnings' },
  search_earthquake: { method: 'POST', path: '/disaster/earthquake' },
  get_elevation: { method: 'POST', path: '/geo/elevation' },
  search_poi: { method: 'POST', path: '/geo/poi' },
  watch_register: { method: 'POST', path: '/watch/register' },
  watch_check: { method: 'POST', path: '/watch/check' },
  watch_list: { method: 'GET', path: '/watch/list' },
  watch_delete: { method: 'DELETE', path: '/watch/:id' },
  search_song: { method: 'POST', path: '/search/song' },
  search_artist: { method: 'POST', path: '/search/artist' },
  search_music: { method: 'POST', path: '/search/music' },
  search_laws: { method: 'POST', path: '/gov/laws' },
  get_law_text: { method: 'POST', path: '/gov/law-text' },
  search_diet_minutes: { method: 'POST', path: '/gov/diet-minutes' },
  check_cpsc_certificate: { method: 'POST', path: '/trade/cpsc-check' },
  check_fda_regulated: { method: 'POST', path: '/trade/fda-check' },
  verify_hts_code: { method: 'POST', path: '/trade/hts-verify' },
  predict_hts_code: { method: 'POST', path: '/trade/hts-predict' },
  check_product_compliance: { method: 'POST', path: '/trade/compliance' },
  inspect_image: { method: 'POST', path: '/media/inspect-image' },
  research_country_context: { method: 'POST', path: '/intelligence/country' },
  get_country_context: { method: 'GET', path: '/intelligence/context/:contextId' },
  get_country_context_evidence: { method: 'GET', path: '/intelligence/context/:contextId/evidence' },
  get_country_context_updates: { method: 'GET', path: '/intelligence/context/:contextId/updates' },
  search_tools: null,
};

// ---------- shared live helpers ----------

export function textOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

const LOGIN_MARKERS = [
  'log in to continue', 'login required', 'please sign in', 'captcha', 'challenge-platform',
  'access denied', 'request blocked', 'ログインしてください',
];

export function looksBlocked(text: string): boolean {
  const lower = text.toLowerCase();
  return LOGIN_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

export function mustContain(result: unknown, anchors: string[], source: string): CaseObservation {
  const text = textOf(result);
  const missing = anchors.filter((a) => !text.includes(a));
  if (missing.length > 0 && looksBlocked(text)) {
    throw new LiveBlocked(source + ' returned a login/challenge page; missing: ' + missing.join(', '));
  }
  if (missing.length > 0) {
    throw new LiveFail(source + ' missing expected anchors: ' + missing.join(', '));
  }
  return { sources: [{ source, count: anchors.length, format: 'json', upstreamStatus: 'unknown' }] };
}

export async function ensureEnabled(ctx: CaseContext, query: string, timeoutMs: number): Promise<void> {
  await ctx.mcp.callTool('search_tools', { query }, timeoutMs);
}

export async function mcpJson(ctx: CaseContext, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ raw: unknown; text: string }> {
  let raw: unknown;
  try {
    raw = await ctx.mcp.callTool(tool, args, timeoutMs);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new LiveUnavailable(tool + ' timed out');
    throw new LiveUnavailable(tool + ' transport failed: ' + String((e as Error)?.message ?? e).slice(0, 160));
  }
  const envelope = raw as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  };
  const record = envelope.result ?? envelope;
  if (record?.isError) {
    const msg = (record.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 300);
    if (/rate limited|429|timeout|5\d\d|fetch failed|network/i.test(msg)) throw new LiveUnavailable(tool + ': ' + msg);
    if (/forbidden|401|403|login|challenge/i.test(msg)) throw new LiveBlocked(tool + ': ' + msg);
    throw new LiveFail(tool + ': ' + msg);
  }
  const texts = (record?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '');
  return { raw: record, text: texts.join('\n') };
}

export function parseFirstJson(text: string, tool: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
    throw new LiveFail(tool + ' returned non-JSON text payload');
  }
}

export function toolPayload(text: string, tool: string): unknown {
  return parseFirstJson(text, tool);
}

// ---------- more live helpers ----------

export function mustHaveItems(result: unknown, source: string, field?: string, min = 1): { items: unknown[]; observation: CaseObservation } {
  const record = result as Record<string, unknown>;
  const candidates = ['items', 'results', 'pois', 'flights', 'routes', 'forecasts', 'suggestions', 'posts', 'laws', 'speeches', 'hotels', 'warnings', 'records', 'earthquakes'];
  let items: unknown[] | undefined;
  for (const key of candidates) {
    if (Array.isArray(record?.[key])) { items = record[key] as unknown[]; break; }
  }
  if (!items) throw new LiveFail(source + ' returned no item array');
  if (items.length < min) throw new LiveFail(source + ` returned only ${items.length} items`);
  if (field) {
    const first = items[0] as Record<string, unknown>;
    if (first == null || first[field] === undefined || first[field] === '' || first[field] === null) {
      throw new LiveFail(source + ` first item lacks field: ${field}`);
    }
  }
  return { items, observation: { sources: [{ source, count: items.length, format: 'json', upstreamStatus: 'unknown' }] } };
}

export const DEFAULT_SOCIAL_POSTS: Record<string, { url: string; text: string }> = {
  weibo: { url: 'https://m.weibo.cn/detail/5349719867136347', text: '东京怨气也太大了' },
  threads: { url: 'https://www.threads.com/@vieejt.anh/post/Dd9FZ8eEzB6', text: 'Starbucks' },
  instagram: { url: 'https://www.instagram.com/p/Dd3lVUtk2JO/', text: '東京の日常の風景' },
  facebook: { url: 'https://www.facebook.com/tochokoho/posts/1438401608473199/', text: 'TOKYO UPDATES' },
};

export const DEFAULT_X_POST = { url: 'https://x.com/hm1d6/status/2106048299363164583', statusId: '2106048299363164583', text: 'クロレララーメン' };

/** Secrets override baked-in public defaults. Defaults are live-verified public posts; refresh them when they rot. */
export function secretOrDefault(ctx: CaseContext, caseId: string, fields: string[], defaults: Record<string, string>): Record<string, string> {
  const s = ctx.secrets.getCase(caseId) ?? {};
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = s[f] ?? defaults[f];
    if (!v) throw new LiveUnverified(`case ${caseId} missing field: ${f} (no secret and no default)`);
    out[f] = v;
  }
  return out;
}

export function secretOrUnverified(ctx: CaseContext, caseId: string, fields: string[]): Record<string, string> {
  const s = ctx.secrets.getCase(caseId);
  const missing = fields.filter((f) => !s?.[f]);
  if (missing.length > 0) throw new LiveUnverified(`case ${caseId} missing fields: ${missing.join(', ')} (test data not configured)`);
  return s as Record<string, string>;
}


function toolCase(
  id: string, tools: string[], deps: string[], externalRequired: boolean, timeoutMs: number,
  hotelLaneOnly: boolean, run: (ctx: CaseContext) => Promise<CaseObservation>,
): HealthCase {
  return { id, toolNames: tools, dependencyIds: deps, externalRequired, timeoutMs, hotelLaneOnly, run };
}

function requireHarajuku(lat: number | undefined, lon: number | undefined, label: string): void {
  if (typeof lat !== 'number' || typeof lon !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lon) || lat < 35.66 || lat > 35.68 || lon < 139.70 || lon > 139.72) {
    throw new LiveFail(label + ' coordinates are outside Harajuku, Tokyo');
  }
}

function checkHarajukuPoi(raw: unknown): CaseObservation {
  const result = raw as {
    centerResolved?: { source?: string; lat?: number; lon?: number };
    pois?: Array<{ lat?: number; lng?: number }>;
  };
  mustHaveItems(raw, 'search_poi', 'name');
  const center = result.centerResolved;
  if (center?.source !== 'geocoding.jp') throw new LiveFail('search_poi missing geocoding.jp resolution');
  requireHarajuku(center.lat, center.lon, 'search_poi center');
  for (const poi of result.pois ?? []) {
    if (typeof poi.lat !== 'number' || typeof poi.lng !== 'number' || !Number.isFinite(poi.lat) || !Number.isFinite(poi.lng)) {
      throw new LiveFail('search_poi facility missing finite coordinates');
    }
    const radians = Math.PI / 180;
    const a = Math.sin((poi.lat - center.lat!) * radians / 2) ** 2 +
      Math.cos(center.lat! * radians) * Math.cos(poi.lat * radians) * Math.sin((poi.lng - center.lon!) * radians / 2) ** 2;
    const distance = 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (distance > 1010) throw new LiveFail('search_poi facility is outside the requested 1000m radius');
  }
  return { sources: [
    { source: 'geocoding.jp', format: 'xml', upstreamStatus: 'unknown', cached: false },
    { source: 'openpoi', format: 'json', upstreamStatus: 'unknown', count: result.pois?.length },
  ] };
}


export function checkTrackingNoCreds(raw: unknown, trackingNumber: string, carrier: string): CaseObservation {
  const text = textOf(raw);
  if (!text.includes(trackingNumber)) throw new LiveFail(`track_package (${carrier}) response missing tracking number`);
  let parsed: { status?: string; trackingUrl?: string };
  try {
    parsed = JSON.parse(text) as { status?: string; trackingUrl?: string };
  } catch {
    throw new LiveFail(`track_package (${carrier}) returned non-JSON payload`);
  }
  if (parsed.status !== 'unknown' || typeof parsed.trackingUrl !== 'string' || !parsed.trackingUrl.startsWith('https://')) {
    throw new LiveFail(`track_package (${carrier}) broke the no-credential fail-soft contract`);
  }
  return { detail: 'API-only carrier without credentials: fail-soft contract verified', sources: [{ source: carrier, format: 'json', upstreamStatus: 'unknown' }] };
}

export function checkTrackingResult(raw: unknown, trackingNumber: string, carrier: string): CaseObservation {
  const text = textOf(raw);
  if (!text.includes(trackingNumber)) throw new LiveFail(`track_package (${carrier}) response missing tracking number`);
  let parsed: { status?: string; events?: unknown[]; history?: unknown[] };
  try {
    parsed = JSON.parse(text) as { status?: string; events?: unknown[]; history?: unknown[] };
  } catch {
    throw new LiveFail(`track_package (${carrier}) returned non-JSON payload`);
  }
  if (parsed.status === 'not_found') {
    throw new LiveUnverified(`track_package (${carrier}) not_found: test number has no history (refresh test data)`);
  }
  const events = parsed.events ?? parsed.history ?? [];
  if (parsed.status === 'unknown' || events.length === 0) {
    throw new LiveUnverified(`track_package (${carrier}) has no delivery records (credentials or test data?)`);
  }
  return { sources: [{ source: carrier, count: events.length, format: 'json', upstreamStatus: 'unknown' }] };
}

function trackingCases(): HealthCase[] {
  const carriers = ['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl'];
  return carriers.map((carrier) => toolCase(`track.${carrier}`, ['track_package'], [`tracking:${carrier}`], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, '荷物追跡', 30000);
    const secret = secretOrUnverified(ctx, `tracking.${carrier}.positive`, ['trackingNumber']);
    const { text: rawJsonText } = await mcpJson(ctx, 'track_package', { carrier, trackingNumber: secret.trackingNumber, noCache: true }, 80000);
    const raw = toolPayload(rawJsonText, 'track_package');
    return checkTrackingResult(raw, secret.trackingNumber, carrier);
  }));
}

const NEGATIVE_NUMBERS: Record<string, { number: string; expectNotFound: boolean }> = {
  ups: { number: '1Z9999999999999999', expectNotFound: true },
  fedex: { number: '999999999999', expectNotFound: true },
  dhl: { number: '1234567890', expectNotFound: false },
};

export function checkTrackingNegative(raw: unknown, trackingNumber: string, carrier: string, expectNotFound: boolean): CaseObservation {
  const text = textOf(raw);
  if (!text.includes(trackingNumber)) throw new LiveFail(`track_package (${carrier}) response missing tracking number`);
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(text) as { status?: string };
  } catch {
    throw new LiveFail(`track_package (${carrier}) returned non-JSON payload`);
  }
  if (expectNotFound) {
    if (parsed.status === 'not_found') {
      return { detail: 'bogus number correctly classified', sources: [{ source: carrier, format: 'json', upstreamStatus: 'unknown' }] };
    }
    if (parsed.status === 'unknown' && /bot check|challenge/i.test(textOf(raw))) throw new LiveBlocked(`track_package (${carrier}) hit a carrier bot check`);
    throw new LiveUnverified(`track_package (${carrier}) bogus number was ${parsed.status ?? 'unparsed'} (blocked or page changed)`);
  }
  const known = ['delivered', 'in_transit', 'registered', 'returned', 'not_found'];
  if (parsed.status && known.includes(parsed.status)) {
    return { detail: `bogus number parsed as ${parsed.status}`, sources: [{ source: carrier, format: 'json', upstreamStatus: 'unknown' }] };
  }
  if (parsed.status === 'unknown' && /bot check|challenge/i.test(textOf(raw))) throw new LiveBlocked(`track_package (${carrier}) hit a carrier bot check`);
  throw new LiveUnverified(`track_package (${carrier}) bogus number was ${parsed.status ?? 'unparsed'} (blocked or page changed)`);
}

function trackingNegativeCases(): HealthCase[] {
  return Object.entries(NEGATIVE_NUMBERS).map(([carrier, spec]) =>
    toolCase(`track.${carrier}.negative`, ['track_package'], [`tracking:${carrier}`], true, 120000, false, async (ctx) => {
      await ensureEnabled(ctx, '荷物追跡', 30000);
      const { text: rawJsonText } = await mcpJson(ctx, 'track_package', { carrier, trackingNumber: spec.number, noCache: true }, 100000);
      const raw = toolPayload(rawJsonText, 'track_package');
      return checkTrackingNegative(raw, spec.number, carrier, spec.expectNotFound);
    }));
}
export const TOOL_CASES: HealthCase[] = [
  toolCase('scrape.page', ['scrape'], ['web:example'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'scrape', { url: 'https://example.com/', noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'scrape');
    return mustContain(raw, ['Example Domain'], 'example.com');
  }),
  toolCase('scrape.batch', ['scrape_batch'], ['web:example'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'scrape_batch', { urls: ['https://example.com/', 'https://example.org/'], noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'scrape_batch');
    return mustContain(raw, ['Example Domain'], 'example.com+example.org');
  }),
  toolCase('search.deep', ['search_deep'], ['yahoo:web', 'yahoo:realtime'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_deep', { query: '東京', limit: 2, scrapeContent: false, includeRealtime: true }, 80000);
    const raw = toolPayload(rawJsonText, 'search_deep');
    mustHaveItems(raw, 'search_deep');
    return mustContain(raw, ['東京'], 'yahoo-deep');
  }),
  toolCase('map.site', ['map_site'], ['web:sitemap'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'map_site', { url: 'https://example.com/', limit: 5 }, 60000);
    const raw = toolPayload(rawJsonText, 'map_site');
    return mustContain(raw, ['https://example.com'], 'example.com-map');
  }),
  toolCase('crawl.site', ['crawl_site'], ['web:example'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'crawl_site', { url: 'https://example.com/', maxPages: 2, noCache: true }, 80000);
    const raw = toolPayload(rawJsonText, 'crawl_site');
    return mustContain(raw, ['Example Domain'], 'example.com-crawl');
  }),
  toolCase('search.web', ['search_web'], ['yahoo:web'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_web', { query: '東京', limit: 2, noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'search_web');
    mustHaveItems(raw, 'search_web');
    return mustContain(raw, ['東京'], 'yahoo-web');
  }),
  toolCase('social.search', ['search_social_posts'], ['social:weibo', 'social:threads', 'social:instagram', 'social:facebook'], true, 120000, false, async (ctx) => {
    await ensureEnabled(ctx, 'SNS Weibo', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'search_social_posts', { platform: 'weibo', query: '東京', limit: 2, lookbackHours: 24 }, 100000);
    const raw = toolPayload(rawJsonText, 'search_social_posts');
    mustHaveItems(raw, 'social-search');
    const text = textOf(raw);
    if (!text.includes('東京') && !text.includes('tokyo')) throw new LiveFail('social-search missing query anchor');
    return { sources: [{ source: 'weibo', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  ...(['weibo', 'threads', 'instagram', 'facebook'] as const).map((platform) =>
    toolCase(`social.fetch.${platform}`, ['fetch_social_post'], [`social:${platform}`], true, 120000, false, async (ctx) => {
      await ensureEnabled(ctx, 'SNS', 30000);
      const def = DEFAULT_SOCIAL_POSTS[platform];
      const secret = secretOrDefault(ctx, `social.${platform}.post`, ['url', 'text'], def);
      const { raw } = await mcpJson(ctx, 'fetch_social_post', { url: secret.url, commentLimit: 0 }, 100000);
      mustContain(raw, [platform === 'weibo' ? 'weibo' : platform], `social-fetch-${platform}`);
      const text = textOf(raw);
      if (!text.includes(secret.text)) {
        throw new LiveFail(`social-fetch-${platform} missing expected text anchor (test post may have rotted; refresh DEFAULT_SOCIAL_POSTS)`);
      }
      return { sources: [{ source: platform, format: 'json', upstreamStatus: 'unknown' }] };
    })),
  toolCase('browser.action', ['browser_action'], ['chromium'], true, 90000, false, async (ctx) => {
    // evaluate scripts are disabled by server policy; a real click proves DOM operation.
    const { text: rawJsonText } = await mcpJson(ctx, 'browser_action', {
      url: 'https://example.com/', actions: [{ type: 'click', selector: 'a' }],
    }, 80000);
    const raw = toolPayload(rawJsonText, 'browser_action') as {
      actionOutputs?: Array<{ type?: string; result?: string }>;
      actionLogs?: Array<{ success?: boolean }>;
      renderedWithBrowser?: boolean;
    };
    const clicked = (raw.actionOutputs ?? []).some((o) => o.type === 'click' && o.result === 'ok');
    const logged = (raw.actionLogs ?? []).some((l) => l.success === true);
    if (!clicked || !logged || raw.renderedWithBrowser !== true) {
      throw new LiveFail('browser_action missing click execution evidence');
    }
    return { sources: [{ source: 'chromium', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.image', ['search_image'], ['yahoo:image'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_image', { query: '富士山', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_image') as { items?: Array<Record<string, unknown>> };
    const first = mustHaveItems(raw, 'search_image').items[0] as Record<string, unknown>;
    const imageUrl = [first.original, first.source_url, first.thumbnail].find((v) => typeof v === 'string' && (v as string).startsWith('http'));
    if (!imageUrl) throw new LiveFail('search_image first item lacks image URL (original/source_url/thumbnail)');
    return { sources: [{ source: 'yahoo-image', count: (raw.items ?? []).length, format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.video', ['search_video'], ['yahoo:video'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_video', { query: '料理', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_video');
    mustHaveItems(raw, 'search_video', 'url');
    return { sources: [{ source: 'yahoo-video', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.news', ['search_news'], ['yahoo:news'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_news', { query: '経済', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_news');
    mustHaveItems(raw, 'search_news', 'url');
    return { sources: [{ source: 'yahoo-news', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.chiebukuro', ['search_chiebukuro'], ['yahoo:chiebukuro'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_chiebukuro', { query: '引越し', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_chiebukuro');
    mustHaveItems(raw, 'search_chiebukuro');
    return { sources: [{ source: 'yahoo-chiebukuro', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('suggest.keywords', ['suggest_keywords'], ['yahoo:suggest'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'suggest_keywords', { query: '東京', limit: 3 }, 60000);
    const raw = toolPayload(rawJsonText, 'suggest_keywords');
    mustHaveItems(raw, 'suggest_keywords');
    return { sources: [{ source: 'yahoo-suggest', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.realtime', ['search_realtime'], ['yahoo:realtime'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_realtime', { query: '東京', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_realtime');
    mustHaveItems(raw, 'search_realtime', 'url');
    return { sources: [{ source: 'yahoo-realtime', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.trend', ['search_trend'], ['yahoo:realtime'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_trend', { limit: 3 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_trend');
    mustHaveItems(raw, 'search_trend', 'keyword');
    return { sources: [{ source: 'yahoo-trend', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('fetch.xpost', ['fetch_x_post'], ['fxtwitter'], true, 90000, false, async (ctx) => {
    const secret = secretOrDefault(ctx, 'x.post', ['url'], { url: DEFAULT_X_POST.url });
    const { text: rawJsonText } = await mcpJson(ctx, 'fetch_x_post', { url: secret.url }, 60000);
    const raw = toolPayload(rawJsonText, 'fetch_x_post');
    const text = textOf(raw);
    if (!text.includes('found') && !text.includes(secret.url.split('/').pop() ?? 'status')) {
      throw new LiveFail('fetch_x_post missing post evidence');
    }
    return { sources: [{ source: 'fxtwitter', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('search.route', ['search_route'], ['yahoo:transit'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_route', { from: '東京', to: '新宿' }, 60000);
    const raw = toolPayload(rawJsonText, 'search_route');
    mustHaveItems(raw, 'search_route');
    return mustContain(raw, ['新宿'], 'yahoo-transit');
  }),
  toolCase('get.weather', ['get_weather'], ['jma:forecast'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'get_weather', { city: '東京', days: 1, noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'get_weather');
    mustHaveItems(raw, 'get_weather');
    return mustContain(raw, ['東京'], 'jma');
  }),
  toolCase('flight.status', ['get_flight_status'], ['yahoo:airport'], true, 120000, false, async (ctx) => {
    // Deep night has few domestic departures; fall back to international before giving up.
    const variants: Array<Record<string, unknown>> = [
      { airport: 'HND' },
      { airport: 'HND', category: 'international' },
      { airport: 'NRT', category: 'international' },
    ];
    for (const args of variants) {
      const { text: rawJsonText } = await mcpJson(ctx, 'get_flight_status', args, 60000);
      const parsed = toolPayload(rawJsonText, 'get_flight_status') as { flights?: unknown[] };
      if (Array.isArray(parsed.flights) && parsed.flights.length > 0) {
        return { sources: [{ source: 'yahoo-airport', count: parsed.flights.length, format: 'json', upstreamStatus: 'unknown' }] };
      }
    }
    throw new LiveUnverified('no flights observed in any variant (cannot prove positive retrieval)');
  }),
  ...trackingCases(),
  ...trackingNegativeCases(),
  toolCase('hotel.availability', ['search_hotel_availability'], ['rakuten-travel'], true, 90000, true, async (ctx) => {
    const inDate = new Date(Date.now() + 21 * 86400000);
    const outDate = new Date(Date.now() + 22 * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const secret = ctx.secrets.getCase('hotel.positive') ?? {};
    const { text: rawJsonText } = await mcpJson(ctx, 'search_hotel_availability', {
      location: '東京駅', checkIn: secret.checkIn ?? fmt(inDate), checkOut: secret.checkOut ?? fmt(outDate), adults: 2,
    }, 80000);
    const raw = toolPayload(rawJsonText, 'search_hotel_availability');
    const parsed = parseFirstJson(textOf(raw), 'search_hotel_availability') as { hotels?: Array<{ plans?: Array<{ rooms?: Array<{ amount?: number }> }> }> };
    const rooms = (parsed.hotels ?? []).flatMap((h) => (h.plans ?? []).flatMap((pl) => pl.rooms ?? []));
    if (rooms.length === 0) throw new LiveUnverified('hotel returned zero rooms (cannot prove positive retrieval)');
    if (!rooms.some((r) => typeof r.amount === 'number')) throw new LiveFail('hotel rooms missing price');
    return { sources: [{ source: 'rakuten-travel', count: rooms.length, format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('road.traffic', ['search_road_traffic'], ['yahoo:traffic', 'jartic'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_road_traffic', { road: '東名高速' }, 60000);
    const raw = toolPayload(rawJsonText, 'search_road_traffic');
    return mustContain(raw, ['東名'], 'yahoo-traffic');
  }),
  toolCase('disaster.warnings', ['search_disaster_warnings'], ['jma:warning'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_disaster_warnings', { city: '東京', noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'search_disaster_warnings');
    return mustContain(raw, ['東京'], 'jma-warning');
  }),
  toolCase('quake.latest', ['search_earthquake'], ['p2p-quake'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_earthquake', { limit: 1, noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'search_earthquake');
    mustHaveItems(raw, 'search_earthquake');
    return mustContain(raw, ['20'], 'p2p-quake');
  }),
  toolCase('geo.elevation', ['get_elevation'], ['geocoding.jp', 'gsi'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'get_elevation', { address: '原宿', noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'get_elevation');
    const parsed = parseFirstJson(textOf(raw), 'get_elevation') as unknown as { elevationMeters?: number; lat?: number; lon?: number; geocodingSource?: string };
    if (typeof parsed.elevationMeters !== 'number' || !Number.isFinite(parsed.elevationMeters) || parsed.geocodingSource !== 'geocoding.jp') {
      throw new LiveFail('get_elevation missing numeric elevation/coordinates');
    }
    requireHarajuku(parsed.lat, parsed.lon, 'get_elevation');
    return { sources: [
      { source: 'geocoding.jp', format: 'xml', upstreamStatus: 'unknown', cached: false },
      { source: 'gsi', format: 'json', upstreamStatus: 'unknown', cached: false },
    ] };
  }),
  toolCase('geo.poi', ['search_poi'], ['geocoding.jp', 'openpoi'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_poi', { query: 'ラーメン', center: '原宿', radiusMeters: 1000, limit: 2, noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'search_poi');
    const observation = checkHarajukuPoi(raw);
    const rest = await ctx.rest.call('GET', '/geo/poi?query=' + encodeURIComponent('ラーメン') + '&center=' + encodeURIComponent('原宿') + '&radiusMeters=1000&limit=2&noCache=true', undefined, 60000);
    checkHarajukuPoi(rest.json);
    return observation;
  }),
  toolCase('watch.register', ['watch_register'], ['watch:db'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'Web監視', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'watch_register', { url: 'https://example.com/', title: 'health-probe' }, 80000);
    const raw = toolPayload(rawJsonText, 'watch_register');
    return mustContain(raw, ['example.com'], 'watch-register');
  }),
  toolCase('watch.check', ['watch_check'], ['watch:db'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'Web監視', 30000);
    const reg = await mcpJson(ctx, 'watch_register', { url: 'https://example.com/', title: 'health-probe-check' }, 80000);
    const id = (parseFirstJson(reg.text, 'watch_register') as { target?: { id?: string } }).target?.id;
    if (!id) throw new LiveFail('watch_register returned no target id');
    const { text: rawJsonText } = await mcpJson(ctx, 'watch_check', { id }, 80000);
    const raw = toolPayload(rawJsonText, 'watch_check');
    return mustContain(raw, [id], 'watch-check');
  }),
  toolCase('watch.list', ['watch_list'], ['watch:db'], false, 60000, false, async (ctx) => {
    await ensureEnabled(ctx, 'Web監視', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'watch_list', {}, 30000);
    const raw = toolPayload(rawJsonText, 'watch_list');
    if (Array.isArray(raw)) {
      return { sources: [{ source: 'watch-list', count: raw.length, format: 'json', upstreamStatus: 'unknown' }] };
    }
    return mustContain(raw, ['targets'], 'watch-list');
  }),
  toolCase('watch.delete', ['watch_delete'], ['watch:db'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'Web監視', 30000);
    const reg = await mcpJson(ctx, 'watch_register', { url: 'https://example.com/', title: 'health-probe-del' }, 80000);
    const id = (parseFirstJson(reg.text, 'watch_register') as { target?: { id?: string } }).target?.id;
    if (!id) throw new LiveFail('watch_register returned no target id');
    const { text: rawJsonText } = await mcpJson(ctx, 'watch_delete', { id }, 30000);
    const raw = toolPayload(rawJsonText, 'watch_delete');
    return mustContain(raw, ['success'], 'watch-delete');
  }),
  toolCase('music.song', ['search_song'], ['itunes'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_song', { query: 'アイドル', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_song');
    mustHaveItems(raw, 'search_song', 'title');
    return mustContain(raw, ['itunes'], 'itunes-song');
  }),
  toolCase('music.artist', ['search_artist'], ['itunes'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_artist', { query: 'YOASOBI', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_artist');
    mustHaveItems(raw, 'search_artist');
    return mustContain(raw, ['YOASOBI'], 'itunes-artist');
  }),
  toolCase('music.generic', ['search_music'], ['itunes'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_music', { query: 'アイドル', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_music');
    mustHaveItems(raw, 'search_music');
    return mustContain(raw, ['itunes'], 'itunes-music');
  }),
  toolCase('gov.laws', ['search_laws'], ['egov'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_laws', { keyword: '民法', limit: 2, noCache: true }, 60000);
    const raw = toolPayload(rawJsonText, 'search_laws');
    mustHaveItems(raw, 'search_laws');
    return mustContain(raw, ['民法'], 'egov');
  }),
  toolCase('gov.lawtext', ['get_law_text'], ['egov'], true, 90000, false, async (ctx) => {
    const { text: foundText } = await mcpJson(ctx, 'search_laws', { keyword: '民法', limit: 1, noCache: true }, 60000);
    const list = toolPayload(foundText, 'search_laws') as { laws?: Array<{ lawId?: string; id?: string }>; items?: Array<{ lawId?: string; id?: string }> };
    const lawId = list.laws?.[0] ?? list.items?.[0];
    const id = lawId?.lawId ?? lawId?.id;
    if (!id) throw new LiveFail('search_laws returned no law id');
    const { text: rawJsonText } = await mcpJson(ctx, 'get_law_text', { lawId: id }, 60000);
    const raw = toolPayload(rawJsonText, 'get_law_text');
    const text = textOf(raw);
    if (!text.includes('第一条') && !text.includes('第1条') && !text.includes('articleCount')) {
      throw new LiveFail('get_law_text missing article evidence');
    }
    return { sources: [{ source: 'egov-lawtext', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('gov.diet', ['search_diet_minutes'], ['kokkai'], true, 90000, false, async (ctx) => {
    const { text: rawJsonText } = await mcpJson(ctx, 'search_diet_minutes', { keyword: '予算', limit: 2 }, 60000);
    const raw = toolPayload(rawJsonText, 'search_diet_minutes');
    mustHaveItems(raw, 'search_diet_minutes');
    return { sources: [{ source: 'kokkai', format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('trade.cpsc', ['check_cpsc_certificate'], [], false, 30000, false, async (ctx) => {
    await ensureEnabled(ctx, 'trade', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'check_cpsc_certificate', { htsCode: '9503.00.0073', targetAge: 'child' }, 20000);
    const raw = toolPayload(rawJsonText, 'check_cpsc_certificate');
    return mustContain(raw, ['9503'], 'cpsc-rules');
  }),
  toolCase('trade.fda', ['check_fda_regulated'], [], false, 30000, false, async (ctx) => {
    await ensureEnabled(ctx, 'trade', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'check_fda_regulated', { htsCode: '6912', foodContact: false }, 20000);
    const raw = toolPayload(rawJsonText, 'check_fda_regulated');
    return mustContain(raw, ['6912'], 'fda-rules');
  }),
  toolCase('trade.verify', ['verify_hts_code'], ['usitc'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'trade', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'verify_hts_code', { htsCode: '9503.00.0073', productDescription: 'toy' }, 60000);
    const raw = toolPayload(rawJsonText, 'verify_hts_code');
    return mustContain(raw, ['9503'], 'usitc-verify');
  }),
  toolCase('trade.predict', ['predict_hts_code'], ['usitc'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'trade', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'predict_hts_code', { productName: 'Green Tea' }, 60000);
    const raw = toolPayload(rawJsonText, 'predict_hts_code');
    return mustContain(raw, ['bestMatch'], 'usitc-predict');
  }),
  toolCase('trade.compliance', ['check_product_compliance'], ['usitc'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, 'trade', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'check_product_compliance', { productName: 'toy', htsCode: '9503.00.0073' }, 60000);
    const raw = toolPayload(rawJsonText, 'check_product_compliance');
    return mustContain(raw, ['actionPlan'], 'usitc-compliance');
  }),
  toolCase('media.inspect', ['inspect_image'], ['web:image'], true, 90000, false, async (ctx) => {
    await ensureEnabled(ctx, '画像', 30000);
    const envelope = await ctx.mcp.callTool('inspect_image', { url: 'https://www.w3.org/Icons/valid-xhtml10' }, 60000);
    const record = ((envelope as { result?: { content?: Array<{ type?: string; data?: string; mimeType?: string }> } }).result ?? envelope) as { content?: Array<{ type?: string; data?: string; mimeType?: string }> };
    const img = (record.content ?? []).find((c) => c.type === 'image');
    if (!img?.data || !img.mimeType?.startsWith('image/')) throw new LiveFail('inspect_image returned no image payload');
    return { sources: [{ source: 'image-bytes', format: img.mimeType, upstreamStatus: 'unknown' }] };
  }),
  toolCase('country.lifecycle', ['research_country_context', 'get_country_context', 'get_country_context_evidence', 'get_country_context_updates'], ['intel:runtime', 'intel:db'], true, 120000, false, async (ctx) => {
    await ensureEnabled(ctx, '国地域', 30000);
    const { text: rawJsonText } = await mcpJson(ctx, 'research_country_context', { region: 'Japan', query: 'economy', noCache: true }, 110000);
    const raw = toolPayload(rawJsonText, 'research_country_context');
    const report = parseFirstJson(textOf(raw), 'research_country_context') as { contextId?: string; evidence?: unknown[] };
    if (!report.contextId) throw new LiveFail('research returned no contextId');
    if (!Array.isArray(report.evidence) || report.evidence.length === 0) throw new LiveFail('research returned no evidence');
    const { text: cText } = await mcpJson(ctx, 'get_country_context', { contextId: report.contextId }, 30000);
    mustContain(toolPayload(cText, 'get_country_context'), [report.contextId], 'intel-get');
    const { text: eText } = await mcpJson(ctx, 'get_country_context_evidence', { contextId: report.contextId, limit: 2 }, 30000);
    mustContain(toolPayload(eText, 'get_country_context_evidence'), [report.contextId], 'intel-evidence');
    const { text: uText } = await mcpJson(ctx, 'get_country_context_updates', { contextId: report.contextId }, 30000);
    mustContain(toolPayload(uText, 'get_country_context_updates'), [report.contextId], 'intel-updates');
    return { sources: [{ source: 'intel-runtime', count: (report.evidence as unknown[]).length, format: 'json', upstreamStatus: 'unknown' }] };
  }),
  toolCase('tools.discovery', ['search_tools'], [], false, 30000, false, async (ctx) => {
    // search_tools answers in prose, not JSON.
    const { text } = await mcpJson(ctx, 'search_tools', { query: 'trade' }, 20000);
    if (!text.includes('check_product_compliance')) throw new LiveFail('search_tools did not activate trade tools');
    return { detail: 'activation described in prose', sources: [{ source: 'search_tools', format: 'text', upstreamStatus: 'unknown' }] };
  }),
];

// ---------- provider-level live cases (same-commit code, real upstreams) ----------

export interface DependencySnapshot {
  carriers: string[];
  platforms: string[];
  providers: string[];
  feeds: string[];
  fediverse: string[];
  worldbank: string[];
}

export function snapshotDependencies(): DependencySnapshot {
  return {
    carriers: getAllCarrierAdapters().map((a) => a.code),
    platforms: [...SocialPlatformSchema.options],
    providers: [...defaultCountryIntelProviderIds],
    feeds: GLOBAL_FEED_CATALOG.map((f) => f.id),
    fediverse: FEDIVERSE_TAG_SOURCES.map((s) => s.host),
    worldbank: WORLD_BANK_INDICATORS.map((i) => i.id),
  };
}

export interface ProviderCase {
  id: string;
  dependencyIds: string[];
  timeoutMs: number;
  run(signal: AbortSignal): Promise<CaseObservation>;
}

const REGION_JP = { id: 'country:JP', name: 'Japan', nativeName: '日本', countryCode: 'JP', languages: ['ja'], aliases: [], confidence: 'high' } as const;
const REGION_CN = { id: 'country:CN', name: 'China', nativeName: '中国', countryCode: 'CN', languages: ['zh'], aliases: [], confidence: 'high' } as const;
const REGION_US = { id: 'country:US', name: 'United States', nativeName: 'United States', countryCode: 'US', languages: ['en'], aliases: [], confidence: 'high' } as const;

interface RegionLike { id: string; name: string; nativeName?: string; countryCode?: string; languages: readonly string[]; aliases: readonly string[]; confidence: 'low' | 'medium' | 'high'; }
function providerInput(region: RegionLike, providerId: string, query: string, includeSocial = false, social?: Record<string, unknown>): ProviderInput {
  return {
    request: { region: region.name, query, includeSocial, ...(social ? { social } : {}) },
    region: { ...region },
    queries: [{ pass: 1, providerId, query, topics: [], maxItems: 25 }],
  } as unknown as ProviderInput;
}

export function classifyProviderError(e: unknown, source: string): never {
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    throw new LiveUnavailable(source + ' timed out');
  }
  if (e instanceof ProviderHttpError) {
    if (e.status === 429) throw new LiveUnavailable(source + ' rate limited (429)');
    if (e.status === 403) throw new LiveBlocked(source + ' forbidden (403)');
    if (e.status >= 500) throw new LiveUnavailable(source + ` HTTP ${e.status}`);
    throw new LiveFail(source + ` HTTP ${e.status}: ` + String(e.message).slice(0, 160));
  }
  if (e instanceof ProviderNetworkError || e instanceof TypeError) {
    throw new LiveUnavailable(source + ' network failed: ' + String((e as Error)?.message ?? e).slice(0, 160));
  }
  if (e instanceof LiveFail || e instanceof LiveUnavailable || e instanceof LiveBlocked || e instanceof LiveUnverified) throw e;
  throw new LiveFail(source + ' threw: ' + String((e as Error)?.message ?? e).slice(0, 200));
}

export function checkProviderItems(items: AcquisitionItem[], source: string, regions?: string): CaseObservation {
  if (items.length === 0) throw new LiveUnverified(source + ' returned zero items (needs triage: quiet upstream or broken parse)');
  const withUrl = items.filter((i) => (typeof i.evidence?.url === 'string' && i.evidence.url.startsWith('http')) || i.calendar !== undefined || typeof i.metric?.current === 'number');
  if (withUrl.length === 0) throw new LiveFail(source + ' items carry no evidence URLs');
  return { sources: [{ source, count: withUrl.length, format: 'mixed', upstreamStatus: 'unknown', note: regions }] };
}

async function runProvider(source: string, provider: CountryIntelProvider, input: ProviderInput, timeoutMs: number): Promise<CaseObservation> {
  let result;
  try {
    result = await provider.run(input, AbortSignal.timeout(timeoutMs));
  } catch (e) {
    classifyProviderError(e, source);
  }
  return checkProviderItems(result!.items, source);
}

function providerCase(id: string, deps: string[], timeoutMs: number, run: (signal: AbortSignal) => Promise<CaseObservation>): ProviderCase {
  return { id, dependencyIds: deps, timeoutMs, run };
}
import { createYahooWebSearchAdapter } from '../../src/services/country_intel/runtime.js';
import { seedDomainsForCountry } from '../../src/services/country_intel/official_domains.js';
import { createOfficialWebProvider } from '../../src/services/country_intel/providers/official_web.js';
import { createYahooRealtimeProvider } from '../../src/services/country_intel/providers/yahoo_realtime_jp.js';
import { searchYahooRealtimePage } from '../../src/services/yahoo_realtime_api.js';

export const PROVIDER_CASES: ProviderCase[] = [
  providerCase('provider.gdelt_export', ['gdelt_export'], 120000, async () =>
    runProvider('gdelt_export', createGdeltExportProvider(), providerInput(REGION_US, 'gdelt_export', 'economy'), 110000)),
  providerCase('provider.gdacs', ['gdacs'], 120000, async () =>
    runProvider('gdacs', createGdacsProvider(), providerInput(REGION_JP, 'gdacs', 'earthquake'), 110000)),
  providerCase('provider.usgs', ['usgs'], 120000, async () =>
    runProvider('usgs', createUsgsProvider(), providerInput(REGION_US, 'usgs', 'earthquake'), 110000)),
  providerCase('provider.eonet', ['eonet'], 120000, async () =>
    runProvider('eonet', createEonetProvider(), providerInput(REGION_US, 'eonet', 'wildfire'), 110000)),
  providerCase('provider.google_news', ['google_news'], 120000, async () =>
    runProvider('google_news', createGoogleNewsProvider(), providerInput(REGION_US, 'google_news', 'economy'), 110000)),
  providerCase('provider.bing_news', ['bing_news'], 120000, async () =>
    runProvider('bing_news', createBingNewsProvider(), providerInput(REGION_US, 'bing_news', 'economy'), 110000)),
  providerCase('provider.wiki_current', ['wiki_current'], 120000, async () => {
    // Quiet days yield zero region bullets. pass_empty needs proof the upstream
    // document was parsed by the real path: fetch the same portal wikitext.
    const { currentEventsPageFor, WIKI_CURRENT_API, createWikiCurrentProvider } = await import('../../src/services/country_intel/providers/wiki_current.js');
    const page = currentEventsPageFor(new Date());
    const params = new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json' });
    let wikitext = '';
    try {
      const res = await fetch(WIKI_CURRENT_API + '?' + params.toString(), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new ProviderHttpError(res.status);
      const data = (await res.json()) as { parse?: { wikitext?: { '*': string } } };
      if (typeof data.parse?.wikitext?.['*'] === 'string') wikitext = data.parse.wikitext['*'];
    } catch (e) {
      classifyProviderError(e, 'wiki_current');
    }
    if (!wikitext) throw new LiveUnverified('wiki_current portal page had no wikitext');
    const provider = createWikiCurrentProvider();
    let result;
    try {
      result = await provider.run(providerInput(REGION_US, 'wiki_current', 'news'), AbortSignal.timeout(60000));
    } catch (e) {
      classifyProviderError(e, 'wiki_current');
    }
    if (result!.items.length > 0) return checkProviderItems(result!.items, 'wiki_current');
    const obs: CaseObservation = { detail: `portal ${page} parsed (${wikitext.length} chars), no US bullets today`, sources: [] };
    (obs as { emptyOk?: boolean }).emptyOk = true;
    return obs;
  }),
  providerCase('provider.baidu_hot', ['baidu_hot'], 120000, async () =>
    runProvider('baidu_hot', createBaiduHotProvider(), providerInput(REGION_CN, 'baidu_hot', '热点'), 110000)),
  providerCase('provider.so360_search', ['so360_search'], 120000, async () =>
    runProvider('so360_search', createSo360SearchProvider(), providerInput(REGION_CN, 'so360_search', '经济'), 110000)),
  providerCase('provider.weibo_hot', ['weibo_hot'], 120000, async () =>
    runProvider('weibo_hot', createWeiboHotProvider(), providerInput(REGION_CN, 'weibo_hot', '热搜'), 110000)),
  providerCase('provider.zhihu_hot', ['zhihu_hot'], 120000, async () =>
    runProvider('zhihu_hot', createZhihuHotProvider(), providerInput(REGION_CN, 'zhihu_hot', '热榜'), 110000)),
  providerCase('provider.toutiao_hot', ['toutiao_hot'], 120000, async () =>
    runProvider('toutiao_hot', createToutiaoHotProvider(), providerInput(REGION_CN, 'toutiao_hot', '新闻'), 110000)),
  providerCase('provider.wallstreet_live', ['wallstreet_live'], 120000, async () =>
    runProvider('wallstreet_live', createWallstreetLiveProvider(), providerInput(REGION_CN, 'wallstreet_live', '市场'), 110000)),
  providerCase('provider.cctv_news', ['cctv_news'], 120000, async () =>
    runProvider('cctv_news', createCctvNewsProvider(), providerInput(REGION_CN, 'cctv_news', '新闻'), 110000)),
  providerCase('provider.thepaper_hot', ['thepaper_hot'], 120000, async () =>
    runProvider('thepaper_hot', createThepaperHotProvider(), providerInput(REGION_CN, 'thepaper_hot', '新闻'), 110000)),
  providerCase('provider.official_web', ['official_web'], 120000, async () => {
    const provider = createOfficialWebProvider({
      searchWeb: createYahooWebSearchAdapter(),
      verifiedDomains: seedDomainsForCountry('JP'),
    });
    return runProvider('official_web', provider, providerInput(REGION_JP, 'official_web', '防災'), 110000);
  }),
  providerCase('provider.bluesky', ['bluesky'], 120000, async () =>
    runProvider('bluesky', createBlueskyProvider(), providerInput(REGION_US, 'bluesky', 'news', true), 110000)),
  providerCase('provider.yahoo_realtime', ['yahoo_realtime'], 120000, async () => {
    const provider = createYahooRealtimeProvider({ searchYahooRealtime: async (query, signal) => {
      if (signal.aborted) throw signal.reason;
      const page = await searchYahooRealtimePage({ query, sort: 'recent', limit: 30 }, { timeoutMs: 8000 }).catch((error: unknown) => {
        const match = /^Yahoo realtime HTTP (\d{3})$/.exec(error instanceof Error ? error.message : '');
        if (match) throw new ProviderHttpError(Number(match[1]));
        throw error;
      });
      if (signal.aborted) throw signal.reason;
      return page.items.map((item) => ({
        url: item.url, text: item.text,
        ...(item.created_at ? { postedAt: new Date(item.created_at * 1000).toISOString() } : {}),
        ...(item.author_handle ? { user: item.author_handle } : {}),
      }));
    } });
    return runProvider('yahoo_realtime', provider, providerInput(REGION_JP, 'yahoo_realtime', '東京', true), 110000);
  }),
  providerCase('provider.social_posts', ['social_posts'], 120000, async () =>
    runProvider('social_posts', createSocialPostsProvider(),
      providerInput(REGION_JP, 'social_posts', '東京', true, { platforms: ['weibo'], queries: [{ platform: 'weibo', query: '東京' }], lookbackHours: 24 }), 110000)),
  providerCase('provider.worldbank', ['worldbank'], 120000, async () => {
    const provider = createWorldBankProvider();
    let result;
    try {
      result = await provider.run(providerInput(REGION_US, 'worldbank', 'gdp'), AbortSignal.timeout(110000));
    } catch (e) {
      classifyProviderError(e, 'worldbank');
    }
    const metrics = (result!.items ?? []).filter((i) => typeof i.metric?.current === 'number');
    if (metrics.length === 0) throw new LiveUnverified('worldbank returned no numeric metrics');
    return { sources: [{ source: 'worldbank', count: metrics.length, format: 'json', upstreamStatus: 'unknown' }] };
  }),
  providerCase('provider.nager', ['nager'], 120000, async () =>
    runProvider('nager', createNagerProvider(), providerInput(REGION_JP, 'nager', 'holiday'), 110000)),
  providerCase('provider.wikidata', ['wikidata'], 120000, async () => {
    // Discovery-only by design: verify the live search response and the real
    // parser separately instead of demanding evidence items.
    const { buildWikidataUrl, parseWikidataResponse } = await import('../../src/services/country_intel/providers/wikidata.js');
    let data: unknown;
    try {
      const res = await fetch(buildWikidataUrl('Japan'), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new ProviderHttpError(res.status);
      data = await res.json();
    } catch (e) {
      classifyProviderError(e, 'wikidata');
    }
    const candidates = (data as { search?: unknown[] })?.search;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new LiveUnverified('wikidata search returned no candidates');
    }
    const input = providerInput(REGION_JP, 'wikidata', '日本');
    const parsed = parseWikidataResponse(data as never, input, new Date());
    const nonCandidate = parsed.filter((i) => i.source?.verificationStatus !== 'candidate');
    if (nonCandidate.length > 0) throw new LiveFail('wikidata emitted non-candidate source');
    return { detail: `${candidates.length} live candidates parsed`, sources: [{ source: 'wikidata', count: candidates.length, format: 'json', upstreamStatus: 'unknown' }] };
  }),
  ...GLOBAL_FEED_CATALOG.map((entry) => providerCase(`provider.feed.${entry.id}`, [`feed:${entry.id}`], 90000, async () => {
    const cc = entry.countryCodes?.[0];
    const region = cc
      ? { id: `country:${cc}`, name: cc, nativeName: cc, countryCode: cc, languages: [], aliases: [], confidence: 'low' as const }
      : REGION_US;
    return runProvider(`feed:${entry.id}`, createGlobalFeedsProvider(undefined, [entry]), providerInput(region, 'global_feeds', 'news'), 80000);
  })),
  ...FEDIVERSE_TAG_SOURCES.map((source, index) => providerCase(`provider.fediverse.${index}`, [`fediverse:${source.host}`], 90000, async () =>
    runProvider(`fediverse:${source.host}`, createFediverseProvider(undefined, [source]), providerInput(REGION_JP, 'fediverse', '音楽', true), 80000))),
  ...WORLD_BANK_INDICATORS.map((indicator) => providerCase(`provider.worldbank.${indicator.id}`, [`worldbank:${indicator.id}`], 90000, async () => {
    const provider = createWorldBankProvider(undefined, [indicator]);
    let result;
    try {
      result = await provider.run(providerInput(REGION_US, 'worldbank', 'economy'), AbortSignal.timeout(80000));
    } catch (e) {
      classifyProviderError(e, `worldbank:${indicator.id}`);
    }
    const metrics = (result!.items ?? []).filter((i) => typeof i.metric?.current === 'number');
    if (metrics.length === 0) throw new LiveUnverified(`worldbank:${indicator.id} returned no numeric metric`);
    return { sources: [{ source: `worldbank:${indicator.id}`, count: metrics.length, format: 'json', upstreamStatus: 'unknown' }] };
  })),
];

