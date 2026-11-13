// Tenant identity for multi-tenant isolation (RFC P1-SEC-01).
// Single-user deployments resolve to the shared 'legacy' tenant,
// preserving current behavior. Secrets are never used raw as IDs.
import { createHash, randomUUID } from 'crypto';

export type TenantAuthMode = 'anonymous' | 'api_key';

export interface TenantContext {
  tenantId: string;
  requestId: string;
  authMode: TenantAuthMode;
  /** 鍵ファイル（SORA_AUTH_KEYS_FILE）の name。名前つきの鍵の tenant だけ */
  name?: string;
  /**
   * 全体に効く操作（全員分のキャッシュの消去など）を許すか。鍵ファイルの鍵は、admin: true の鍵だけ。
   * 鍵ファイルを使わない運用（鍵が 1 つか、匿名）は、運用者と利用者が同じ 1 つの信頼の範囲なので、true
   */
  admin?: boolean;
}

export const LEGACY_TENANT_ID = 'legacy';

/**
 * 利用者を持たない取得（Sora が自分の都合で読むページ。GCC の商品ページ・trade の商品ページ・国の情報の記事）の範囲。
 * 保存済みの Cookie・localStorage を、読まず、書かない（db.ts）。tenant を渡さず legacy として動くと、鍵なしの利用者の保存済みの状態を、
 * 読んで、書き換えてしまうため。`name:`・`key:` の前置きが無いので、鍵や名前の tenant の ID と重ならない。
 */
export const PUBLIC_TENANT_ID = 'public';

// Anonymous requests share the legacy scope: per-user isolation is
// impossible without identity, and this preserves single-user behavior
// (pre-migration persisted state stays visible). authMode still
// distinguishes anonymous from keyed callers.

export function tenantIdForApiKey(key: string): string {
  return 'key:' + createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 鍵ファイルの name から作る tenant の ID。鍵でなく名前から作る（鍵を入れ替えても、tenant の状態が消えない）。
 * 前置きの `name:` が付くので、legacy・key:<鍵のハッシュ> と同じ ID にならない。
 */
export function tenantIdForName(name: string): string {
  return 'name:' + name;
}

export function resolveTenantContext(options: {
  apiKey?: string;
  /** 鍵ファイルの name（認証が、鍵から引いたもの） */
  tenantName?: string;
  /** 鍵ファイルの鍵の admin（認証が、鍵から引いたもの）。true のときだけ、管理者 */
  admin?: boolean;
  requestId?: string;
}): TenantContext {
  if (options.tenantName) {
    return {
      tenantId: tenantIdForName(options.tenantName),
      requestId: options.requestId ?? randomUUID(),
      authMode: 'api_key',
      name: options.tenantName,
      admin: options.admin === true,
    };
  }
  if (options.apiKey) {
    return {
      tenantId: tenantIdForApiKey(options.apiKey),
      requestId: options.requestId ?? randomUUID(),
      authMode: 'api_key',
      admin: true,
    };
  }
  return {
    tenantId: LEGACY_TENANT_ID,
    requestId: options.requestId ?? randomUUID(),
    authMode: 'anonymous',
    admin: true,
  };
}
