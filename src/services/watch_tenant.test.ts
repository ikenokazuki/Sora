import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as enrichment from '../enrichment.js';
import { closeDb, dbGetWatchTarget, dbListWatchTargets } from '../db.js';
import { checkAllWatchTargets, checkWatchTarget, deleteWatchTarget, listWatchTargets, registerWatchTarget } from './watch.js';

/**
 * ウォッチと tenant（設計 5。穴 2・18）。
 * これまで、ウォッチには持ち主の記録がなく、一覧・確認・削除が、登録した全員の分に効いた
 * （一覧は通知先の Webhook URL と取得した内容まで返し、id を省いた確認は、全員の Webhook に送った）。
 */

const ALICE = 'name:alice';
const BOB = 'name:bob';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'watch-tenant-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

/** 取得を差し替える。渡された引数を seen に残す */
const scrapeText = (content: string, seen: Array<Record<string, unknown>> = []) => async (opts?: unknown) => {
  seen.push((opts ?? {}) as Record<string, unknown>);
  return { content, extracted: { content } };
};

describe('一覧・確認・削除は、呼んだ tenant の登録だけに効く', () => {
  test('一覧は、自分の登録だけ。別の tenant の分（通知先の Webhook URL・取得した内容）は出ない', async () => {
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', webhookUrl: 'https://hooks.example.com/alice-secret-token', initialFetch: false });
    const b = await registerWatchTarget({ tenantId: BOB, url: 'https://example.com/b', initialFetch: false });
    await checkWatchTarget(a.target.id, ALICE, scrapeText('alice の取得した内容') as never);

    const forBob = listWatchTargets(BOB);
    expect(forBob.map((t) => t.id)).toEqual([b.target.id]);
    expect(JSON.stringify(forBob)).not.toContain('alice-secret-token');
    expect(JSON.stringify(forBob)).not.toContain('alice の取得した内容');
    expect(listWatchTargets(ALICE).map((t) => t.id)).toEqual([a.target.id]);
    expect(listWatchTargets('name:carol')).toEqual([]);
  });

  test('応答の記録に、tenant の ID は出ない（API の形は変わらない）', async () => {
    const { target } = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', initialFetch: false });
    expect(Object.keys(target)).not.toContain('tenant_id');
    expect(Object.keys(listWatchTargets(ALICE)[0])).not.toContain('tenant_id');
    expect(JSON.stringify(target)).not.toContain(ALICE);
  });

  test('別の tenant の id は確認できない。存在しない id と同じ失敗で、取得も保存も Webhook も起きない', async () => {
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', webhookUrl: 'http://127.0.0.1:1/a', initialFetch: false });
    const seen: Array<Record<string, unknown>> = [];
    const deliver = spyOn(enrichment, 'deliverWebhook').mockResolvedValue(true);
    try {
      await expect(checkWatchTarget(a.target.id, BOB, scrapeText('x', seen) as never)).rejects.toThrow(`Watch target not found: ${a.target.id}`);
      await expect(checkWatchTarget('wt_nothing', BOB, scrapeText('x', seen) as never)).rejects.toThrow('Watch target not found: wt_nothing');
      expect(seen).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      deliver.mockRestore();
    }
    // alice の基準は、作られていない
    expect(dbGetWatchTarget(a.target.id, ALICE)?.last_hash ?? undefined).toBeUndefined();
  });

  test('id を省いた確認は、呼んだ tenant の分だけ取得し、結果にも Webhook にも、別の tenant の分が入らない', async () => {
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', webhookUrl: 'http://127.0.0.1:1/alice', initialFetch: false });
    const b = await registerWatchTarget({ tenantId: BOB, url: 'https://example.com/b', webhookUrl: 'http://127.0.0.1:1/bob', initialFetch: false });
    await checkAllWatchTargets(ALICE, scrapeText('version one text here') as never);
    await checkAllWatchTargets(BOB, scrapeText('version one text here') as never);

    const aliceBefore = dbGetWatchTarget(a.target.id, ALICE);
    const sentTo: string[] = [];
    const deliver = spyOn(enrichment, 'deliverWebhook').mockImplementation(async (url?: string) => {
      sentTo.push(String(url));
      return true;
    });
    const seen: Array<Record<string, unknown>> = [];
    try {
      const results = await checkAllWatchTargets(BOB, scrapeText('version two text here', seen) as never);
      expect(results.map((r) => r.targetId)).toEqual([b.target.id]);
      expect(seen.map((o) => o.url)).toEqual(['https://example.com/b']);
      expect(sentTo).toEqual(['http://127.0.0.1:1/bob']);
    } finally {
      deliver.mockRestore();
    }
    // alice の対象は、確認されていない（取得した内容・確認の時刻・履歴が、そのまま）
    expect(dbGetWatchTarget(a.target.id, ALICE)).toEqual(aliceBefore!);
    expect(dbListWatchTargets(ALICE).map((t) => t.id)).toEqual([a.target.id]);
  });

  test('別の tenant の id は削除できない。自分の id は削除できる', async () => {
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', initialFetch: false });
    expect(deleteWatchTarget(a.target.id, BOB)).toBe(false);
    expect(listWatchTargets(ALICE).map((t) => t.id)).toEqual([a.target.id]);
    expect(deleteWatchTarget('wt_nothing', ALICE)).toBe(false);
    expect(deleteWatchTarget(a.target.id, ALICE)).toBe(true);
    expect(listWatchTargets(ALICE)).toEqual([]);
  });

  test('別の tenant の id での登録（上書き）は断られ、元の URL・Webhook・基準は変わらない', async () => {
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', webhookUrl: 'https://hooks.example.com/alice', initialFetch: false });
    await checkWatchTarget(a.target.id, ALICE, scrapeText('version one text here') as never);
    const before = dbGetWatchTarget(a.target.id, ALICE);

    await expect(
      registerWatchTarget({ tenantId: BOB, id: a.target.id, url: 'https://evil.example.com/', webhookUrl: 'https://evil.example.com/hook', initialFetch: false }),
    ).rejects.toThrow('Watch target id is not available');

    expect(dbGetWatchTarget(a.target.id, ALICE)).toEqual(before!);
    expect(dbGetWatchTarget(a.target.id, BOB)).toBeUndefined();
    // 持ち主自身の更新は通る
    const own = await registerWatchTarget({ tenantId: ALICE, id: a.target.id, url: 'https://example.com/a2', initialFetch: false });
    expect(own.target.url).toBe('https://example.com/a2');
    expect(own.target.id).toBe(a.target.id);
  });
});

describe('巡回の取得は、持ち主の tenant で行う', () => {
  test('登録の初回の取得も、確認も、全件の確認も、持ち主の tenantId を取得に渡す', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const scrape = scrapeText('version one text here', seen) as never;
    const a = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a' }, scrape);
    await checkWatchTarget(a.target.id, ALICE, scrape);
    await checkAllWatchTargets(ALICE, scrape);
    expect(seen).toHaveLength(3);
    expect(seen.map((o) => o.tenantId)).toEqual([ALICE, ALICE, ALICE]);
    // 取得した結果が共有のキャッシュに入らない形のまま
    expect(seen.every((o) => o.noCache === true)).toBe(true);
  });
});

describe('legacy の tenant（鍵なしの利用者）', () => {
  test('自分の行だけを見る。鍵を持つ tenant の行は見えず、鍵を持つ tenant にも legacy の行は見えない', async () => {
    const legacy = await registerWatchTarget({ tenantId: 'legacy', url: 'https://example.com/legacy', initialFetch: false });
    const alice = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', initialFetch: false });
    expect(listWatchTargets('legacy').map((t) => t.id)).toEqual([legacy.target.id]);
    expect(listWatchTargets(ALICE).map((t) => t.id)).toEqual([alice.target.id]);
    expect(deleteWatchTarget(legacy.target.id, ALICE)).toBe(false);
    expect(deleteWatchTarget(alice.target.id, 'legacy')).toBe(false);
  });
});

describe('一覧と登録の応答（tenant で絞ったあとも、これまでの形のまま）', () => {
  test('一覧は、新しい登録が先（作成の時刻の降順）', async () => {
    const first = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/1', initialFetch: false });
    await Bun.sleep(5);
    const second = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/2', initialFetch: false });
    await Bun.sleep(5);
    const third = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/3', initialFetch: false });
    expect(listWatchTargets(ALICE).map((t) => t.id)).toEqual([third.target.id, second.target.id, first.target.id]);
  });

  test('登録の応答の target は、初回の取得のあとの状態（持ち主の tenant で読み直したもの）', async () => {
    const { target, initialResult } = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a' }, scrapeText('version one text here') as never);
    expect(initialResult?.currentHash).toBeDefined();
    expect(target.last_hash).toBe(initialResult?.currentHash);
    expect(target.last_checked_at).toBeGreaterThan(0);
  });
});
