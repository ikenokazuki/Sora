import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { closeAllBrowserSessions, closeBrowserSession, handleBrowserSessionAction } from './browser_session.js';
import { browserRoutes } from './routes/browser.js';
import { executeBrowserActions } from './scraper.js';
import { STANDARD_LIMITS } from './security/limits.js';
import { within } from './test_fixtures/browser_slots.js';
import { BrowserActionResponseSchema } from './types.js';

/**
 * browser_action で、思っていたセッションと違うものになるときは、応答の warnings で分かるようにする:
 * 指定した sessionId のセッションが無くて新しく作った（期限・数の上限・閉じた・再起動のどれでも。ログインの状態は引き継がれない）、
 * 数の上限で、別のセッションを閉じた。ブラウザは起動しない（getBrowser を偽物に替える）。
 */

const spies: Array<{ mockRestore: () => void }> = [];
// then を返すと、Promise が待つ対象と取り違える
const makePage = () => new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : prop === 'url' ? () => 'about:blank' : async () => '') });
const fakeBrowser = { createBrowserContext: async () => ({ newPage: async () => makePage(), close: async () => {} }) };

beforeEach(async () => {
  await closeAllBrowserSessions();
  spies.push(spyOn(engine, 'getBrowser').mockResolvedValue({ browser: fakeBrowser, isDedicated: false } as never));
});
afterEach(async () => {
  setSystemTime();
  await closeAllBrowserSessions();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const lims = (extra: Partial<typeof STANDARD_LIMITS> = {}) => ({ ...STANDARD_LIMITS, ...extra });
const act = (options: Record<string, unknown>, lim: Readonly<typeof STANDARD_LIMITS> = STANDARD_LIMITS) =>
  within(handleBrowserSessionAction({ extract: { markdown: false }, actions: [], tenantId: 'name:alice', ...options } as never, lim));
const recreated = (warnings?: string[]) => (warnings ?? []).filter((w) => w.includes('新しく作りました'));

describe('指定した sessionId のセッションが無くて、新しく作ったとき', () => {
  test('一度も無い ID を指定した（createSession なし）→ 新しく作ったと分かる。次の呼び出しは同じセッションなので、何も付かない', async () => {
    const first = await act({ sessionId: 'x' });
    expect(recreated(first.warnings)).toHaveLength(1);
    expect(first.warnings?.[0]).toContain('ログインの状態');
    expect((await act({ sessionId: 'x' })).warnings).toBeUndefined();
  });

  test('閉じられたあと（持ち主の close・数の上限・サーバーの再起動と同じ「無い」状態）に、同じ ID を使うと分かる', async () => {
    await act({ createSession: true, sessionId: 'x' });
    await closeBrowserSession('x', 'name:alice');
    expect(recreated((await act({ sessionId: 'x' })).warnings)).toHaveLength(1);
  });

  test('最長の時間を過ぎたセッションは、閉じて作り直したと分かる', async () => {
    const lim = lims({ browserSessionMaxMs: 3_600_000 });
    await act({ createSession: true, sessionId: 'x' }, lim);
    setSystemTime(new Date(Date.now() + 3_600_001));
    const result = await act({ sessionId: 'x' }, lim);
    expect(recreated(result.warnings)).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('1 時間');
  });

  test('新しいセッションを頼んだとき（createSession: true）と、セッションを使わない呼び出しには、付けない', async () => {
    expect((await act({ createSession: true, sessionId: 'y' })).warnings).toBeUndefined();
    expect((await act({ createSession: true })).warnings).toBeUndefined();
    expect((await act({})).warnings).toBeUndefined();
    expect((await act({ sessionId: 'nothing', closeSession: true })).warnings).toBeUndefined();
  });
});

describe('数の上限で、別のセッションを閉じたとき', () => {
  test('閉じる原因になった呼び出しの応答で分かる（閉じたセッションの ID は書かない）', async () => {
    const lim = lims({ browserSessionsPerTenant: 1 });
    expect((await act({ createSession: true, sessionId: 'first-secret-id' }, lim)).warnings).toBeUndefined();
    const second = await act({ createSession: true, sessionId: 'second' }, lim);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings?.[0]).toContain('数の上限（1 人 1 件）');
    expect(second.warnings?.[0]).not.toContain('first-secret-id');
    // 閉じられた側を、もう一度使うと、作り直しと、そのための追い出しの両方が分かる
    const again = await act({ sessionId: 'first-secret-id' }, lim);
    expect(again.warnings).toHaveLength(2);
    expect(recreated(again.warnings)).toHaveLength(1);
  });

  test('作ってすぐ閉じる呼び出し（createSession と closeSession）の応答にも残る', async () => {
    const lim = lims({ browserSessionsPerTenant: 1 });
    await act({ createSession: true, sessionId: 'a' }, lim);
    const result = await act({ createSession: true, closeSession: true }, lim);
    expect(result.sessionClosed).toBe(true);
    expect(result.warnings?.[0]).toContain('数の上限');
  });
});

describe('MCP と REST の応答まで届く（外側の関数は、返す欄を選んで組み立てる）', () => {
  test('executeBrowserActions（MCP の browser_action が呼ぶ）', async () => {
    const result = await within(executeBrowserActions({ sessionId: 'outer', tenantId: 'name:alice', actions: [], extract: { markdown: false } } as never));
    expect(recreated(result.warnings)).toHaveLength(1);
    expect((await within(executeBrowserActions({ sessionId: 'outer', tenantId: 'name:alice', actions: [], extract: { markdown: false } } as never))).warnings).toBeUndefined();
  });

  test('REST の POST /browser/action', async () => {
    const response = await within(Promise.resolve(browserRoutes.request('/browser/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'rest', extract: { markdown: false } }) })));
    expect(response.status).toBe(200);
    expect(recreated(((await response.json()) as { warnings?: string[] }).warnings)).toHaveLength(1);
  });
});

test('応答の型（OpenAPI）にも warnings がある', () => {
  expect(Object.keys(BrowserActionResponseSchema.shape)).toContain('warnings');
});
