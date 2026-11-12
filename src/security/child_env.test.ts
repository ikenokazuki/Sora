import { describe, expect, test } from 'bun:test';
import { childEnv } from './child_env.js';

const SECRETS = {
  SORA_API_KEY: 'sk-sora',
  WEB_FETCHER_API_KEY: 'sk-legacy',
  API_KEY: 'sk-generic',
  UPS_CLIENT_SECRET: 'ups-secret',
  SORA_TRACKING_PAGE_SECRET: 'page-secret',
  ADMIN_ALERT_WEBHOOK_URL: 'https://hooks.example/T000/B000/xxxx',
  GITHUB_TOKEN: 'ghp_xxx',
  DATABASE_PASSWORD: 'hunter2',
};

describe('childEnv（子プロセスに渡す環境変数の許可リスト）', () => {
  test('運用者の秘密は渡さない（名前が秘密らしくなくても、許可リストに無いものは渡さない）', () => {
    const env = childEnv({}, { ...SECRETS, PORT: '8000', NODE_ENV: 'production', CHROME_PATH: '/usr/lib/chromium/chromium', FOO: 'bar' });
    expect(env).toEqual({});
  });

  test('実行ファイル・ロケール・時刻・フォントに要るものは渡す', () => {
    const source = { PATH: '/usr/bin', HOME: '/root', TMPDIR: '/tmp', TZ: 'UTC', LANG: 'ja_JP.UTF-8', LANGUAGE: 'ja', LC_ALL: 'C', LC_TIME: 'ja_JP.UTF-8', LD_LIBRARY_PATH: '/lib', FONTCONFIG_PATH: '/etc/fonts', XDG_CACHE_HOME: '/tmp/c' };
    expect(childEnv({}, { ...source, ...SECRETS })).toEqual(source);
  });

  test('外向きのプロキシと証明書は、大文字・小文字とも渡す（子プロセスの通信に使わせるため）', () => {
    const source = { HTTP_PROXY: 'http://p:3128', https_proxy: 'http://p:3128', ALL_PROXY: 'socks5://p:1080', no_proxy: 'localhost', SSL_CERT_FILE: '/etc/ssl/certs/ca.pem', SSL_CERT_DIR: '/etc/ssl/certs', NODE_EXTRA_CA_CERTS: '/ca.pem' };
    expect(childEnv({}, { ...source, ...SECRETS })).toEqual(source);
  });

  test('Go のランタイムの調整は渡す（Yahoo のバイナリ）', () => {
    const source = { GOMEMLIMIT: '256MiB', GOGC: '50', GOMAXPROCS: '2', GODEBUG: 'madvdontneed=1' };
    expect(childEnv({}, { ...source, ...SECRETS })).toEqual(source);
  });

  test('extra は上書きして足す。undefined は消す', () => {
    const env = childEnv({ TZ: 'Asia/Tokyo', HOME: undefined, FOO: 'x' }, { PATH: '/usr/bin', TZ: 'UTC', HOME: '/root' });
    expect(env).toEqual({ PATH: '/usr/bin', TZ: 'Asia/Tokyo', FOO: 'x' });
  });

  test('元の環境変数を書き換えない', () => {
    const source = { PATH: '/usr/bin', SORA_API_KEY: 'sk' };
    childEnv({ TZ: 'UTC' }, source);
    expect(source).toEqual({ PATH: '/usr/bin', SORA_API_KEY: 'sk' });
  });

  test('値が undefined の環境変数は渡さない', () => {
    expect(childEnv({}, { PATH: undefined, TZ: 'UTC' })).toEqual({ TZ: 'UTC' });
  });
});
