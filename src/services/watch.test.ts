import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, dbGetWatchTarget, dbListWatchHistory } from '../db.js';
import { checkAllWatchTargets, checkWatchTarget, registerWatchTarget, WatchSelectorNotFoundError } from './watch.js';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'watch-f7-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

const matchScrape = (content: string) => async (_opts?: unknown) => ({ content: 'fallback:' + content, extracted: { content } });
const missScrape = (content: string) => async (_opts?: unknown) => ({ content, extracted: { content: null } });

describe('F7 selector presence', () => {
  test('missing selector rejects without touching baseline or history', async () => {
    const { target } = await registerWatchTarget({ url: 'https://example.com/page', selector: '#status', initialFetch: false });
    const base = await checkWatchTarget(target.id, matchScrape('version one text here') as never);
    expect(base.changed).toBe(false);
    const before = dbGetWatchTarget(target.id);
    const historyBefore = dbListWatchHistory(target.id);
    let error: unknown;
    try {
      await checkWatchTarget(target.id, missScrape('entirely different full page body') as never);
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WatchSelectorNotFoundError);
    expect((error as WatchSelectorNotFoundError).code).toBe('WATCH_SELECTOR_NOT_FOUND');
    const after = dbGetWatchTarget(target.id);
    expect(after?.last_hash).toBe(before?.last_hash);
    expect(after?.last_content).toBe(before?.last_content);
    expect(after?.last_checked_at).toBe(before?.last_checked_at);
    expect(dbListWatchHistory(target.id)).toHaveLength(historyBefore.length);
    const recovered = await checkWatchTarget(target.id, matchScrape('version one text here') as never);
    expect(recovered.changed).toBe(false);
  });
  test('empty-string match is valid empty content, not not-found', async () => {
    const { target } = await registerWatchTarget({ url: 'https://example.com/empty', selector: '#blank', initialFetch: false });
    const r = await checkWatchTarget(target.id, matchScrape('') as never);
    expect(r.changed).toBe(false);
    expect(typeof r.currentHash).toBe('string');
  });
  test('initial selector miss returns initialError with no baseline', async () => {
    const { target, initialResult, initialError } = await registerWatchTarget(
      { url: 'https://example.com/gone', selector: '#nope' }, missScrape('full page') as never);
    expect(initialResult).toBeUndefined();
    expect(initialError?.code).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(dbGetWatchTarget(target.id)?.last_hash ?? undefined).toBeUndefined();
  });
  test('batch check keeps errorCode and continues with others', async () => {
    const a = await registerWatchTarget({ url: 'https://example.com/a', selector: '#x', initialFetch: false });
    const b = await registerWatchTarget({ url: 'https://example.com/b', initialFetch: false });
    const scrape = async (opts: any) => opts.selectors ? missScrape('page')(opts) : matchScrape('b body')(opts);
    const results = await checkAllWatchTargets(scrape as never);
    const byId = new Map(results.map((r) => [r.targetId, r]));
    expect(byId.get(a.target.id)?.errorCode).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(byId.get(b.target.id)?.errorCode).toBeUndefined();
  });
});

describe('webhookSent は送信の成否を表す', () => {
  const previousLocal = process.env.ALLOW_LOCAL_FETCH;
  afterEach(() => {
    if (previousLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = previousLocal;
  });

  // 手元の受け口。status で応答し、受け取った本文を残す
  const receiver = (status: number) => {
    const bodies: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.json());
        return new Response('ok', { status });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/hook`, bodies, stop: () => server.stop(true) };
  };

  // 初回で基準を作り、2 回目で差分を出して、2 回目の結果を返す
  const changeOnce = async (webhookUrl: string) => {
    const { target } = await registerWatchTarget({ url: 'https://example.com/hook', webhookUrl, initialFetch: false });
    await checkWatchTarget(target.id, matchScrape('version one text here') as never);
    return checkWatchTarget(target.id, matchScrape('version two text here') as never);
  };

  test('2xx で受け取られたときだけ true', async () => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    const hook = receiver(200);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(true);
      expect(hook.bodies).toHaveLength(1);
      expect((hook.bodies[0] as { data: { event: string } }).data.event).toBe('watch.diff_detected');
    } finally {
      hook.stop();
    }
  });

  test('受け口が 5xx を返したら false', async () => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    const hook = receiver(500);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(false);
      expect(hook.bodies).toHaveLength(1);
    } finally {
      hook.stop();
    }
  });

  test('つながらない先は false', async () => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    const res = await changeOnce('http://127.0.0.1:1/hook');
    expect(res.changed).toBe(true);
    expect(res.webhookSent).toBe(false);
  });

  test('SSRF の判定で止められた先は false（送っていない）', async () => {
    delete process.env.ALLOW_LOCAL_FETCH;
    const hook = receiver(200);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(false);
      expect(hook.bodies).toHaveLength(0);
    } finally {
      hook.stop();
    }
  });

  test('Webhook の無い監視や、差分の無い確認では webhookSent を返さない', async () => {
    const { target } = await registerWatchTarget({ url: 'https://example.com/none', initialFetch: false });
    await checkWatchTarget(target.id, matchScrape('version one text here') as never);
    const changed = await checkWatchTarget(target.id, matchScrape('version two text here') as never);
    expect(changed.changed).toBe(true);
    expect(changed.webhookSent).toBeUndefined();
  });
});
