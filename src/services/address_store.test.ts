import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressStore, artifactRelDir, jobArtifactId, ttlFor } from './address_store.js';

let dir: string;
let clock: number;
let store: AddressStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-store-'));
  clock = 1_000_000;
  store = new AddressStore(dir, () => clock);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(files: Record<string, string>): string {
  const work = store.makeWorkDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  return work;
}

describe('ids and ttl', () => {
  test('ジョブから成果物のIDを決める', () => {
    expect(jobArtifactId({ kind: 'master' })).toBe('master');
    expect(jobArtifactId({ kind: 'postal' })).toBe('postal');
    expect(jobArtifactId({ kind: 'city', lgCode: '131016' })).toBe('city:131016');
  });

  test('成果物のディレクトリ名', () => {
    expect(artifactRelDir('master')).toBe('master');
    expect(artifactRelDir('city:131016')).toBe(join('city', '131016'));
    expect(() => artifactRelDir('bogus')).toThrow();
  });

  test('TTL は種類ごと', () => {
    expect(ttlFor('postal')).toBe(7 * 86_400_000);
    expect(ttlFor('master')).toBe(30 * 86_400_000);
    expect(ttlFor('city:131016')).toBe(7 * 86_400_000);
  });
});

describe('status file', () => {
  test('無い・壊れているときは空の状態を返す', () => {
    expect(store.read()).toEqual({ version: 1, seq: 0, artifacts: {}, failures: {} });
    writeFileSync(join(dir, 'status.json'), '{not json');
    expect(store.read().seq).toBe(0);
  });

  test('update は永続化し、並行しても直列に実行される', async () => {
    await Promise.all(Array.from({ length: 20 }, () => store.update((s) => { s.seq += 1; })));
    expect(store.read().seq).toBe(20);
  });

  test('別のインスタンス（別プロセス相当）とも排他される', async () => {
    const other = new AddressStore(dir, () => clock);
    await Promise.all([
      ...Array.from({ length: 10 }, () => store.update((s) => { s.seq += 1; })),
      ...Array.from({ length: 10 }, () => other.update((s) => { s.seq += 1; })),
    ]);
    expect(store.read().seq).toBe(20);
  });

  test('古いロックは取り除かれる', async () => {
    const lock = join(dir, 'lock');
    writeFileSync(lock, '999999');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await store.update((s) => { s.seq += 1; });
    expect(store.read().seq).toBe(1);
  });
});

describe('publish and current', () => {
  test('作業ディレクトリを版つきの場所へ移し、サイズと更新番号を記録する', async () => {
    const meta = await store.publish('city:131016', build({ 'town.json': '{"a":1}' }), { sig: 's1', sourceDate: '2026-10-02' });
    const current = store.current('city:131016');
    expect(current?.meta).toEqual(meta);
    expect(current?.path).toBe(join(dir, 'city', '131016', meta.ver));
    expect(existsSync(join(current!.path, 'town.json'))).toBe(true);
    expect(meta).toMatchObject({ sig: 's1', sourceDate: '2026-10-02', bytes: 7, builtAt: clock, checkedAt: clock, usedAt: clock });
    expect(store.read().seq).toBe(1);
  });

  test('旧版は直近 1 つだけ残す', async () => {
    const versions: string[] = [];
    for (const sig of ['a', 'b', 'c']) {
      clock += 1000;
      versions.push((await store.publish('master', build({ 'ja.json': sig }), { sig })).ver);
    }
    expect(readdirSync(join(dir, 'master')).sort()).toEqual([versions[1]!, versions[2]!].sort());
    expect(store.read().seq).toBe(3);
  });

  test('ディレクトリが消えていれば current は null', async () => {
    const meta = await store.publish('postal', build({ 'postal.sqlite': 'x' }), { sig: 's' });
    rmSync(join(dir, 'postal', meta.ver), { recursive: true, force: true });
    expect(store.current('postal')).toBeNull();
  });

  test('公開すると記録済みの失敗が消え、最終利用日時は引き継ぐ', async () => {
    await store.markError('postal', '通信失敗');
    expect(store.read().failures.postal?.message).toBe('通信失敗');
    clock = 2_000_000;
    await store.publish('postal', build({ 'postal.sqlite': 'x' }), { sig: 's1' });
    clock = 3_000_000;
    await store.publish('postal', build({ 'postal.sqlite': 'y' }), { sig: 's2' });
    const status = store.read();
    expect(status.failures.postal).toBeUndefined();
    expect(status.artifacts.postal).toMatchObject({ sig: 's2', usedAt: 2_000_000, builtAt: 3_000_000 });
  });
});

describe('checks and errors', () => {
  test('markChecked は確認日時を進め、エラーを消す', async () => {
    await store.publish('master', build({ 'ja.json': '{}' }), { sig: 's' });
    await store.markError('master', '一時的な失敗');
    expect(store.read().artifacts.master?.error).toBe('一時的な失敗');
    clock = 9_000_000;
    await store.markChecked('master', '2026-10-05');
    expect(store.read().artifacts.master).toMatchObject({ checkedAt: 9_000_000, sourceDate: '2026-10-05' });
    expect(store.read().artifacts.master?.error).toBeUndefined();
  });

  test('成果物が無い ID の失敗は failures に残す', async () => {
    await store.markError('city:131016', 'HTTP 403');
    expect(store.read().failures['city:131016']).toEqual({ message: 'HTTP 403', at: clock });
  });
});

describe('use tracking and eviction', () => {
  test('touch と flushUse で最終利用日時を保存する', async () => {
    await store.publish('city:131016', build({ 'town.json': '{}' }), { sig: 's' });
    await store.flushUse(); // 最初の自動書き込みを済ませる
    clock += 10_000;
    store.touch('city:131016'); // 前回の書き込みから 60 秒以内なので、ファイルには書かない
    expect(store.read().artifacts['city:131016']?.usedAt).toBe(1_000_000);
    await store.flushUse();
    expect(store.read().artifacts['city:131016']?.usedAt).toBe(1_010_000);
  });

  test('予算を超えたら、最近使われていない市区町村から破棄する', async () => {
    const ids = ['city:011011', 'city:131016', 'city:131121'];
    for (const [index, id] of ids.entries()) {
      clock = 1_000_000 + index * 1000;
      await store.publish(id, build({ 'town.json': 'x'.repeat(100) }), { sig: id });
    }
    await store.update((s) => { s.artifacts['city:131016']!.usedAt = 9_999_999; });
    const removed = await store.evict(250, new Set());
    expect(removed).toEqual(['city:011011']);
    expect(existsSync(join(dir, 'city', '011011'))).toBe(false);
    expect(Object.keys(store.read().artifacts).sort()).toEqual(['city:131016', 'city:131121']);
  });

  test('pinned と protect の市区町村、および市区町村以外は破棄しない', async () => {
    await store.publish('master', build({ 'ja.json': 'x'.repeat(100) }), { sig: 'm' });
    await store.publish('city:011011', build({ 'town.json': 'x'.repeat(100) }), { sig: 'a', pinned: true });
    await store.publish('city:131016', build({ 'town.json': 'x'.repeat(100) }), { sig: 'b' });
    const removed = await store.evict(1, new Set(['city:131016']));
    expect(removed).toEqual([]);
    expect(Object.keys(store.read().artifacts).sort()).toEqual(['city:011011', 'city:131016', 'master']);
  });
});
