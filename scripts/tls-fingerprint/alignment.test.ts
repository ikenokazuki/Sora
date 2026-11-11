import { afterAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, getChromiumMajorVersion, resolveChromiumPath } from '../../src/browser_engine.js';
import { MAX_SUPPORTED_CHROME_PROFILE_VERSION } from '../../src/http_fetcher.js';
import { diffHellos } from './client_hello.js';
import { captureBrowserHello, captureWreqHello } from './run.js';

/**
 * Chromium 150 以降は、署名アルゴリズムの先頭に ML-DSA（0x0904〜0x0906）を足す。止める機能名が無く（browser_engine.ts）、
 * wreq-js に入っている BoringSSL も ML-DSA を知らない（scripts/tls-fingerprint/probe_sigalgs_override.ts）ので、
 * wreq のプロファイルの最大より新しい Chromium では、この差が残る既知の差になる。
 */
const ML_DSA = [0x0904, 0x0905, 0x0906];

describe.skipIf(!resolveChromiumPath())('ブラウザ（Sora が起動する Chromium）と静的取得（wreq-js）の ClientHello', () => {
  afterAll(closeSharedBrowser);

  test('wreq のプロファイルの範囲内の Chromium は全項目が同じ。範囲より新しい Chromium は、既知の差（ML-DSA）だけ', async () => {
    const engine = getChromiumMajorVersion();
    const differences = diffHellos(await captureBrowserHello(), await captureWreqHello());
    if (engine !== undefined && engine > MAX_SUPPORTED_CHROME_PROFILE_VERSION) {
      const unexpected = differences.filter(
        (d) => !(d.field === 'signatureAlgorithms' && JSON.stringify(d.browser) === JSON.stringify([...ML_DSA, ...(d.wreq as number[])])),
      );
      expect(unexpected).toEqual([]);
    } else {
      expect(differences).toEqual([]);
    }
  }, 90_000);
});
