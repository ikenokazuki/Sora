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
