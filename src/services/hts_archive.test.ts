import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256, checkHtsRelease, readArchivedRelease, readArchiveIndex, resetHtsArchiveForTest, startHtsArchive } from './hts_archive.js';

// USITC の応答は作り物。exportList は 100 行以上の配列でないと受け付けない
const rows = (tag: string) =>
  Array.from({ length: 120 }, (_, i) => ({ htsno: `0101.${String(i).padStart(2, '0')}`, indent: '0', description: `${tag} ${i}`, footnotes: [{ value: 'x', type: 'endnote' }] }));
const release = (name: string, status = 'current') => ({ name, title: `title ${name}`, description: `desc ${name}`, date: '10/26/2026', status });

let dir: string;
let exportBody = '';
let list: unknown[] = [];
let calls: string[] = [];
let listFails = false;
const realFetch = globalThis.fetch;
const savedDir = process.env.SORA_HTS_DIR;
const savedModules = process.env.ENABLED_MODULES;

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url.includes('releaseList') ? 'releaseList' : 'exportList');
    if (url.includes('releaseList')) return listFails ? new Response('down', { status: 503 }) : Response.json(list);
    return new Response(exportBody, { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedDir === undefined) delete process.env.SORA_HTS_DIR;
  else process.env.SORA_HTS_DIR = savedDir;
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-hts-archive-'));
  process.env.SORA_HTS_DIR = dir;
  resetHtsArchiveForTest();
  exportBody = JSON.stringify(rows('a'));
  list = [release('2026HTSRev22'), release('2026HTSRev21', 'archive')];
  calls = [];
  listFails = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (iso: string) => () => new Date(iso);

describe('HTS release archive', () => {
  it('saves the current release on the first check, keeping the export body as-is', async () => {
    exportBody = `  ${JSON.stringify(rows('a'), null, 1)}\n`; // 空白も含めて、そのまま残す
    const index = await checkHtsRelease(at('2026-11-12T04:12:34.567Z'));
    expect(index.lastError).toBeNull();
    expect(index.checkedAt).toBe('2026-11-12T04:12:34.567Z');
    expect(index.releases).toHaveLength(1);
    const r = index.releases[0];
    expect(r).toMatchObject({
      id: '2026HTSRev22',
      release: '2026HTSRev22',
      title: 'title 2026HTSRev22',
      description: 'desc 2026HTSRev22',
      date: '10/26/2026',
      fetchedAt: '2026-11-12T04:12:34.567Z',
      rowCount: 120,
    });
    expect(r.sha256).toBe(canonicalSha256(rows('a')));
    const gz = readArchivedRelease('2026HTSRev22');
    expect(gz?.byteLength).toBe(r.bytes);
    const text = new TextDecoder().decode(Bun.gunzipSync(gz!));
    expect(text.endsWith(`"records":${exportBody}}`)).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ id: '2026HTSRev22', release: '2026HTSRev22', fetchedAt: '2026-11-12T04:12:34.567Z' });
    expect(JSON.parse(readFileSync(join(dir, 'releases', 'index.json'), 'utf8'))).toEqual(index);
  });

  it('treats key order and whitespace as the same content', () => {
    expect(canonicalSha256([{ b: 1, a: { d: [1, { f: 2, e: 3 }], c: 'x' } }])).toBe(canonicalSha256([{ a: { c: 'x', d: [1, { e: 3, f: 2 }] }, b: 1 }]));
    expect(canonicalSha256([{ a: 1 }])).not.toBe(canonicalSha256([{ a: 2 }]));
  });

  it('does not save or read the release list while the content is unchanged, even if the list moved on', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    calls = [];
    list = [release('2026HTSRev23'), release('2026HTSRev22', 'archive')];
    exportBody = JSON.stringify(rows('a').map((r) => ({ footnotes: r.footnotes, description: r.description, indent: r.indent, htsno: r.htsno })), null, 2);
    const index = await checkHtsRelease(at('2026-11-13T04:00:00Z'));
    expect(calls).toEqual(['exportList']);
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev22']);
    expect(index.checkedAt).toBe('2026-11-13T04:00:00.000Z');
  });

  it('saves changed content under the new release name, newest first', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    list = [release('2026HTSRev23'), release('2026HTSRev22', 'archive')];
    exportBody = JSON.stringify(rows('b'));
    const index = await checkHtsRelease(at('2026-11-20T04:00:00Z'));
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev23', '2026HTSRev22']);
    expect(readArchivedRelease('2026HTSRev22')).toBeDefined();
  });

  it('saves changed content under the same release name with the fetch time when the list lags behind', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    exportBody = JSON.stringify(rows('b'));
    const index = await checkHtsRelease(at('2026-11-14T05:06:07Z'));
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev22-20261114T0506Z', '2026HTSRev22']);
    expect(index.releases[0].release).toBe('2026HTSRev22');
  });

  it('does not save when the release list cannot be read, and records why', async () => {
    listFails = true;
    const index = await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(index.releases).toEqual([]);
    expect(index.lastError).toContain('503');
    expect(readArchiveIndex().lastError).toContain('503');
  });

  it('rejects an export that is not a list of rows', async () => {
    exportBody = '[]';
    const index = await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(index.releases).toEqual([]);
    expect(index.lastError).toContain('行');
  });

  it('reads only saved ids with the allowed shape', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(readArchivedRelease('../index')).toBeUndefined();
    expect(readArchivedRelease('index')).toBeUndefined();
    expect(readArchivedRelease('2026HTSRev21')).toBeUndefined();
  });

  it('starts no timer unless the module is named, and checks after the delay when it is', async () => {
    process.env.ENABLED_MODULES = 'all';
    expect(startHtsArchive({ delayMs: 1 })).toBeNull();
    process.env.ENABLED_MODULES = 'all,hts-archive';
    const handle = startHtsArchive({ delayMs: 1, intervalMs: 60_000 });
    expect(handle).not.toBeNull();
    await Bun.sleep(50);
    handle?.stop();
    await checkHtsRelease(); // 走っている確認を待つ（同時の呼び出しは 1 回にまとまる）
    expect(readArchiveIndex().releases.map((r) => r.id)).toEqual(['2026HTSRev22']);
  });
});
