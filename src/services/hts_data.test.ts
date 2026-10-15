import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  buildHtsDatabase,
  getHtsLine,
  hasEnglishWords,
  htsDataInfo,
  htsLinesUnder,
  queryTerms,
  resetHtsDataForTest,
  searchHtsLines,
  toFtsQuery,
} from './hts_data.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';

// 取得・保存・検索のロジックを調べるテスト。USITC の応答は固定データ（実際の関税率表の抜粋）で、実 API との突き合わせは tool-health で行う。
describe('HTS local data (hts_data)', () => {
  let restoreFetch: (() => void) | undefined;
  let exportFetches = 0;
  beforeAll(() => {
    const restoreFixtures = installExternalApiFixtures();
    const wrapped = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (raw.includes('hts.usitc.gov/reststop/exportList')) exportFetches++;
      return wrapped(input as never, init);
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = wrapped;
      restoreFixtures();
    };
  });
  afterAll(() => restoreFetch?.());
  beforeEach(() => {
    resetHtsDataForTest();
    exportFetches = 0;
  });

  describe('buildHtsDatabase', () => {
    // 説明だけの中間行（htsno なし）、率の継承、字下げの飛びを含む小さな木
    const rows = [
      { htsno: '1111.11', indent: '0', description: 'Widgets of a kind used for tables:', general: '' },
      { htsno: '', indent: '1', description: 'Large widgets:', general: '' },
      { htsno: '1111.11.10', indent: '2', description: 'Of wood', general: '5%', special: 'Free (AU)', other: '25%' },
      { htsno: '1111.11.10.10', indent: '3', description: 'Carved', general: '' },
      { htsno: '1111.11.10.90', indent: '3', description: 'Other', general: '' },
      { htsno: '', indent: '2', description: 'Other:', general: '' },
      { htsno: '1111.11.50.00', indent: '3', description: 'Of metal', general: 'Free' },
      { htsno: '1111.11.90.00', indent: '3', description: 'Other', general: '' },
      { htsno: '9903.88.01', indent: '0', description: 'Special additional duties', general: '25%' },
    ];

    function build(): Database {
      const db = new Database(':memory:');
      buildHtsDatabase(rows, db, new Date('2026-10-15T00:00:00Z'));
      return db;
    }
    const lineOf = (db: Database, digits: string) =>
      db.query('SELECT code, indent, general, special, other, rate_from, leaf, path FROM lines WHERE digits = ?').get(digits) as Record<string, string | number>;

    it('inherits the nearest ancestor rate and records where it came from', () => {
      const db = build();
      const carved = lineOf(db, '1111111010');
      expect(carved.general).toBe('5%');
      expect(carved.special).toBe('Free (AU)');
      expect(carved.other).toBe('25%');
      expect(carved.rate_from).toBe('1111.11.10');
      // 自分の行に率があれば、継承元は空
      expect(lineOf(db, '1111115000').general).toBe('Free');
      expect(lineOf(db, '1111115000').rate_from).toBe('');
      // 別の枝（Other:）の率を、前の枝の率と取り違えない
      expect(lineOf(db, '1111119000').general).toBe('');
    });

    it('keeps the official path of ancestors, including description-only rows', () => {
      const db = build();
      const path = (lineOf(db, '1111111010').path as string).split('\u001f');
      expect(path).toEqual(['Widgets of a kind used for tables:', 'Large widgets:', 'Of wood']);
    });

    it('marks leaves (no finer rows) and indexes only leaves outside chapters 98 and 99', () => {
      const db = build();
      expect(lineOf(db, '11111110').leaf).toBe(0);
      expect(lineOf(db, '1111111010').leaf).toBe(1);
      expect(lineOf(db, '1111119000').leaf).toBe(1);
      const indexed = (db.query('SELECT count(*) AS n FROM lines_fts').get() as { n: number }).n;
      expect(indexed).toBe(4); // 1111.11.10.10 / .90 / 1111.11.50.00 / 1111.11.90.00（9903 は章 99 なので除く）
      expect((db.query('SELECT value FROM meta WHERE key = ?').get('fetched_at') as { value: string }).value).toBe('2026-10-15T00:00:00.000Z');
    });
  });

  describe('search over the downloaded tree (fixture excerpt of the real export)', () => {
    it('downloads the export once, even for concurrent first calls', async () => {
      await Promise.all([searchHtsLines('ceramic mug'), getHtsLine('6912.00.44.00'), htsLinesUnder('6912')]);
      await searchHtsLines('green tea');
      expect(exportFetches).toBe(1);
      const info = await htsDataInfo();
      expect(info.lines).toBeGreaterThan(500);
      expect(Date.parse(info.fetchedAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('inherits the parent rate for a 10-digit line (6912.00.35.10 takes 9.8% from 6912.00.35, not the heading)', async () => {
      const line = await getHtsLine('6912.00.35.10');
      expect(line?.leaf).toBe(true);
      expect(line?.general).toBe('9.8%');
      expect(line?.rateFrom).toBe('6912.00.35');
      // 見出し行（6912.00）には率が無い。以前の実装はここで 'Free' を返していた
      expect((await getHtsLine('6912.00'))?.general).toBe('');
    });

    it('returns the official hierarchy so that "Other" lines can be told apart', async () => {
      const line = await getHtsLine('6912.00.44.00');
      expect(line?.description).toBe('Mugs and other steins');
      expect(line?.path.length).toBeGreaterThanOrEqual(3);
      expect(line?.path[0]).toContain('Ceramic tableware');
    });

    it('finds a product by its name in the line or in its ancestors', async () => {
      const mugs = await searchHtsLines('stoneware mug for coffee', { limit: 5 });
      expect(mugs[0].digits.startsWith('6912')).toBe(true);
      const tea = await searchHtsLines('green tea', { limit: 5 });
      expect(tea[0].digits.startsWith('0902')).toBe(true);
    });

    it('does not confuse words that merely contain another word (steel is not tee)', async () => {
      const hits = await searchHtsLines('stainless steel case', { limit: 20 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.digits.startsWith('6109'))).toBe(false); // T-shirts
      expect(hits.slice(0, 5).some((h) => h.digits.startsWith('7323'))).toBe(true); // 'Of stainless steel'
    });

    it('restricts the search to a code prefix and orders leaves by relevance', async () => {
      const hits = await searchHtsLines('mugs', { prefix: '6912', limit: 10 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.digits.startsWith('6912'))).toBe(true);
      expect(hits[0].code).toBe('6912.00.44.00');
      expect(hits.every((h) => h.leaf)).toBe(true);
    });

    it('lists lines under a prefix, optionally only the leaves that can be declared', async () => {
      const all = await htsLinesUnder('691200');
      const leaves = await htsLinesUnder('691200', { leafOnly: true });
      expect(all.length).toBeGreaterThan(leaves.length);
      expect(leaves.every((l) => l.leaf && l.digits.length >= 8)).toBe(true);
      expect(await htsLinesUnder('12')).toEqual([]); // 4桁未満は対象外
    });

    it('treats unknown codes as missing', async () => {
      expect(await getHtsLine('9999.99.99.99')).toBeUndefined();
      expect(await getHtsLine('12')).toBeUndefined();
    });
  });

  describe('query terms', () => {
    it('drops quantity units, stopwords and non-Latin text', () => {
      expect(queryTerms('Stoneware Coffee Mug 500ml, 10-inch 65W for the kitchen')).toEqual(['stoneware', 'coffee', 'mug', 'inch', 'kitchen']);
      expect(toFtsQuery('Mug OR cup AND NOT lid')).toBe('"mug" OR "cup" OR "lid"');
    });

    it('quotes every term so FTS operators in a product name cannot break the query', async () => {
      await expect(searchHtsLines('NEAR(mug) OR AND "quote" * ^')).resolves.toBeDefined();
    });

    it('detects whether a text has any English word to match against the English tariff', () => {
      expect(hasEnglishWords('陶器のマグカップ')).toBe(false);
      expect(hasEnglishWords('500ml 65W')).toBe(false);
      expect(hasEnglishWords('陶器のマグカップ ceramic mug')).toBe(true);
    });
  });
});
