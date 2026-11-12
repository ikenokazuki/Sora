import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { buildTrustBundle, DISTRUSTED_ROOTS, fingerprintOf, parseTrustStoreMode, splitPem } from './tls_trust.js';

const fixtures = new URL('./test_fixtures/tls/', import.meta.url).pathname;
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const subjectsOf = (pem: string) => splitPem(pem).map((p) => new X509Certificate(p).subject);

describe('parseTrustStoreMode（SORA_FETCH_TRUST_STORE）', () => {
  // スパイは、テストごとに作って戻す。describe の直下で作って戻さないと、同じプロセスで後から走るほかのテスト（index.test.ts など）の
  // console.warn の記録に、このテストの呼び出しが混ざる（spyOn は、すでにあるスパイをそのまま返すため）
  let warn: ReturnType<typeof spyOn<Console, 'warn'>>;
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('未設定・空・空白だけは undefined（wreq-js の既定のまま）。警告も出さない', () => {
    for (const raw of [undefined, '', '  ']) expect(parseTrustStoreMode(raw)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test('3 つの値を受け付ける（大文字小文字・前後の空白は問わない）', () => {
    expect(parseTrustStoreMode('combined')).toBe('combined');
    expect(parseTrustStoreMode('MOZILLA')).toBe('mozilla');
    expect(parseTrustStoreMode(' defaultPaths ')).toBe('defaultPaths');
    expect(parseTrustStoreMode('defaultpaths')).toBe('defaultPaths');
    expect(warn).not.toHaveBeenCalled();
  });

  test('不正な値は undefined（既定のまま）にして、警告を 1 回出す。例外は投げない', () => {
    expect(parseTrustStoreMode('system')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SORA_FETCH_TRUST_STORE'));
  });
});

describe('DISTRUSTED_ROOTS', () => {
  test('emSign ECC Root CA - G3 の証明書（公開の root）の指紋と一致する', () => {
    const pem = read('emsign_ecc_root_ca_g3.pem');
    expect(new X509Certificate(pem).subject).toContain('emSign ECC Root CA - G3');
    const reason = DISTRUSTED_ROOTS.get(fingerprintOf(pem));
    expect(reason).toContain('emSign ECC Root CA - G3');
  });
});

describe('buildTrustBundle', () => {
  const [first, second] = tls.rootCertificates;

  test('重複を除き、読めない証明書は捨てる', () => {
    const { pem, count, removed } = buildTrustBundle([first, second, first, 'not a certificate', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----']);
    expect(count).toBe(2);
    expect(removed).toEqual([]);
    expect(splitPem(pem)).toHaveLength(2);
  });

  test('distrusted に載った root を除き、理由を返す。ほかは残す', () => {
    const target = fingerprintOf(first);
    const { pem, count, removed } = buildTrustBundle([first, second], new Map([[target, 'test distrust']]));
    expect(removed).toEqual(['test distrust']);
    expect(count).toBe(1);
    expect(pem).not.toContain(first.split('\n')[1]);
    expect(subjectsOf(pem)).toEqual([new X509Certificate(second).subject]);
  });

  test('既定の distrusted（emSign ECC Root CA - G3）を、入力にあれば除く', () => {
    const emsign = read('emsign_ecc_root_ca_g3.pem');
    const { pem, removed } = buildTrustBundle([first, emsign, second]);
    expect(removed).toEqual([DISTRUSTED_ROOTS.values().next().value as string]);
    expect(subjectsOf(pem).some((s) => s.includes('emSign ECC Root CA - G3'))).toBe(false);
  });

  test('この Bun の tls.rootCertificates から作った一覧は、基本の root を含み、漏れた root を含まない', () => {
    const { pem, count } = buildTrustBundle(tls.rootCertificates);
    expect(count).toBeGreaterThanOrEqual(100);
    const subjects = subjectsOf(pem);
    for (const name of ['ISRG Root X1', 'GlobalSign Root CA', 'Amazon Root CA 1']) expect(subjects.some((s) => s.includes(name))).toBe(true);
    expect(subjects.some((s) => s.includes('emSign ECC Root CA - G3'))).toBe(false);
  });
});

describe('scripts/build-ca-bundle.ts', () => {
  test('システムの一覧と Bun の root から、漏れた root を除いた一覧を書く', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-ca-bundle-'));
    try {
      const system = join(dir, 'system.crt');
      writeFileSync(system, `${read('emsign_ecc_root_ca_g3.pem')}\n${tls.rootCertificates[0]}\n`);
      const out = join(dir, 'out.pem');
      const script = new URL('../scripts/build-ca-bundle.ts', import.meta.url).pathname;
      const proc = Bun.spawn([process.execPath, script, system, out], { stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toContain('emSign ECC Root CA - G3');
      const subjects = subjectsOf(readFileSync(out, 'utf8'));
      expect(subjects.length).toBeGreaterThanOrEqual(100);
      expect(subjects.some((s) => s.includes('emSign ECC Root CA - G3'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * wreq-js の native は、起動時の環境変数（SSL_CERT_FILE）を読むので、子プロセスで確かめる。
 * 子（test_fixtures/tls/trust_probe_child.ts）は、Sora のセッションの作り方（getOrCreateHttpSession）で、テスト用の CA が
 * 署名した localhost の HTTPS サーバーに繋ぐ。
 */
describe('静的取得（wreq-js）が信頼する root の切り替え', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sora-trust-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const withoutTestCa = join(dir, 'public-roots-only.pem');
  writeFileSync(withoutTestCa, buildTrustBundle(tls.rootCertificates).pem);
  const testCa = join(fixtures, 'ca.pem');
  const child = join(fixtures, 'trust_probe_child.ts');

  async function probe(env: Record<string, string>): Promise<string> {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SSL_CERT_|SORA_FETCH_TRUST_STORE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)/i.test(k)));
    const proc = Bun.spawn([process.execPath, child], { env: { ...base, NODE_ENV: 'test', SORA_DB_PATH: ':memory:', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out.split('\n').find((line) => line.startsWith('RESULT ')) ?? `no RESULT: ${out}`;
  }

  test('既定（SORA_FETCH_TRUST_STORE なし）は、いままでと同じ: 同梱の root とシステムの root（SSL_CERT_FILE）を合わせて信頼する', async () => {
    expect(await probe({ SSL_CERT_FILE: testCa })).toBe('RESULT ok 200');
    expect(await probe({})).toBe('RESULT rejected CERTIFICATE_VERIFY_FAILED');
  }, 30_000);

  test('defaultPaths は、同梱の root を使わず、SSL_CERT_FILE の一覧だけを信頼する', async () => {
    expect(await probe({ SORA_FETCH_TRUST_STORE: 'defaultPaths', SSL_CERT_FILE: testCa })).toBe('RESULT ok 200');
    expect(await probe({ SORA_FETCH_TRUST_STORE: 'defaultPaths', SSL_CERT_FILE: withoutTestCa })).toBe('RESULT rejected CERTIFICATE_VERIFY_FAILED');
  }, 30_000);

  test('mozilla は、同梱の root だけ（SSL_CERT_FILE は使わない）', async () => {
    expect(await probe({ SORA_FETCH_TRUST_STORE: 'mozilla', SSL_CERT_FILE: testCa })).toBe('RESULT rejected CERTIFICATE_VERIFY_FAILED');
  }, 30_000);

  test('不正な値は無視して、既定のまま', async () => {
    expect(await probe({ SORA_FETCH_TRUST_STORE: 'nonsense', SSL_CERT_FILE: testCa })).toBe('RESULT ok 200');
  }, 30_000);
});
