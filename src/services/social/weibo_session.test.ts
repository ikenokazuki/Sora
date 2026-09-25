import { describe, expect, test } from 'bun:test';
import { createWeiboSessionStore } from './weibo_session.js';

const cookies = () => [{ name: 'SUB', value: 's', domain: 'm.weibo.cn' }];

describe('weibo session store', () => {
  test('single flight across concurrent callers', async () => {
    let opens = 0;
    const store = createWeiboSessionStore({
      openWeiboSession: async () => { opens++; await new Promise((r) => setTimeout(r, 20)); return cookies(); },
    });
    const sig = AbortSignal.timeout(5000);
    const [a, b, c] = await Promise.all([store.get(sig), store.get(sig), store.get(sig)]);
    expect(opens).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  test('reuses a valid session without reopening', async () => {
    let opens = 0;
    const store = createWeiboSessionStore({ openWeiboSession: async () => { opens++; return cookies(); } });
    const sig = AbortSignal.timeout(5000);
    await store.get(sig);
    await store.get(sig);
    expect(opens).toBe(1);
  });
  test('invalidate only drops the session actually used', async () => {
    let opens = 0;
    const store = createWeiboSessionStore({ openWeiboSession: async () => { opens++; return cookies(); } });
    const sig = AbortSignal.timeout(5000);
    const s1 = await store.get(sig);
    store.invalidate({ cookies: cookies(), issuedAt: 0, expiresAt: 0 });
    await store.get(sig);
    expect(opens).toBe(1);
    store.invalidate(s1);
    await store.get(sig);
    expect(opens).toBe(2);
  });
  test('missing SUB is a session failure, not a usable session', async () => {
    const store = createWeiboSessionStore({ openWeiboSession: async () => [] });
    await expect(store.get(AbortSignal.timeout(5000))).rejects.toThrow();
  });
});
