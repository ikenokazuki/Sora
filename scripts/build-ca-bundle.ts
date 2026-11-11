/**
 * 静的取得（wreq-js）が信頼する root の一覧を作る: システムの root（Debian の ca-certificates.crt など）と、この Bun が持つ
 * 最新の root（tls.rootCertificates）を合わせ、重複と、信頼を外した root（src/tls_trust.ts の DISTRUSTED_ROOTS）を除く。
 * 公開イメージのビルドで、イメージの /etc/ssl/certs/ca-certificates.crt を、これで置き換える（Containerfile）。
 *
 * 使い方: bun scripts/build-ca-bundle.ts <システムの root の PEM の束> <出力のファイル>
 * 終了コード: 一覧が小さすぎる（100 件未満）か、基本の root（ISRG Root X1・GlobalSign Root CA・Amazon Root CA 1）が欠けていれば 1。
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import { buildTrustBundle, splitPem } from '../src/tls_trust.js';

const [systemPath, outPath] = process.argv.slice(2);
if (!systemPath || !outPath) {
  console.error('usage: bun scripts/build-ca-bundle.ts <system CA bundle (PEM)> <output file>');
  process.exit(2);
}

const system = splitPem(readFileSync(systemPath, 'utf8'));
const { pem, count, removed } = buildTrustBundle([...system, ...tls.rootCertificates]);

const subjects = splitPem(pem).map((p) => new X509Certificate(p).subject);
const required = ['ISRG Root X1', 'GlobalSign Root CA', 'Amazon Root CA 1'];
const missing = required.filter((name) => !subjects.some((s) => s.includes(name)));
if (count < 100 || missing.length > 0) {
  console.error(`refusing to write a suspicious bundle: ${count} roots, missing: ${missing.join(', ') || '-'}`);
  process.exit(1);
}

writeFileSync(outPath, pem);
console.log(`CA bundle: ${count} roots (system ${system.length} + bun ${tls.rootCertificates.length}, deduplicated); distrusted and removed: ${removed.join('; ') || 'none in the input'} -> ${outPath}`);
