import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseChromiumMajorVersion, readChromiumMajorVersion } from './browser_engine.js';
import { MAX_SUPPORTED_CHROME_PROFILE_VERSION, profileMajorFor } from './http_fetcher.js';

describe('parseChromiumMajorVersion（chromium --version の出力）', () => {
  test('Debian の Chromium・Google Chrome・Chrome for Testing の出力から、メジャーバージョンを取り出す', () => {
    expect(parseChromiumMajorVersion('Chromium 156.0.8078.79 built on Debian 12.12, running on Debian 12.12\n')).toBe(156);
    expect(parseChromiumMajorVersion('Chromium 156.0.8078.79 \n')).toBe(156);
    expect(parseChromiumMajorVersion('Google Chrome 149.0.7827.155 \n')).toBe(149);
    expect(parseChromiumMajorVersion('Chromium 148.0.7778.167 nixpkgs\n')).toBe(148);
    expect(parseChromiumMajorVersion('Google Chrome for Testing 141.0.7390.54 \n')).toBe(141);
  });

  test('版の数字が無ければ undefined', () => {
    expect(parseChromiumMajorVersion('')).toBeUndefined();
    expect(parseChromiumMajorVersion('chromium: command not found')).toBeUndefined();
  });
});

describe('readChromiumMajorVersion（実行ファイルに --version を問い合わせる）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sora-chromium-version-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test('--version の出力から版を返す（引数は --version だけ）', () => {
    const path = script('fake-chromium', 'if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then echo "Chromium 156.0.8078.79 built on Debian 12.12"; else echo "unexpected args" >&2; exit 2; fi');
    expect(readChromiumMajorVersion(path)).toBe(156);
  });

  test('シェルを経由せず、実行ファイルを直接起動する（bun 自身で確かめる）', () => {
    // execSync は /bin/sh を通すので、sh の無い distroless では起動できなかった。execFileSync は実行ファイルを直接起動する
    expect(readChromiumMajorVersion(process.execPath)).toBe(Number(process.versions.bun.split('.')[0]));
  });

  test('失敗（存在しない・数字が出ない・異常終了）は undefined。例外は投げない', () => {
    expect(readChromiumMajorVersion(join(dir, 'no-such-file'))).toBeUndefined();
    expect(readChromiumMajorVersion(script('no-version', 'echo "hello"'))).toBeUndefined();
    expect(readChromiumMajorVersion(script('fails', 'echo "Chromium 156.0.8078.79"; exit 1'))).toBeUndefined();
  });
});

describe('profileMajorFor（静的取得の wreq プロファイルの選び方）', () => {
  test('wreq の最大（149）より新しい実ブラウザは、最大になる。版の検出が直っても、いまの Debian の Chromium 156 の名乗りは 149 のまま', () => {
    expect(MAX_SUPPORTED_CHROME_PROFILE_VERSION).toBe(149);
    expect(profileMajorFor(156)).toBe(149);
    expect(profileMajorFor(157)).toBe(149);
    expect(profileMajorFor(200)).toBe(149);
  });

  test('範囲内は、その版（最も近いもの）。範囲より古いときは最小', () => {
    expect(profileMajorFor(149)).toBe(149);
    expect(profileMajorFor(148)).toBe(148);
    expect(profileMajorFor(141)).toBe(141);
    expect(profileMajorFor(136)).toBe(136);
    expect(profileMajorFor(120)).toBe(136);
  });

  test('版が分からなければ（検出に失敗）、wreq の最大', () => {
    expect(profileMajorFor(undefined)).toBe(MAX_SUPPORTED_CHROME_PROFILE_VERSION);
  });
});
