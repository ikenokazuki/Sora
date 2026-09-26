import { describe, expect, test } from 'bun:test';
import { sessionKey, getOrCreateHttpSession, closeHttpSession } from '../http_fetcher.js';
import { dbSaveTenantCookies, dbGetTenantCookies, dbSaveDomainCookies, dbGetDomainCookies } from '../db.js';

describe('tenant isolation (P1-SEC-02)', () => {
  test('sessionKey scopes by tenant and host', () => {
    expect(sessionKey('a', 'Example.COM')).toBe('a:example.com');
    expect(sessionKey('a', 'example.com')).not.toBe(sessionKey('b', 'example.com'));
    expect(sessionKey('', 'example.com')).toBe('legacy:example.com');
  });
  test('tenants get separate sessions, same tenant reuses', async () => {
    const s1 = await getOrCreateHttpSession('tenant-iso-test.example', 'chrome_142', undefined, 'tenantA');
    const s1b = await getOrCreateHttpSession('tenant-iso-test.example', 'chrome_142', undefined, 'tenantA');
    const s2 = await getOrCreateHttpSession('tenant-iso-test.example', 'chrome_142', undefined, 'tenantB');
    expect(s1b).toBe(s1);
    expect(s2).not.toBe(s1);
    await closeHttpSession('tenant-iso-test.example', 'tenantA');
    await closeHttpSession('tenant-iso-test.example', 'tenantB');
  });
  test('legacy default still reuses single-user session', async () => {
    const s1 = await getOrCreateHttpSession('tenant-legacy-test.example', 'chrome_142');
    const s2 = await getOrCreateHttpSession('tenant-legacy-test.example', 'chrome_142');
    expect(s2).toBe(s1);
    await closeHttpSession('tenant-legacy-test.example');
  });
  test('cookies are tenant-scoped with legacy fallback', () => {
    dbSaveTenantCookies('tenantA', 'ck-iso.example', [{ name: 's', value: 'A' } as any]);
    dbSaveTenantCookies('tenantB', 'ck-iso.example', [{ name: 's', value: 'B' } as any]);
    expect(dbGetTenantCookies('tenantA', 'ck-iso.example')?.[0]?.value).toBe('A');
    expect(dbGetTenantCookies('tenantB', 'ck-iso.example')?.[0]?.value).toBe('B');
    dbSaveDomainCookies('ck-legacy.example', [{ name: 's', value: 'L' } as any]);
    expect(dbGetDomainCookies('ck-legacy.example')?.[0]?.value).toBe('L');
    expect(dbGetTenantCookies('tenantA', 'ck-legacy.example')).toBeUndefined();
    dbSaveTenantCookies('tenantA', 'ck-iso.example', []);
    dbSaveTenantCookies('tenantB', 'ck-iso.example', []);
  });
});
