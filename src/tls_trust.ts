import { X509Certificate } from 'node:crypto';

/**
 * 静的取得（wreq-js）が信頼しない root（証明書の SHA-256 の指紋。コロン無し・小文字）と、その理由。
 *
 * wreq-js の既定の信頼（trustStore: "combined"）は、同梱の Mozilla の root（wreq-js を作った時点のもの）に、システムの root を足したもの。
 * wreq-js の公開が止まっている間、同梱の root は古いままなので、あとから信頼を外された root が残る。
 */
export const DISTRUSTED_ROOTS: ReadonlyMap<string, string> = new Map([
  [
    '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    // 2026-10-20 に、連なる eMudhra の中間 CA 6 つ（TLS 用）の秘密鍵の漏えいが確認され、Mozilla が NSS から外した。
    // 鍵は復元され、一部は公開されている。経路上の攻撃者が、どのサーバーにもなりすませる
    'emSign ECC Root CA - G3 (eMudhra, 2026-10 key compromise)',
  ],
]);

export const TRUST_STORE_MODES = ['combined', 'mozilla', 'defaultPaths'] as const;
export type TrustStoreMode = (typeof TRUST_STORE_MODES)[number];

/**
 * SORA_FETCH_TRUST_STORE（静的取得の trustStore。未設定なら wreq-js の既定のまま）。
 * 公開イメージは、同梱の root を使わず、イメージのビルドで作った一覧（Debian の root と、Bun の最新の root から、
 * DISTRUSTED_ROOTS を除いたもの）だけを使うよう defaultPaths にしている。不正な値は無視する（既定のまま）。
 */
export function parseTrustStoreMode(raw: string | undefined): TrustStoreMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const mode = TRUST_STORE_MODES.find((m) => m.toLowerCase() === value.toLowerCase());
  if (!mode) console.warn(`[tls_trust] SORA_FETCH_TRUST_STORE=${JSON.stringify(value)} is not one of ${TRUST_STORE_MODES.join(', ')}; using the wreq-js default`);
  return mode;
}

/** PEM の束（ca-certificates.crt など）を、証明書ごとに分ける */
export function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

export const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

/**
 * 証明書の PEM の一覧から、重複を除き、distrusted に載った root を除いた PEM の束を作る。読めない証明書は捨てる。
 * removed には、実際に除いたものの理由を入れる（入力に無ければ空）。
 */
export function buildTrustBundle(pems: readonly string[], distrusted: ReadonlyMap<string, string> = DISTRUSTED_ROOTS): { pem: string; count: number; removed: string[] } {
  const seen = new Set<string>();
  const kept: string[] = [];
  const removed: string[] = [];
  for (const pem of pems) {
    let fingerprint: string;
    try {
      fingerprint = fingerprintOf(pem);
    } catch {
      continue;
    }
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const reason = distrusted.get(fingerprint);
    if (reason) removed.push(reason);
    else kept.push(pem.trim());
  }
  return { pem: `${kept.join('\n')}\n`, count: kept.length, removed };
}
