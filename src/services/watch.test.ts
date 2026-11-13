import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as enrichment from '../enrichment.js';
import { closeDb, dbGetWatchTarget, dbListWatchHistory, dbListWatchTargets } from '../db.js';
import { checkAllWatchTargets, checkWatchTarget, registerWatchTarget, WatchSelectorNotFoundError } from './watch.js';

const TENANT = 'name:watch-test';

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
    const { target } = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/page', selector: '#status', initialFetch: false });
    const base = await checkWatchTarget(target.id, TENANT, matchScrape('version one text here') as never);
    expect(base.changed).toBe(false);
    const before = dbGetWatchTarget(target.id, TENANT);
    const historyBefore = dbListWatchHistory(target.id);
    let error: unknown;
    try {
      await checkWatchTarget(target.id, TENANT, missScrape('entirely different full page body') as never);
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WatchSelectorNotFoundError);
    expect((error as WatchSelectorNotFoundError).code).toBe('WATCH_SELECTOR_NOT_FOUND');
    const after = dbGetWatchTarget(target.id, TENANT);
    expect(after?.last_hash).toBe(before?.last_hash);
    expect(after?.last_content).toBe(before?.last_content);
    expect(after?.last_checked_at).toBe(before?.last_checked_at);
    expect(dbListWatchHistory(target.id)).toHaveLength(historyBefore.length);
    const recovered = await checkWatchTarget(target.id, TENANT, matchScrape('version one text here') as never);
    expect(recovered.changed).toBe(false);
  });
  test('empty-string match is valid empty content, not not-found', async () => {
    const { target } = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/empty', selector: '#blank', initialFetch: false });
    const r = await checkWatchTarget(target.id, TENANT, matchScrape('') as never);
    expect(r.changed).toBe(false);
    expect(typeof r.currentHash).toBe('string');
  });
  test('initial selector miss returns initialError with no baseline', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    let warned: string[];
    let registered: Awaited<ReturnType<typeof registerWatchTarget>>;
    try {
      registered = await registerWatchTarget(
        { tenantId: TENANT, url: 'https://example.com/gone', selector: '#nope' }, missScrape('full page') as never);
      warned = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
    const { target, initialResult, initialError } = registered;
    expect(warned).toEqual([expect.stringContaining('Initial fetch for watch target')]);
    expect(initialResult).toBeUndefined();
    expect(initialError?.code).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(dbGetWatchTarget(target.id, TENANT)?.last_hash ?? undefined).toBeUndefined();
  });
  test('batch check keeps errorCode and continues with others', async () => {
    const a = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/a', selector: '#x', initialFetch: false });
    const b = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/b', initialFetch: false });
    const scrape = async (opts: any) => opts.selectors ? missScrape('page')(opts) : matchScrape('b body')(opts);
    const results = await checkAllWatchTargets(TENANT, scrape as never);
    const byId = new Map(results.map((r) => [r.targetId, r]));
    expect(byId.get(a.target.id)?.errorCode).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(byId.get(b.target.id)?.errorCode).toBeUndefined();
  });
});

describe('webhookSent は送信の成否を表す', () => {
  const previousLocal = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  // 失敗の経路は想定どおり console.warn を出す。テストの出力に混ぜず、ここで受けて確かめる
  let warn: ReturnType<typeof spyOn<Console, 'warn'>>;
  const warned = () => warn.mock.calls.map((c) => c.map(String).join(' '));
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (previousLocal === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousLocal;
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
    const { target } = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/hook', webhookUrl, initialFetch: false });
    await checkWatchTarget(target.id, TENANT, matchScrape('version one text here') as never);
    return checkWatchTarget(target.id, TENANT, matchScrape('version two text here') as never);
  };

  test('2xx で受け取られたときだけ true', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    const hook = receiver(200);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(true);
      expect(warned()).toEqual([]);
      expect(hook.bodies).toHaveLength(1);
      expect((hook.bodies[0] as { data: { event: string } }).data.event).toBe('watch.diff_detected');
    } finally {
      hook.stop();
    }
  });

  test('受け口が 5xx を返したら false', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    const hook = receiver(500);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(false);
      expect(warned()).toEqual([expect.stringContaining('HTTP 500')]);
      expect(hook.bodies).toHaveLength(1);
    } finally {
      hook.stop();
    }
  });

  test('つながらない先は false', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    const res = await changeOnce('http://127.0.0.1:1/hook');
    expect(res.changed).toBe(true);
    expect(res.webhookSent).toBe(false);
    expect(warned()).toEqual([expect.stringContaining('Error sending webhook')]);
  });

  test('SSRF の判定で止められた先は false（送っていない）', async () => {
    delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    const hook = receiver(200);
    try {
      const res = await changeOnce(hook.url);
      expect(res.changed).toBe(true);
      expect(res.webhookSent).toBe(false);
      expect(warned()).toEqual([expect.stringContaining('Blocked SSRF')]);
      expect(hook.bodies).toHaveLength(0);
    } finally {
      hook.stop();
    }
  });

  test('Webhook の無い監視や、差分の無い確認では webhookSent を返さない', async () => {
    const { target } = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/none', initialFetch: false });
    await checkWatchTarget(target.id, TENANT, matchScrape('version one text here') as never);
    const changed = await checkWatchTarget(target.id, TENANT, matchScrape('version two text here') as never);
    expect(changed.changed).toBe(true);
    expect(changed.webhookSent).toBeUndefined();
  });

  test('checkAllWatchTargets（全件の check）は変化のあった対象の Webhook をまとめて送り、結果は対象ごと', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    // 受け口は、3 件の通知がそろうまでどれにも応答しない。時間に頼らず、同時に来た数で確かめる（1 件ずつ送る作りは止まり、テストの時間切れで落ちる）
    let inFlight = 0;
    let maxInFlight = 0;
    const storedBeforeSend: boolean[] = [];
    const held: Array<() => void> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { data } = (await req.json()) as { data: { targetId: string } };
        storedBeforeSend.push(dbListWatchHistory(data.targetId).length === 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const released = new Promise<void>((resolve) => held.push(resolve));
        if (held.length === 3) for (const release of held) release();
        await released;
        inFlight -= 1;
        return new Response('ok', { status: new URL(req.url).pathname === '/bad' ? 500 : 200 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const a = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/a', webhookUrl: `${base}/ok`, initialFetch: false });
      const b = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/b', webhookUrl: `${base}/bad`, initialFetch: false });
      const c = await registerWatchTarget({ tenantId: TENANT, url: 'https://example.com/c', webhookUrl: `${base}/ok`, initialFetch: false });
      await checkAllWatchTargets(TENANT, matchScrape('version one text here') as never);
      const results = await checkAllWatchTargets(TENANT, matchScrape('version two text here') as never);
      expect(maxInFlight).toBe(3);
      // ログには、ホスト名とポートだけを出す（URL のパス・クエリに、通知先のトークンが入りやすいため）。どの対象が失敗したかは結果の webhookSent で分かる
      expect(warned()).toEqual([expect.stringContaining(`${new URL(base).host}: HTTP 500`)]);
      expect(warned().join('\n')).not.toContain('/bad');
      expect(storedBeforeSend).toEqual([true, true, true]);
      const sent = new Map(results.map((r) => [r.targetId, r.webhookSent]));
      expect(sent.get(a.target.id)).toBe(true);
      expect(sent.get(b.target.id)).toBe(false);
      expect(sent.get(c.target.id)).toBe(true);
      // 結果の並びは、一覧 (DB) の並びのまま
      expect(results.map((r) => r.targetId)).toEqual(dbListWatchTargets(TENANT).map((t) => t.id));
    } finally {
      server.stop(true);
    }
  });

  test('同時に送る Webhook は 5 件まで。残りは空きを待ち、保存・結果の並び・対象ごとの webhookSent は変わらない', async () => {
    for (let i = 0; i < 8; i += 1) {
      await registerWatchTarget({ tenantId: TENANT, url: `https://example.com/t${i}`, webhookUrl: `http://127.0.0.1:1/t${i}`, initialFetch: false });
    }
    await checkAllWatchTargets(TENANT, matchScrape('version one text here') as never);
    // 送信はすべて門で止める。8 件目の対象を確かめ始めたとき、前の 7 件の通知は、送っているか空きを待っているかが決まっているので、
    // 送っている数を数えてから門を開ける。時間に頼らない（1 件ずつ送る作りは門が開かずに止まり、テストの時間切れで落ちる）
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const state = { inFlight: 0, maxInFlight: 0, atLast: -1, storedBeforeSend: [] as boolean[] };
    const deliver = spyOn(enrichment, 'deliverWebhook').mockImplementation(async (_url?: string, payload?: { targetId: string }) => {
      state.storedBeforeSend.push(dbListWatchHistory(payload?.targetId ?? '').length === 1);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await gate;
      state.inFlight -= 1;
      return true;
    });
    const second = matchScrape('version two text here');
    let scrapes = 0;
    try {
      const results = await checkAllWatchTargets(TENANT, (async (opts?: unknown) => {
        scrapes += 1;
        if (scrapes === 8) {
          state.atLast = state.inFlight;
          open();
        }
        return second(opts);
      }) as never);
      expect(state.atLast).toBe(5);
      expect(state.maxInFlight).toBe(5);
      expect(state.storedBeforeSend).toEqual(Array(8).fill(true));
      expect(results.map((r) => r.webhookSent)).toEqual(Array(8).fill(true));
      expect(results.map((r) => r.targetId)).toEqual(dbListWatchTargets(TENANT).map((t) => t.id));
    } finally {
      deliver.mockRestore();
    }
  });

  test('送信が例外を投げても、全件の結果は返り、その対象だけ webhookSent が false', async () => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    const targets = [] as string[];
    for (const name of ['a', 'b', 'c']) {
      const { target } = await registerWatchTarget({ tenantId: TENANT, url: `https://example.com/${name}`, webhookUrl: `http://127.0.0.1:1/${name}`, initialFetch: false });
      targets.push(target.id);
    }
    await checkAllWatchTargets(TENANT, matchScrape('version one text here') as never);
    const deliver = spyOn(enrichment, 'deliverWebhook').mockImplementation(async (url?: string) => {
      // 例外の文は宛先の URL（秘密を含みうる）を含む。警告には code だけを出す
      if (url?.endsWith('/b')) throw Object.assign(new Error(`UnexpectedRedirect fetching "${url}?token=secret-token-w"`), { code: 'UnexpectedRedirect' });
      return true;
    });
    try {
      const results = await checkAllWatchTargets(TENANT, matchScrape('version two text here') as never);
      expect(results).toHaveLength(3);
      expect(new Map(results.map((r) => [r.url.slice(-1), r.webhookSent]))).toEqual(new Map([['a', true], ['b', false], ['c', true]]));
      expect(results.every((r) => r.changed)).toBe(true);
      expect(warned()).toEqual([`[Sora/Watch] Webhook delivery for watch target ${targets[1]} threw: UnexpectedRedirect`]);
    } finally {
      deliver.mockRestore();
    }
  });
});
