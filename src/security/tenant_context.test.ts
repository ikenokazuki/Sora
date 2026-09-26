import { describe, expect, test } from 'bun:test';
import { resolveTenantContext, tenantIdForApiKey, LEGACY_TENANT_ID } from './tenant_context.js';

describe('tenant_context (P1-SEC-01)', () => {
  test('api key maps to stable hashed tenant, never raw', () => {
    const a = resolveTenantContext({ apiKey: 'secret-1' });
    const b = resolveTenantContext({ apiKey: 'secret-1' });
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.tenantId).not.toContain('secret-1');
    expect(a.authMode).toBe('api_key');
    expect(tenantIdForApiKey('secret-2')).not.toBe(a.tenantId);
  });
  test('anonymous and internal modes', () => {
    expect(resolveTenantContext({}).authMode).toBe('anonymous');
    expect(resolveTenantContext({ internal: true }).tenantId).toBe('internal');
  });
  test('legacy constant exists for single-user default', () => {
    expect(LEGACY_TENANT_ID).toBe('legacy');
  });
});
