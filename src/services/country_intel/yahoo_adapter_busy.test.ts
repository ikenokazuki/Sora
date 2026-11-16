import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ResourceBusyError } from '../../errors.js';
import * as yahoo from '../yahoo.js';
import { createYahooWebSearchAdapter } from './runtime.js';

/**
 * 国の情報の Web 検索（Yahoo）の順番・予算の断り（ResourceBusyError。設計 6。穴 25）は、握って空の結果にしない。
 * 空の「成功」の結果が、tenant を含まないキーで 1 時間キャッシュされ、予算に余裕のある別の利用者にも、0 件が返るため。
 * 断りは、提供元の失敗として投げる（キャッシュに入らない）。混み合い以外の失敗は、これまでどおり、空の結果。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const busy = () => new ResourceBusyError('Yahoo への問い合わせの、この利用者の予算を使い切りました', 'tenant_budget', 30, 'yahoo');
const run = () => createYahooWebSearchAdapter()('東京 公式', 5, new AbortController().signal);

describe('createYahooWebSearchAdapter', () => {
  test('Web 検索の断りは、握らず、そのまま投げる', async () => {
    const error = busy();
    spies.push(spyOn(yahoo, 'searchYahooWeb').mockRejectedValue(error));
    await expect(run()).rejects.toBe(error);
  });

  test('代替の直取得の断りも、握らず、そのまま投げる', async () => {
    const error = busy();
    spies.push(spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [] }));
    spies.push(spyOn(yahoo, 'fetchYahooWebDirect').mockRejectedValue(error));
    await expect(run()).rejects.toBe(error);
  });

  test('混み合い以外の失敗は、これまでどおり、空の結果', async () => {
    spies.push(spyOn(yahoo, 'searchYahooWeb').mockRejectedValue(new Error('boom')));
    spies.push(spyOn(yahoo, 'fetchYahooWebDirect').mockRejectedValue(new Error('boom2')));
    expect(await run()).toEqual([]);
  });

  test('結果があれば、そのまま返す', async () => {
    spies.push(spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [{ url: 'https://example.org/a', title: 'a', snippet: 's' }] }));
    expect(await run()).toEqual([{ url: 'https://example.org/a', title: 'a', snippet: 's' }]);
  });
});
