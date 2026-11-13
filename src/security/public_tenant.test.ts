import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dbGetTenantCookies, dbGetTenantStorage, dbSaveTenantCookies, dbSaveTenantStorage, getDb } from '../db.js';
import { closeHttpSession } from '../http_fetcher.js';
import { scrapeUrl } from '../scraper.js';
import { LEGACY_TENANT_ID, PUBLIC_TENANT_ID } from './tenant_context.js';

/**
 * public の tenant（設計 5。穴 17）: 利用者を持たない取得（GCC・trade・国の情報など、Sora が自分の都合で読むページ）の範囲。
 * 保存済みの Cookie・localStorage を、読まず、書かない。これまでは、tenant を渡さず legacy として動き、
 * 鍵なしの利用者（legacy）の保存済みの状態を、読んで、書き換えていた。
 */

const rows = (table: 'domain_cookies_v2' | 'domain_storage_v2', tenantId: string): number =>
  getDb().query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId)?.n ?? 0;

let cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

describe('public の tenant は、保存済みの状態を持たない', () => {
  test('定数。legacy や、鍵・名前の tenant の ID と重ならない', () => {
    expect(PUBLIC_TENANT_ID).toBe('public');
    expect(PUBLIC_TENANT_ID).not.toBe(LEGACY_TENANT_ID);
    expect(PUBLIC_TENANT_ID.startsWith('key:') || PUBLIC_TENANT_ID.startsWith('name:')).toBe(false);
  });

  test('Cookie・localStorage を保存しても、何も残らない。ほかの tenant は、これまでどおり保存できる', () => {
    dbSaveTenantCookies(PUBLIC_TENANT_ID, 'public-dao.example', [{ name: 's', value: '1' }]);
    dbSaveTenantStorage(PUBLIC_TENANT_ID, 'public-dao.example', { k: 'v' });
    expect(rows('domain_cookies_v2', PUBLIC_TENANT_ID)).toBe(0);
    expect(rows('domain_storage_v2', PUBLIC_TENANT_ID)).toBe(0);

    dbSaveTenantCookies('name:public-dao-alice', 'public-dao.example', [{ name: 's', value: 'A' }]);
    dbSaveTenantStorage('name:public-dao-alice', 'public-dao.example', { k: 'A' });
    expect(dbGetTenantCookies('name:public-dao-alice', 'public-dao.example')?.[0]?.value).toBe('A');
    expect(dbGetTenantStorage('name:public-dao-alice', 'public-dao.example')).toEqual({ k: 'A' });
    dbSaveTenantCookies('name:public-dao-alice', 'public-dao.example', []);
    dbSaveTenantStorage('name:public-dao-alice', 'public-dao.example', {});
  });

  test('すでに行があっても（旧い DB など）、読まない', () => {
    getDb().query(`INSERT INTO domain_cookies_v2 (tenant_id, domain, scope, cookies_json, updated_at) VALUES (?, ?, 'default', ?, ?)`).run(PUBLIC_TENANT_ID, 'public-dao-old.example', JSON.stringify([{ name: 's', value: 'old' }]), Date.now());
    getDb().query(`INSERT INTO domain_storage_v2 (tenant_id, domain, scope, storage_json, updated_at) VALUES (?, ?, 'default', ?, ?)`).run(PUBLIC_TENANT_ID, 'public-dao-old.example', JSON.stringify({ k: 'old' }), Date.now());
    cleanup.push(() => {
      getDb().query('DELETE FROM domain_cookies_v2 WHERE tenant_id = ?').run(PUBLIC_TENANT_ID);
      getDb().query('DELETE FROM domain_storage_v2 WHERE tenant_id = ?').run(PUBLIC_TENANT_ID);
    });
    expect(dbGetTenantCookies(PUBLIC_TENANT_ID, 'public-dao-old.example')).toBeUndefined();
    expect(dbGetTenantStorage(PUBLIC_TENANT_ID, 'public-dao-old.example')).toBeUndefined();
  });
});

describe('public の tenant の取得は、サイトが出した Cookie を、あとの取得に引き継がない', () => {
  const page = '<html><head><title>t</title></head><body><main><p>公開のページの本文です。読めるだけの長さの文章を、ここに置いておきます。抽出器が本文として扱うのに足ります。</p></main></body></html>';

  test('セッションを閉じたあと（保存の機会）の次の取得に、Cookie が付かない。ほかの tenant は、引き継ぐ', async () => {
    const previous = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.cookie);
      response.writeHead(200, { 'content-type': 'text/html', 'Set-Cookie': `sess=${seen.length}; Path=/` });
      response.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jar`;
    cleanup.push(async () => {
      server.close();
      for (const tenantId of [PUBLIC_TENANT_ID, 'name:public-e2e-alice']) await closeHttpSession('127.0.0.1', tenantId).catch(() => {});
      dbSaveTenantCookies('name:public-e2e-alice', '127.0.0.1', []);
      if (previous === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
      else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previous;
    });
    const fetchAs = (tenantId: string) => scrapeUrl({ url, noCache: true, tenantId, mode: 'fast', formats: ['markdown'] });

    await fetchAs(PUBLIC_TENANT_ID);
    await closeHttpSession('127.0.0.1', PUBLIC_TENANT_ID);
    await fetchAs(PUBLIC_TENANT_ID);
    expect(seen).toEqual([undefined, undefined]);
    expect(rows('domain_cookies_v2', PUBLIC_TENANT_ID)).toBe(0);

    // 対照: 名前つきの tenant は、閉じたあとも、保存した Cookie を引き継ぐ
    await fetchAs('name:public-e2e-alice');
    await closeHttpSession('127.0.0.1', 'name:public-e2e-alice');
    await fetchAs('name:public-e2e-alice');
    expect(seen[2]).toBeUndefined();
    expect(seen[3]).toContain('sess=');
  });
});
