import { afterAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, getChromiumMajorVersion, resolveChromiumPath } from '../../src/browser_engine.js';
import { profileMajorFor } from '../../src/http_fetcher.js';
import { diffHellos } from './client_hello.js';
import { captureBrowserHello, captureWreqHello } from './run.js';

/**
 * Chromium 150 以降は、署名アルゴリズムの先頭に ML-DSA（0x0904〜0x0906）を足す。止める機能名が無く（browser_engine.ts）、
 * wreq-js に入っている BoringSSL が ML-DSA を知らない（npm の wreq-js の native。scripts/tls-fingerprint/probe_sigalgs_override.ts）ので、
 * wreq のプロファイルが 150 未満で、Chromium が 150 以上だと、この差が残る既知の差になる。
 * 自前でビルドした native（上流の wreq-util の 150 以上のプロファイル）は、ML-DSA も送るので、この差は無くなる。
 */
const ML_DSA = [0x0904, 0x0905, 0x0906];

describe.skipIf(!resolveChromiumPath())('ブラウザ（Sora が起動する Chromium）と静的取得（wreq-js）の ClientHello', () => {
  afterAll(closeSharedBrowser);

  test('全項目が同じ。プロファイルが 150 未満で Chromium が 150 以上のときだけ、既知の差（ML-DSA）が残る', async () => {
    const engine = getChromiumMajorVersion();
    const profile = profileMajorFor(engine);
    const differences = diffHellos(await captureBrowserHello(), await captureWreqHello());
    if (engine !== undefined && engine >= 150 && profile < 150) {
      const unexpected = differences.filter(
        (d) => !(d.field === 'signatureAlgorithms' && JSON.stringify(d.browser) === JSON.stringify([...ML_DSA, ...(d.wreq as Array<number | 'GREASE'>)])),
      );
      expect(unexpected).toEqual([]);
    } else {
      expect(differences).toEqual([]);
    }
  }, 90_000);
});
