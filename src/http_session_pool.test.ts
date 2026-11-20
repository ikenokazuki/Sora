import { describe, expect, test } from 'bun:test';
import { dbGetTenantCookies, dbSaveTenantCookies } from './db.js';
import { closeHttpSession, getOrCreateHttpSession } from './http_fetcher.js';

/** 失敗したら true。`expect().rejects` は使わない（Bun で、待ちが長引くことがある） */
const fails = (promise: Promise<unknown>) => promise.then(() => false, () => true);

const profile = 'chrome_142';

describe('セッションの池: 同じキー（tenant・ドメイン）の最初の取得が同時に来たとき', () => {
  test('全員が同じセッションを受け、池に残るのもそれ', async () => {
    const domain = 'pool-same.example';
    try {
      const sessions = await Promise.all(Array.from({ length: 8 }, () => getOrCreateHttpSession(domain, profile, undefined, 'tenantP')));
      expect(new Set(sessions).size).toBe(1);
      expect(await getOrCreateHttpSession(domain, profile, undefined, 'tenantP')).toBe(sessions[0]);
    } finally {
      await closeHttpSession(domain, 'tenantP');
    }
  });

  test('受けたセッションのどれに付いた Cookie も、閉じるときに保存される（池の外に取り残されない）', async () => {
    const domain = 'pool-cookies.example';
    try {
      const sessions = await Promise.all(Array.from({ length: 4 }, () => getOrCreateHttpSession(domain, profile, undefined, 'tenantP')));
      for (const [i, session] of sessions.entries()) session.setCookie(`c${i}`, 'v', `https://${domain}`);
      await closeHttpSession(domain, 'tenantP');
      const saved = (dbGetTenantCookies('tenantP', domain) ?? []).map((cookie) => cookie.name).sort();
      expect(saved).toEqual(['c0', 'c1', 'c2', 'c3']);
    } finally {
      await closeHttpSession(domain, 'tenantP');
    }
  });

  test('キーが違えば、同時でも別のセッション（tenant・ドメイン・資格情報の分離キーのどれが違っても）', async () => {
    const domain = 'pool-keys.example';
    try {
      const sessions = await Promise.all([
        getOrCreateHttpSession(domain, profile, undefined, 'tenantA'),
        getOrCreateHttpSession(domain, profile, undefined, 'tenantB'),
        getOrCreateHttpSession(`other-${domain}`, profile, undefined, 'tenantA'),
        getOrCreateHttpSession(domain, profile, undefined, 'tenantA', 'cred-test'),
      ]);
      expect(new Set(sessions).size).toBe(4);
    } finally {
      await closeHttpSession(domain, 'tenantA');
      await closeHttpSession(domain, 'tenantB');
      await closeHttpSession(`other-${domain}`, 'tenantA');
      await closeHttpSession(domain, 'tenantA', 'cred-test');
    }
  });

  test('作成に失敗したら待っていた全員が失敗し、失敗は覚えない（次の取得は作り直す）', async () => {
    const domain = 'pool-fail.example';
    try {
      const bad = Array.from({ length: 3 }, () => fails(getOrCreateHttpSession(domain, 'no-such-browser' as never, undefined, 'tenantP')));
      expect(await Promise.all(bad)).toEqual([true, true, true]);
      const session = await getOrCreateHttpSession(domain, profile, undefined, 'tenantP');
      expect(typeof session.fetch).toBe('function');
      expect(await getOrCreateHttpSession(domain, profile, undefined, 'tenantP')).toBe(session);
    } finally {
      await closeHttpSession(domain, 'tenantP');
    }
  });

  test('保存済みの Cookie は作るときに戻り、資格情報付きの分離セッションには戻さない', async () => {
    const domain = 'pool-restore.example';
    dbSaveTenantCookies('tenantP', domain, [{ name: 'saved', value: 'v', domain }]);
    try {
      const [first, second] = await Promise.all([
        getOrCreateHttpSession(domain, profile, undefined, 'tenantP'),
        getOrCreateHttpSession(domain, profile, undefined, 'tenantP'),
      ]);
      expect(first.getAllCookies().map((cookie) => cookie.name)).toContain('saved');
      expect(second).toBe(first);
      const isolated = await getOrCreateHttpSession(domain, profile, undefined, 'tenantP', 'cred-test');
      expect(isolated.getAllCookies().map((cookie) => cookie.name)).not.toContain('saved');
    } finally {
      await closeHttpSession(domain, 'tenantP');
      await closeHttpSession(domain, 'tenantP', 'cred-test');
      dbSaveTenantCookies('tenantP', domain, []);
    }
  });

  test('閉じたあとの取得は、新しいセッションを作る（作成の途中の記録が残って、閉じたものを返さない）', async () => {
    const domain = 'pool-reopen.example';
    try {
      const first = await getOrCreateHttpSession(domain, profile, undefined, 'tenantP');
      await closeHttpSession(domain, 'tenantP');
      const second = await getOrCreateHttpSession(domain, profile, undefined, 'tenantP');
      expect(second).not.toBe(first);
    } finally {
      await closeHttpSession(domain, 'tenantP');
    }
  });
});
