import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetHtsDataForTest } from './hts_data.js';
import { HTS_MODEL_FILES, classifyHts, ensureHtsModel, setHtsModelForTest } from './hts_model.js';

// 関税分類モデルの取得と読み込み。本物のファイル（約 62MB）は、SORA_TEST_HTS_MODEL_DIR にそのフォルダを渡したときだけ読む（ふだんと CI では飛ばす）。
const realModelDir = process.env.SORA_TEST_HTS_MODEL_DIR;
const tReal = test.skipIf(!realModelDir);

let dir: string;
const env: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in env)) env[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const names = Object.keys(HTS_MODEL_FILES);

/** モデルのファイルへの取得を数える。 */
function countFetches(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (names.some((n) => raw.endsWith(n))) urls.push(raw);
    return original(input as never, init);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

describe('HTS classification model (zeiban): fetch and load', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-hts-model-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    setHtsModelForTest(undefined);
    resetHtsDataForTest();
  });
  beforeEach(() => {
    setHtsModelForTest(undefined);
    setEnv('SORA_HTS_DIR', join(dir, 'hts'));
    rmSync(join(dir, 'hts'), { recursive: true, force: true });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(env)) delete env[k];
  });

  /** 中身の違う 3 つのファイルを置いた場所。 */
  function wrongFiles(): string {
    const src = join(dir, 'wrong');
    mkdirSync(src, { recursive: true });
    for (const n of names) writeFileSync(join(src, n), `not ${n}`);
    return `file://${src}/`;
  }

  it('refuses files whose SHA-256 differs from the pinned one, does not save them, and keeps the failure instead of fetching again', async () => {
    setEnv('SORA_HTS_MODEL_URL', wrongFiles());
    const fetches = countFetches();
    try {
      // 同時の呼び出しは 1 回の取得にまとめる（ファイルは 3 つ）
      const results = await Promise.allSettled([ensureHtsModel(), ensureHtsModel(), classifyHts({ name: 'Ceramic Coffee Mug' })]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(String((results[0] as PromiseRejectedResult).reason)).toContain('SHA-256 が違います');
      expect(fetches.urls).toHaveLength(3);
      for (const n of names) expect(existsSync(join(dir, 'hts', 'zeiban', n))).toBe(false);
      // 失敗のあと 1 時間は取り直さず、理由を付けて断る
      const again = await classifyHts({ name: 'Ceramic Coffee Mug' }).catch((e) => e);
      expect(again.message).toContain('関税分類モデルを用意できませんでした');
      expect(again.message).toContain('SHA-256 が違います');
      expect(fetches.urls).toHaveLength(3);
    } finally {
      fetches.restore();
    }
  });

  it('says which file could not be fetched', async () => {
    setEnv('SORA_HTS_MODEL_URL', `file://${join(dir, 'missing')}/`);
    const err = await ensureHtsModel().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/zeiban\.(wasm|json|bin)|missing/);
  });

  it('rejects a location the setting does not allow (only https:// and file://)', async () => {
    setEnv('SORA_HTS_MODEL_URL', 'ftp://example.com/zeiban/');
    const err = await ensureHtsModel().catch((e) => e);
    expect(String(err.message)).toContain('SORA_HTS_MODEL_URL');
  });

  tReal('loads the real model from the given folder, answers English and Japanese, and reuses the saved files', async () => {
    setEnv('SORA_HTS_MODEL_URL', `file://${realModelDir}/`);
    const fetches = countFetches();
    try {
      const en = await classifyHts({ name: 'Mens crew neck t-shirt', material: '100% cotton, knitted' });
      expect(en.codes[0]).toBe('6109100011');
      expect(en.codes).toHaveLength(5);
      expect(en.sixDigit).toBe('610910');
      expect(en.reader).toBeUndefined();
      expect(en.htsRelease).toBe('2026HTSRev22');
      const ja = await classifyHts({ name: 'メンズ 半袖 Tシャツ', material: '綿100% ニット' });
      expect(ja.codes[0]).toBe('6109100027');
      expect(ja.reader).toBe('ja');
      const narrowed = await classifyHts({ name: 'Mens crew neck t-shirt', prefix: '610990' });
      expect(narrowed.codes.every((c) => c.startsWith('610990'))).toBe(true);
      expect(narrowed.sixDigitConfidence).toBe(1);
      await expect(classifyHts({ name: 'Mens crew neck t-shirt', prefix: '61099' })).rejects.toThrow('prefix');
      expect(fetches.urls).toHaveLength(3);
      for (const n of names) expect(existsSync(join(dir, 'hts', 'zeiban', n))).toBe(true);
      // 保存済みのファイル（SHA-256 が合うもの）があれば、取得しない
      setHtsModelForTest(undefined);
      setEnv('SORA_HTS_MODEL_URL', `file://${join(dir, 'missing')}/`);
      expect((await classifyHts({ name: 'Mens crew neck t-shirt', material: '100% cotton, knitted' })).codes[0]).toBe('6109100011');
      expect(fetches.urls).toHaveLength(3);
    } finally {
      fetches.restore();
    }
  }, 60_000);
});

// 同じファイルの別の describe に置くと、上の afterAll より先に走ることがあるので、ここでは何も共有しない
describe('HTS classification model: test double', () => {
  it('uses the classifier a test installs, without fetching anything', async () => {
    setHtsModelForTest(() => ({ codes: ['6912004400'], scores: [0], htsRelease: 'r', hsCode: { code: '6912004400', description: '' }, sixDigit: '691200', confidenceScore: 1, sixDigitConfidence: 1, dutyRate: { general: '', special: '', other: '' }, alternates: [], questions: [] }));
    expect((await classifyHts({ name: 'x' })).codes).toEqual(['6912004400']);
    setHtsModelForTest(undefined);
  });
});
