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
