/**
 * 確かめる実験: wreq-js の emulation.tlsOptions.sigalgsList で、chrome_149 の署名アルゴリズムに ML-DSA（0x0904〜0x0906）を足せるか。
 * 使い方: bun scripts/tls-fingerprint/probe_sigalgs_override.ts
 * 結果（wreq-js 3.2.0）: 並びの上書きは効く（chrome_149 の並びをそのまま再現できる）。ML-DSA は、どの名前の書き方でも
 * createSession が INVALID_SIGNATURE_ALGORITHM で拒否する（wreq-js に入っている BoringSSL が、ML-DSA を知らない）。
 * wreq-js を更新したあとに、ML-DSA が通るようになったかを確かめるのに使う。
 */
import { createSession } from 'wreq-js';
import { startCaptureServer } from './capture.js';

const base = 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512';
const candidates: Record<string, string> = {
  'base（chrome_149 と同じ並び）': base,
  'mldsa44:mldsa65:mldsa87 + base': `mldsa44:mldsa65:mldsa87:${base}`,
  'MLDSA44:MLDSA65:MLDSA87 + base': `MLDSA44:MLDSA65:MLDSA87:${base}`,
  'mldsa_44:mldsa_65:mldsa_87 + base': `mldsa_44:mldsa_65:mldsa_87:${base}`,
};
for (const [label, sigalgsList] of Object.entries(candidates)) {
  const server = await startCaptureServer();
  try {
    let session: Awaited<ReturnType<typeof createSession>>;
    try {
      session = await createSession({ browser: 'chrome_149', os: 'windows', emulation: { tlsOptions: { sigalgsList } } });
    } catch (e) {
      console.log(label.padEnd(36), 'createSession が拒否: ' + String((e as Error).message).slice(0, 110));
      continue;
    }
    let err = '';
    void session.fetch(`https://localhost:${server.port}/`, { timeout: 8000 }).catch((e: Error) => { err = String(e.message).slice(0, 100); });
    const hello = await server.next(8000).catch((e: Error) => { err ||= e.message; return null; });
    console.log(label.padEnd(36), hello ? 'sigalgs=' + JSON.stringify(hello.signatureAlgorithms) : 'NO HELLO ' + err);
    await session.close().catch(() => {});
  } finally { await server.close(); }
}
process.exit(0);
