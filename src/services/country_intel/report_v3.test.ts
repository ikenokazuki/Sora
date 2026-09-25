import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { getCountryContext } from './db.js';
import { normalizeEvidence } from './evidence.js';
import { ProviderLocalError, type CountryIntelProvider } from './provider_registry.js';
import { enrichDetailsWithArticles, researchCountryContext } from './report.js';
import { parseGdeltExport, unzipGdeltExport } from './providers/gdelt_files.js';
import { createGdacsProvider } from './providers/gdacs.js';
import type { RegionIdentity } from './types.js';

let directory: string;
let previousPath: string | undefined;
const now = () => new Date('2026-09-22T00:00:00Z');
const china: RegionIdentity = { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' };

test('article enrichment skips Google News wrapper pages and spends its budget on direct articles', async () => {
  const detail = (id: string, url: string) => ({
    evidenceId: id, providerId: id, providerItemId: id, sourceRecordUrl: url,
    contentKind: 'title_only' as const, blocks: [], retrievedAt: now().toISOString(),
    timeBasis: 'provider_publication', geographyBasis: 'unknown',
    sourceStatus: 'unverified' as const, contentTruncated: false,
  });
  const calls: string[] = [];
  const google = 'https://news.google.com/rss/articles/abc';
  const direct = 'https://example.org/article';
  const result = await enrichDetailsWithArticles(
    [detail('google', google), detail('direct', direct)],
    new Map([['google', 'related' as const], ['direct', 'related' as const]]),
    async (url) => { calls.push(url); return { content: 'Article body from publisher' }; },
    { maxItems: 1 }, () => 10_000,
  );
  expect(calls).toEqual([direct]);
  expect(result.details.find((item) => item.evidenceId === 'direct')?.contentKind).toBe('extracted_text');
  expect(result.details.find((item) => item.evidenceId === 'google')?.contentKind).toBe('title_only');
});

test('article enrichment leaves an access-block page as title-only evidence', async () => {
  const url = 'https://publisher.example/story';
  const detail = {
    evidenceId: 'blocked', providerId: 'official_web', providerItemId: 'blocked', sourceRecordUrl: url,
    contentKind: 'title_only' as const, blocks: [], retrievedAt: now().toISOString(),
    timeBasis: 'provider_publication', geographyBasis: 'unknown',
    sourceStatus: 'unverified' as const, contentTruncated: false,
  };
  const result = await enrichDetailsWithArticles(
    [detail], new Map([['blocked', 'related' as const]]),
    async () => ({ content: '## Why have I been blocked? This website is using a security service to protect itself from online attacks.' }),
    {}, () => 10_000,
  );
  expect(result.details[0].contentKind).toBe('title_only');
  expect(result.outcome.failed).toBe(1);
});

test('report exposes a provider subject gap even when other subjects succeeded', async () => {
  const provider: CountryIntelProvider = {
    id: 'subjects', areas: ['economy', 'health'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run() { return { items: [], coverage: ['economy'], gaps: [{ area: 'health', reason: 'no_recent_items' }] }; },
  };
  const report = await researchCountryContext({ region: 'China' }, { providers: [provider], now, cache: null });
  expect(report.limitations?.some((item) => item.code === 'provider_coverage_gap' && item.area === 'health')).toBe(true);
  expect(report.providerCoverage[0].gaps).toEqual([{ area: 'health', reason: 'no_recent_items' }]);
});

test('region-inapplicable providers are by-design skips, not failures', async () => {
  const cnOnly: CountryIntelProvider = {
    id: 'cn_only', areas: ['media_activity'], regions: ['CN'],
    latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run() { return { items: [] }; },
  };
  const report = await researchCountryContext({ region: 'Japan' }, { providers: [cnOnly], now, cache: null });
  const skip = report.limitations?.find((item) => item.providerId === 'cn_only');
  expect(skip?.code).toBe('provider_region_unsupported');
  expect(report.limitations?.some((item) => item.providerId === 'cn_only' && item.code === 'provider_unavailable')).toBe(false);
  expect(report.providerCoverage.some((run) => run.provider === 'cn_only')).toBe(true);
});

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-v3-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

interface RecordSpec {
  title: string;
  excerpt?: string;
  eventCountry?: string;
  mentionedCountries?: string[];
  sourceType?: 'structured_dataset' | 'international_media';
  publishedAt: string;
  providerItemId: string;
  detailFrom?: string;
  detailTo?: string;
  withDetail?: boolean;
}

function recordProvider(id: string, records: RecordSpec[]): CountryIntelProvider {
  return {
    id, areas: ['disasters', 'media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run(input) {
      return {
        items: records.map((record, index) => {
          const evidence = normalizeEvidence({
            url: 'https://example.org/' + id + '/' + String(index),
            title: record.title,
            excerpt: record.excerpt ?? record.title,
            publisher: 'Example',
            ...(record.eventCountry ? { eventCountry: record.eventCountry } : {}),
            ...(record.mentionedCountries ? { mentionedCountries: record.mentionedCountries } : {}),
            sourceType: record.sourceType ?? 'international_media',
            publishedAt: record.publishedAt,
            primarySource: false,
            latencyClass: 'near_realtime',
          }, input.region, now());
          if (record.withDetail === false) {
            return {
              evidence,
              detail: {
                evidenceId: evidence.id, providerId: id, providerItemId: record.providerItemId,
                sourceRecordUrl: 'https://example.org/' + id + '/' + String(index),
                contentKind: 'excerpt' as const,
                blocks: [{ index, text: record.title }],
                publishedAt: record.publishedAt,
                retrievedAt: now().toISOString(),
                timeBasis: 'provider_publication', geographyBasis: 'unknown',
                sourceStatus: 'unverified' as const, contentTruncated: false,
              },
            };
          }
          return {
            evidence,
            detail: {
              evidenceId: evidence.id, providerId: id, providerItemId: record.providerItemId,
              sourceRecordUrl: 'https://example.org/' + id + '/' + String(index),
              contentKind: 'structured_record' as const,
              blocks: [{ index, text: record.title }],
              structuredData: { title: record.title },
              occurredAt: record.detailFrom ?? record.publishedAt,
              publishedAt: record.publishedAt,
              ...(record.detailTo ? { updatedAt: record.detailTo } : {}),
              retrievedAt: now().toISOString(),
              timeBasis: 'provider_observation', geographyBasis: 'provider_place',
              sourceStatus: 'unverified' as const, contentTruncated: false,
            },
          };
        }),
        coverage: ['disasters'],
      };
    },
  };
}

describe('v3 region links', () => {
  test('keyEvents, factors and metrics share one relevance verdict', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [recordProvider('mixed', [
        { title: 'M5.2 earthquake - 120 km SE of Nanjing, China', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'EQ:100:1' },
        { title: 'M0.84 - 10 km ENE of Ridgecrest, CA', eventCountry: 'US', sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'EQ:200:1' },
        { title: 'M1.1 - 5 km S of Pahala, Hawaii', sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'EQ:300:1' },
        { title: 'US announces new export restrictions', eventCountry: 'US', mentionedCountries: ['US', 'CN'], publishedAt: '2026-09-20T00:00:00Z', providerItemId: 'news:1', withDetail: false },
        { title: 'Beijing announces new trade fair', publishedAt: '2026-09-19T00:00:00Z', providerItemId: 'news:2', withDetail: false },
      ])],
      now, cache: null,
    });
    expect(report.schemaVersion).toBe('3');
    const titles = report.keyEvents.map((event) => event.title);
    expect(titles).toContain('M5.2 earthquake - 120 km SE of Nanjing, China');
    expect(titles).toContain('US announces new export restrictions');
    expect(titles.join('\n')).not.toContain('Ridgecrest');
    expect(titles.join('\n')).not.toContain('Pahala');
    expect(titles.join('\n')).not.toContain('Beijing');
    const byUrl = new Map(report.evidence.map((item) => [item.url, item]));
    expect(byUrl.get('https://example.org/mixed/1')?.regionLink).toBe('unrelated');
    expect(byUrl.get('https://example.org/mixed/3')?.regionLink).toBe('related');
    expect(byUrl.get('https://example.org/mixed/4')?.regionLink).toBe('candidate');
    expect(report.evidence.every((item) => item.acquisition?.providerId === 'mixed')).toBe(true);
    const general = report.domainContext?.general;
    expect(general?.factors.map((fact) => fact.text).join('\n')).not.toContain('Beijing');
    expect(general?.candidateFactors?.map((fact) => fact.text).join('\n')).toContain('Beijing');
    // 無属性・無関係分は候補欄に入れず、証拠一覧に残す。
    const candidateTexts = (general?.candidateFactors ?? []).map((fact) => fact.text).join('\n');
    expect(candidateTexts).not.toContain('Pahala');
    expect(candidateTexts).not.toContain('Ridgecrest');
    expect(report.evidence.map((item) => item.title).join('\n')).toContain('Pahala');
    const metrics = new Map(report.temporalMetrics.map((metric) => [metric.key, metric.current]));
    const signals = new Map(report.signals.map((signal) => [signal.key, signal]));
    expect(signals.get('disaster_event_count')?.value).toBe(report.keyEvents.filter((event) => event.type === 'disaster_response').length);
    expect(signals.get('media_article_count')?.value).toBe(1);
    const evidenceIds = new Set(report.evidence.map((item) => item.id));
    for (const event of report.keyEvents) {
      for (const id of event.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    }
    for (const fact of general?.factors ?? []) {
      for (const id of fact.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    }
  });

  test('unrelated-only input yields empty factors with missing reasons', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [recordProvider('foreign', [
        { title: 'M0.84 - 10 km ENE of Ridgecrest, CA', eventCountry: 'US', sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'EQ:9:1' },
      ])],
      now, cache: null,
    });
    expect(report.keyEvents).toEqual([]);
    expect(report.domainContext?.content?.factors).toEqual([]);
    expect(report.domainContext?.content?.missingInformation.some((info) => info.code === 'factors_missing')).toBe(true);
    expect(report.domainContext?.general?.factors).toEqual([]);
  });
});

describe('v3 event identity and windows', () => {
  test('same-title quakes months apart stay separate; same stable id merges', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [recordProvider('quakes', [
        { title: 'Earthquake in China', excerpt: 'Earthquake magnitude 5.0 depth 10km, September 1', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-09-01T00:00:00Z', providerItemId: 'EQ:1:1' },
        { title: 'Earthquake in China', excerpt: 'Earthquake magnitude 4.2 depth 8km, September 10', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-09-10T00:00:00Z', providerItemId: 'EQ:2:1' },
        { title: 'Earthquake in China', excerpt: 'Earthquake magnitude 4.2 depth 8km, September 10 update', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-09-10T01:00:00Z', providerItemId: 'EQ:2:1' },
      ])],
      now, cache: null,
    });
    expect(report.keyEvents).toHaveLength(2);
    expect(report.keyEvents.map((event) => event.occurredAt).sort()).toEqual([
      '2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z',
    ]);
  });

  test('ended disasters drop out, continuing ones stay', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [recordProvider('gdacs-like', [
        { title: 'Flood in Northern China', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-07-01T00:00:00Z', providerItemId: 'FL:1:1', detailFrom: '2026-07-01T00:00:00Z', detailTo: '2026-07-05T00:00:00Z' },
        { title: 'Typhoon Lingling approaches Shanghai', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-07-31T00:00:00Z', providerItemId: 'TC:2:1', detailFrom: '2026-07-31T00:00:00Z', detailTo: '2026-09-21T00:00:00Z' },
      ])],
      now, cache: null,
    });
    const titles = report.keyEvents.map((event) => event.title);
    expect(titles).not.toContain('Flood in Northern China');
    expect(titles).toContain('Typhoon Lingling approaches Shanghai');
  });
});

describe('v3 one-shot details', () => {
  const directProse = (): CountryIntelProvider => recordProvider('prose', [
    { title: 'Shanghai issues flood alert', eventCountry: 'CN', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'news:alert', withDetail: false },
  ]);

  test('injected scraper puts article bodies in the first response', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [directProse()],
      scrapeArticle: async () => ({ markdown: 'Shanghai flood alert.\n\nAffected districts: Pudong, Minhang. Issued at 08:00.' }),
      now, cache: null,
    });
    expect(report.enrichment?.upgraded).toBe(1);
    const details = report.evidenceDetails ?? [];
    expect(details.some((detail) => detail.contentKind === 'extracted_text' && detail.blocks.some((block) => block.text.includes('Pudong')))).toBe(true);
    expect(report.domainContext?.general?.factors.map((fact) => fact.text).join('\n')).toContain('Pudong');
    expect(report.limitations?.some((info) => info.code === 'article_enrichment_unavailable')).toBe(false);
  });

  test('missing scraper is reported, other evidence is kept', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [directProse()],
      scrapeArticle: async () => { throw new Error('blocked'); },
      now, cache: null,
    });
    expect(report.enrichment?.failed).toBe(1);
    expect(report.enrichment?.upgraded).toBe(0);
    expect(report.keyEvents.length).toBeGreaterThan(0);
  });

  test('unconfigured enrichment is explicit', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [directProse()],
      now, cache: null,
    });
    expect(report.enrichment?.unavailable).toBe(true);
    expect(report.limitations?.some((info) => info.code === 'article_enrichment_unavailable')).toBe(true);
    expect(report.keyEvents.length).toBeGreaterThan(0);
  });

  test('partial report returns under a tight deadline', async () => {
    const slow: CountryIntelProvider = {
      id: 'slow', areas: ['media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
      async run(_input, signal) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { items: [], coverage: ['media_activity'] };
      },
    };
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [directProse(), slow],
      now, cache: null, timeoutMs: 80, deadlineMs: 400,
    });
    expect(report.keyEvents.length).toBeGreaterThan(0);
    expect(['partial', 'pending']).toContain(report.refreshState?.state);
    expect(report.providerCoverage.some((run) => run.provider === 'slow' && run.status !== 'success')).toBe(true);
  });
});

describe('v3 providers', () => {
  test('gdelt export unzips with bundled yauzl, no external unzip', async () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'live-contracts', 'gdelt-export-sample.zip')));
    const tsv = await unzipGdeltExport(bytes);
    expect(tsv).toContain('Nanjing');
    const { filterGdeltRowsForRegion } = await import('./providers/gdelt_files.js');
    expect(filterGdeltRowsForRegion(parseGdeltExport(tsv), china)).toHaveLength(1);
  });

  test('oversized and entry-less zips map to local error codes', async () => {
    const localCode = async (input: Uint8Array): Promise<string> => {
      try {
        await unzipGdeltExport(input);
      } catch (error) {
        if (error instanceof ProviderLocalError) return error.code;
        throw error;
      }
      throw new Error('expected unzip to fail');
    };
    expect(await localCode(new Uint8Array(6 * 1024 * 1024))).toBe('SIZE_LIMIT');
    expect(await localCode(new Uint8Array([1, 2, 3, 4]))).toBe('DECOMPRESS_FAILED');
    expect(await localCode(buildStoredZip('readme.txt', 'no csv here'))).toBe('DECOMPRESS_FAILED');
  });

  test('gdacs falls back to RSS when the API fails', async () => {
    const rss = readFileSync(join(import.meta.dir, 'fixtures', 'live-contracts', 'gdacs-rss-sample.xml'), 'utf8');
    const fetchFn = (async (url: string) => {
      if (url.includes('geteventlist')) return new Response('boom', { status: 500 });
      if (url.includes('rss.xml')) return new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      return new Response('not found', { status: 404 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const provider = createGdacsProvider(fetchFn);
    const input = { request: { region: 'China' } as never, region: china, queries: [] };
    const result = await provider.run(input, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.title).toContain('Flood in China');
    expect(result.status).toBe('partial');
    expect(result.errorCode).toBe('GDACS_API_FALLBACK_RSS');
  });

  test('gdacs reports failure when API and RSS both fail', async () => {
    const fetchFn = (async () => new Response('down', { status: 503 })) as (url: string, init?: RequestInit) => Promise<Response>;
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [createGdacsProvider(fetchFn)],
      now, cache: null,
    });
    expect(report.providerCoverage[0].status).toBe('unavailable');
    expect(report.limitations?.some((info) => info.providerId === 'gdacs')).toBe(true);
  });
});

describe('v3 coverage and contract', () => {
  test('disaster alias, non-article evidence and short windows are honest', async () => {
    const metricOnly: CountryIntelProvider = {
      id: 'wb-like', areas: ['economy'], latencyClass: 'historical', defaultTtlSeconds: 3600,
      collectionWindowDays: 3650,
      async run() {
        return {
          items: [{
            metric: { key: 'worldbank:NY.GDP.MKTP.CD', current: 1, window: 'yearly', direction: 'unknown' as const },
            detail: {
              evidenceId: 'wb:CN:NY.GDP.MKTP.CD', providerId: 'wb-like', providerItemId: 'NY.GDP.MKTP.CD',
              sourceRecordUrl: 'https://example.org/wb', contentKind: 'structured_record' as const,
              blocks: [{ index: 0, text: 'GDP nominal 1 USD (2024)' }],
              retrievedAt: now().toISOString(), timeBasis: 't', geographyBasis: 'g',
              sourceStatus: 'unverified' as const, contentTruncated: false,
            },
          }],
          coverage: ['economy'],
        };
      },
    };
    const shortFeed: CountryIntelProvider = {
      id: 'feed-like', areas: ['disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
      collectionWindowDays: 1,
      async run(input) {
        const evidence = normalizeEvidence({
          url: 'https://example.org/feed-like/0', title: 'M4.0 earthquake near Beijing, China',
          excerpt: 'earthquake magnitude 4.0 near Beijing', publisher: 'Feed', eventCountry: 'CN',
          sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z',
          primarySource: false, latencyClass: 'near_realtime',
        }, input.region, now());
        return { items: [{ evidence }], coverage: ['disasters'] };
      },
    };
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [metricOnly, shortFeed],
      now, cache: null,
    });
    expect(report.coverage.byArea.disaster).toBe('good');
    expect(report.coverage.byArea.economy).toBe('good');
    expect(report.actualWindows?.[0]?.gaps.some((gap) => gap.reason.includes('feed-like:partial_window'))).toBe(true);
    expect(report.limitations?.some((info) => info.code === 'social_not_requested')).toBe(true);
  });

  test('yahoo_realtime success carries a Japanese-only language scope', async () => {
    const { createYahooRealtimeProvider } = await import('./providers/yahoo_realtime_jp.js');
    const stub = () => createYahooRealtimeProvider({
      searchYahooRealtime: async () => [{ url: 'https://example.org/post/1', text: '台風の投稿', postedAt: '2026-09-22T00:00:00Z', user: 'tester' }],
    });
    const social = await researchCountryContext({ region: 'Japan', includeSocial: true }, {
      providers: [stub()],
      now, cache: null,
    });
    const scope = social.limitations?.find((info) => info.code === 'language_scope_ja');
    expect(scope?.providerId).toBe('yahoo_realtime');
    expect(scope?.area).toBe('social');
    const silent = await researchCountryContext({ region: 'Japan' }, {
      providers: [stub()],
      now, cache: null,
    });
    expect(silent.limitations?.some((info) => info.code === 'language_scope_ja')).toBe(false);
    expect(silent.limitations?.some((info) => info.code === 'social_not_requested')).toBe(true);
  });

  test('v3 round-trips through storage and v2 shapes still read back', async () => {
    const report = await researchCountryContext({ region: 'China' }, {
      providers: [recordProvider('persist', [
        { title: 'M4.0 earthquake near Beijing, China', eventCountry: 'CN', sourceType: 'structured_dataset', publishedAt: '2026-09-21T00:00:00Z', providerItemId: 'EQ:7:1' },
      ])],
      now, cache: null,
    });
    expect(getCountryContext(report.contextId)).toEqual(report);
    const legacy = JSON.parse(JSON.stringify(report));
    delete legacy.evidenceDetails;
    delete legacy.enrichment;
    legacy.schemaVersion = '2';
    const { saveCountryContext } = await import('./db.js');
    saveCountryContext(legacy, { evidence: legacy.evidence, events: legacy.keyEvents });
    expect(getCountryContext(legacy.contextId)?.schemaVersion).toBe('2');
  });
});

function crc32Bytes(data: Uint8Array): number {
  let table = (crc32Bytes as { table?: Uint32Array }).table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32Bytes as { table?: Uint32Array }).table = table;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 最小の無圧縮 zip を手作りする（外部依存なし）。対象外エントリのみ。 */
function buildStoredZip(name: string, text: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const dataBytes = new TextEncoder().encode(text);
  const crc = crc32Bytes(dataBytes);
  const header = new DataView(new ArrayBuffer(30));
  header.setUint32(0, 0x04034b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(8, 0, true);
  header.setUint32(14, crc, true);
  header.setUint32(18, dataBytes.length, true);
  header.setUint32(22, dataBytes.length, true);
  header.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, dataBytes.length, true);
  central.setUint32(24, dataBytes.length, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint32(42, 0, true);
  const localSize = 30 + nameBytes.length + dataBytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, localSize, true);
  const out = new Uint8Array(localSize + 46 + nameBytes.length + 22);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(nameBytes, 30);
  out.set(dataBytes, 30 + nameBytes.length);
  out.set(new Uint8Array(central.buffer), localSize);
  out.set(nameBytes, localSize + 46);
  out.set(new Uint8Array(end.buffer), localSize + 46 + nameBytes.length);
  return out;
}

describe("v3 gdelt bodies", () => {
  test("export rows without headlines gain bodies through enrichment", async () => {
    const { createGdeltExportProvider } = await import("./providers/gdelt_files.js");
    const zipBytes = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "live-contracts", "gdelt-export-sample.zip")));
    const fetchFn = (async (url: string) => {
      if (url.endsWith("lastupdate.txt")) {
        return new Response("1 a http://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(zipBytes, { status: 200, headers: { "content-type": "application/zip" } });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const report = await researchCountryContext({ region: "China" }, {
      providers: [createGdeltExportProvider({ fetchFn })],
      scrapeArticle: async (url: string) => ({ content: "Full story about Nanjing trade talks.\n\nDelegates met on September 20.", title: "Nanjing trade talks" }),
      now, cache: null,
    });
    expect(report.enrichment?.upgraded).toBeGreaterThan(0);
    // 見出しなし行はイベント化しないが、地域直結の本文として残る。
    expect(report.evidence[0]?.regionLink).toBe('direct');
    const bodies = (report.evidenceDetails ?? []).filter((d) => d.contentKind === "extracted_text");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0].resolvedTitle).toBe('Nanjing trade talks');
    expect(bodies[0].blocks.map((b) => b.text).join("\n")).toContain("Nanjing");
    expect(report.domainContext?.general?.factors.map((f) => f.text).join("\n")).toContain("Nanjing trade talks");
  });
});

describe("v3 doc rescue", () => {
  test("gdelt doc falls back to 7d once and reports it", async () => {
    const { createGdeltProvider } = await import("./providers/gdelt.js");
    expect(createGdeltProvider().timeoutMs).toBe(16000);
    let calls = 0;
    const article = { url: "https://example.org/doc/1", title: "China trade talks advance", seendate: "20260920T120000Z", domain: "example.org", language: "en" };
    const fetchFn = (async (url: string) => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return Response.json({ articles: [article] });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const input = { request: { region: "China", period: "30d" } as never, region: { id: "country:CN", name: "China", countryCode: "CN", languages: [], aliases: [], confidence: "high" as const }, queries: [] };
    const result = await createGdeltProvider(fetchFn).run(input, AbortSignal.timeout(5000));
    expect(calls).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("GDELT_DOC_FALLBACK_7D");
  });

  test("gdelt doc keeps the original error when the fallback also fails", async () => {
    const { createGdeltProvider } = await import("./providers/gdelt.js");
    const { ProviderNetworkError } = await import("./provider_registry.js");
    const fetchFn = (async () => { throw new Error("down"); }) as (url: string, init?: RequestInit) => Promise<Response>;
    const input = { request: { region: "China", period: "30d" } as never, region: { id: "country:CN", name: "China", countryCode: "CN", languages: [], aliases: [], confidence: "high" as const }, queries: [] };
    await expect(createGdeltProvider(fetchFn).run(input, AbortSignal.timeout(5000))).rejects.toThrow(ProviderNetworkError);
  });
});

describe("v3 enrich ranking", () => {
  test("high-article-count direct rows win the budget", async () => {
    const { enrichDetailsWithArticles } = await import("./report.js");
    const detail = (id: string, articles: number) => ({
      evidenceId: id, providerId: "gdelt_export", providerItemId: id, sourceRecordUrl: "https://example.org/" + id,
      contentKind: "title_only" as const, blocks: [], structuredData: { numArticles: articles },
      publishedAt: "2026-09-21T00:00:00Z", retrievedAt: "2026-09-22T00:00:00Z",
      timeBasis: "t", geographyBasis: "g", sourceStatus: "unverified" as const, contentTruncated: false,
    });
    const seen: string[] = [];
    const { details, outcome } = await enrichDetailsWithArticles(
      [detail("low", 1), detail("high", 10)],
      new Map([["low", "direct" as const], ["high", "direct" as const]]),
      async (url: string) => { seen.push(url); return { content: "body" }; },
      { maxItems: 1 },
      () => 30000,
    );
    expect(seen).toEqual(["https://example.org/high"]);
    expect(outcome.upgraded).toBe(1);
    expect(details.find((d) => d.evidenceId === "high")?.contentKind).toBe("extracted_text");
  });
});

describe("v3 provider time budgets", () => {
  test("gdelt doc cuts a hanging first attempt and falls back", async () => {
    const { createGdeltProvider } = await import("./providers/gdelt.js");
    const article = { url: "https://example.org/doc/9", title: "Hang then fallback", seendate: "20260920T120000Z", domain: "example.org" };
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      // 初回はハングし、中断だけ受け付ける。2回目は即応答。
      if (!fetchFnCalled.done) {
        fetchFnCalled.done = true;
        await new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }
      return Response.json({ articles: [article] });
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    const fetchFnCalled = { done: false };
    const input = { request: { region: "China", period: "30d" } as never, region: { id: "country:CN", name: "China", countryCode: "CN", languages: [], aliases: [], confidence: "high" as const }, queries: [] };
    const t = Date.now();
    const result = await createGdeltProvider(fetchFn, { firstAttemptMs: 200 }).run(input, AbortSignal.timeout(5000));
    expect(Date.now() - t).toBeLessThan(4000);
    expect(result.items).toHaveLength(1);
    expect(result.errorCode).toBe("GDELT_DOC_FALLBACK_7D");
  });

  test("gdacs api hang falls back to rss within budget", async () => {
    const { createGdacsProvider } = await import("./providers/gdacs.js");
    const rss = readFileSync(join(import.meta.dir, "fixtures", "live-contracts", "gdacs-rss-sample.xml"), "utf8");
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.includes("rss.xml")) return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const input = { request: { region: "China" } as never, region: { id: "country:CN", name: "China", countryCode: "CN", languages: [], aliases: [], confidence: "high" as const }, queries: [] };
    const t = Date.now();
    const result = await createGdacsProvider(fetchFn, { apiTimeoutMs: 200, rssTimeoutMs: 3000 }).run(input, AbortSignal.timeout(8000));
    expect(Date.now() - t).toBeLessThan(7000);
    expect(result.items).toHaveLength(1);
    expect(result.errorCode).toBe("GDACS_API_FALLBACK_RSS");
  });
});
