import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../cache.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { lookupCrossRulings, resetCrossBreakerForTest } from './cbp_cross.js';
import { type CrossIndexLine, ensureCrossIndex, resetCrossIndexForTest, searchCrossIndex } from './cross_index.js';
import { resetHtsDataForTest } from './hts_data.js';
import { predictHtsCode } from './trade.js';

// 手元の判例の索引（SORA_HTS_CROSS_SOURCE=local、既定）。索引のファイルはテストの中で作り、file:// で読ませる。
const LINES: CrossIndexLine[] = [
  { n: 'NY N000001', d: '2020-01-02', t: 'Stoneware Coffee Mug', x: 'A stoneware mug with a handle for drinking coffee.', c: ['6912004400'] },
  { n: 'NY N000002', d: '2021-03-04', t: 'Porcelain Coffee Cup', x: 'A porcelain cup for coffee, sold with a saucer.', c: ['6911101000'] },
  { n: 'NY N000003', d: '2019-05-06', t: 'Ceramic Coffee Mug Set', x: 'A set of four stoneware coffee mugs in a gift box.', c: ['6912004400'] },
  { n: 'NY N000004', d: '2018-07-08', t: 'Wooden Building Blocks', x: 'Toy wooden building blocks for children aged 3 and over.', c: ['9503000073'] },
  { n: '', d: '', t: '', x: 'A stoneware coffee mug with a printed design.', c: ['6912004400'] },
];

let dir: string;
const env: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in env)) env[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

function writeIndex(lines: CrossIndexLine[], name = 'index.jsonl.gz'): { url: string; sha256: string } {
  const text = [JSON.stringify({ schema: 1 }), ...lines.map((l) => JSON.stringify(l))].join('\n');
  const gz = Bun.gzipSync(new TextEncoder().encode(text));
  const file = join(dir, name);
  writeFileSync(file, gz);
  return { url: `file://${file}`, sha256: createHash('sha256').update(gz).digest('hex') };
}

function useIndex(lines: CrossIndexLine[]): void {
  const { url, sha256 } = writeIndex(lines);
  setEnv('SORA_HTS_CROSS_INDEX_URL', url);
  setEnv('SORA_HTS_CROSS_INDEX_SHA256', sha256);
}

describe('local CROSS ruling index', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-cross-index-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    clearCache();
    resetCrossBreakerForTest();
    resetCrossIndexForTest();
    setEnv('SORA_HTS_CROSS_SOURCE', undefined);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(env)) delete env[k];
  });

  it('matches rulings that contain every word of the term, best bm25 first, and counts all matches', async () => {
    useIndex(LINES);
    await ensureCrossIndex();
    const mug = searchCrossIndex('stoneware coffee mug', 10);
    expect(mug?.totalHits).toBe(3);
    expect(mug?.rulings.map((r) => r.rulingNumber).slice(0, 1)).toEqual(['NY N000001']);
    expect(mug?.rulings.map((r) => r.rulingNumber)).not.toContain('NY N000002'); // porcelain cup に "stoneware" と "mug" は無い
    const coffee = searchCrossIndex('coffee', 2);
    expect(coffee?.totalHits).toBe(4);
    expect(coffee?.rulings).toHaveLength(2);
    expect(searchCrossIndex('plush bear', 10)).toEqual({ rulings: [], totalHits: 0 });
  });

  it('keeps rulings without a number for votes only (no URL), and links numbered rulings to rulings.cbp.gov', async () => {
    useIndex(LINES);
    await ensureCrossIndex();
    const hits = searchCrossIndex('printed mug', 10)?.rulings ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('');
    expect(hits[0].tariffs).toEqual(['6912004400']);
    expect(searchCrossIndex('building blocks', 10)?.rulings[0].url).toBe('https://rulings.cbp.gov/ruling/NY%20N000004');
  });

  it('answers unavailable with a note while the index is being prepared, and uses it once ready', async () => {
    useIndex(LINES);
    const first = await lookupCrossRulings(['coffee mug']);
    expect(first.status).toBe('unavailable');
    expect(first.error).toContain('準備中');
    await ensureCrossIndex();
    const ready = await lookupCrossRulings(['stoneware coffee mug', 'coffee mug']);
    expect(ready.status).toBe('ok');
    expect(ready.rulings[0].rulingNumber).toBe('NY N000001');
  });

  it('refuses an index file whose SHA-256 differs, and says why', async () => {
    const { url } = writeIndex(LINES, 'other.jsonl.gz');
    setEnv('SORA_HTS_CROSS_INDEX_URL', url);
    setEnv('SORA_HTS_CROSS_INDEX_SHA256', 'f'.repeat(64));
    await expect(ensureCrossIndex()).rejects.toThrow('SHA-256');
    const res = await lookupCrossRulings(['coffee mug']);
    expect(res.status).toBe('unavailable');
    expect(res.error).toContain('SHA-256');
  });

  it('stops at a term that matches more than 250 rulings (its top hits are unrelated to the product), keeping what the specific term found', async () => {
    const many: CrossIndexLine[] = Array.from({ length: 251 }, (_, i) => ({ n: `NY N1${String(i).padStart(5, '0')}`, d: '2020-01-01', t: `Widget table ${i}`, x: 'A table.', c: ['9403600000'] }));
    useIndex([{ n: 'NY N200000', d: '2020-01-01', t: 'Oak Widget Table', x: 'A dining table of oak.', c: ['9403608081'] }, ...many]);
    await ensureCrossIndex();
    const res = await lookupCrossRulings(['oak widget table', 'widget table']);
    expect(res.status).toBe('ok');
    expect(res.rulings.map((r) => r.rulingNumber)).toEqual(['NY N200000']);
    expect(res.query).toBe('oak widget table');
  });

  it('predicts from the local index by default and shows the attribution, without listing unnumbered rulings', async () => {
    const restore = installExternalApiFixtures(); // HTS の全件データの写し（判例の照会先は API になるので、あとで local に戻す）
    try {
      resetHtsDataForTest();
      setEnv('SORA_HTS_CROSS_SOURCE', undefined);
      useIndex(LINES);
      await ensureCrossIndex();
      const res = await predictHtsCode({ productName: 'Stoneware Coffee Mug', description: 'Coffee mug for kitchen use', material: 'stoneware' });
      expect(res.evidence.crossStatus).toBe('ok');
      expect(res.detectedSubheading).toBe('6912.00');
      expect(res.evidence.attribution).toContain('Flexify.AI');
      expect(res.evidence.rulings.length).toBeGreaterThan(0);
      expect(res.evidence.rulings.every((r) => r.url.startsWith('https://rulings.cbp.gov/ruling/'))).toBe(true);
    } finally {
      restore();
      resetHtsDataForTest();
    }
  });
});
