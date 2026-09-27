// Tenant identity for multi-tenant isolation (RFC P1-SEC-01).
// Single-user deployments resolve to the shared 'legacy' tenant,
// preserving current behavior. Secrets are never used raw as IDs.
import { createHash, randomUUID } from 'crypto';

export type TenantAuthMode = 'anonymous' | 'api_key' | 'internal';

export interface TenantContext {
  tenantId: string;
  requestId: string;
  authMode: TenantAuthMode;
}

export const LEGACY_TENANT_ID = 'legacy';

// Anonymous requests share the legacy scope: per-user isolation is
// impossible without identity, and this preserves single-user behavior
// (pre-migration persisted state stays visible). authMode still
// distinguishes anonymous from keyed/internal callers.

export function tenantIdForApiKey(key: string): string {
  return 'key:' + createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function resolveTenantContext(options: {
  apiKey?: string;
  internal?: boolean;
  requestId?: string;
}): TenantContext {
  if (options.internal) {
    return {
      tenantId: 'internal',
      requestId: options.requestId ?? randomUUID(),
      authMode: 'internal',
    };
  }
  if (options.apiKey) {
    return {
      tenantId: tenantIdForApiKey(options.apiKey),
      requestId: options.requestId ?? randomUUID(),
      authMode: 'api_key',
    };
  }
  return {
    tenantId: LEGACY_TENANT_ID,
    requestId: options.requestId ?? randomUUID(),
    authMode: 'anonymous',
  };
}
