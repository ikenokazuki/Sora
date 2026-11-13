import { describe, expect, test } from 'bun:test';
import { resolveTenantContext, tenantIdForApiKey, tenantIdForName, LEGACY_TENANT_ID } from './tenant_context.js';

describe('tenant_context (P1-SEC-01)', () => {
  test('api key maps to stable hashed tenant, never raw', () => {
    const a = resolveTenantContext({ apiKey: 'secret-1' });
    const b = resolveTenantContext({ apiKey: 'secret-1' });
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.tenantId).not.toContain('secret-1');
    expect(a.authMode).toBe('api_key');
    expect(tenantIdForApiKey('secret-2')).not.toBe(a.tenantId);
  });
  test('anonymous shares legacy scope for single-user compat', () => {
    expect(resolveTenantContext({}).tenantId).toBe(LEGACY_TENANT_ID);
  });
  test('anonymous mode', () => {
    expect(resolveTenantContext({}).authMode).toBe('anonymous');
  });
  test('legacy constant exists for single-user default', () => {
    expect(LEGACY_TENANT_ID).toBe('legacy');
  });
  test('named key (key file): tenant id comes from the name, never from the key, and cannot collide with the other kinds', () => {
    const t = resolveTenantContext({ tenantName: 'alice' });
    expect(t).toMatchObject({ tenantId: 'name:alice', authMode: 'api_key', name: 'alice' });
    expect(tenantIdForName('alice')).toBe('name:alice');
    // legacy・key:<ハッシュ> と同じ ID にならない（name は英小文字・数字・-・_ だけで、前置きの name: が付く）
    for (const name of ['legacy', 'internal', 'key']) expect(tenantIdForName(name)).not.toBe(name);
    expect(tenantIdForName('legacy')).not.toBe(LEGACY_TENANT_ID);
    expect(tenantIdForName('alice')).not.toBe(tenantIdForApiKey('alice'));
    // 名前のない tenant には name の欄がない
    expect(resolveTenantContext({ apiKey: 'secret-1' })).not.toHaveProperty('name');
    expect(resolveTenantContext({})).not.toHaveProperty('name');
  });
  test('a name wins over a raw key', () => {
    expect(resolveTenantContext({ tenantName: 'alice', apiKey: 'secret-1' }).tenantId).toBe('name:alice');
  });
});

describe('admin（全体に効く操作を許すか）', () => {
  test('鍵ファイルの鍵: admin: true の鍵だけ。省くと、管理者ではない', () => {
    expect(resolveTenantContext({ tenantName: 'ops', admin: true }).admin).toBe(true);
    expect(resolveTenantContext({ tenantName: 'bob', admin: false }).admin).toBe(false);
    expect(resolveTenantContext({ tenantName: 'bob' }).admin).toBe(false);
  });

  test('鍵ファイルを使わない運用（鍵が 1 つ・匿名）は、1 つの信頼の範囲なので、管理者', () => {
    expect(resolveTenantContext({ apiKey: 'secret-1' }).admin).toBe(true);
    expect(resolveTenantContext({}).admin).toBe(true);
  });

  test('鍵ファイルの鍵では、admin の引数が真でなければ、管理者にならない（真偽値以外の truthy を、真と読まない）', () => {
    expect(resolveTenantContext({ tenantName: 'bob', admin: 'yes' as never }).admin).toBe(false);
  });
});
