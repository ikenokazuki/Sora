import { describe, expect, test } from 'bun:test';
import { chromiumEnv, STEALTH_TIMEZONE } from './browser_engine.js';

describe('chromiumEnv（Chromium に渡す環境変数）', () => {
  test('運用者の秘密を渡さず、TZ はステルスのタイムゾーンにする。実行・描画・外向きのプロキシに要るものは渡す', () => {
    const env = chromiumEnv({
      PATH: '/usr/bin',
      HOME: '/root',
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      SORA_API_KEY: 'sk-secret',
      UPS_CLIENT_SECRET: 'ups-secret',
      ADMIN_ALERT_WEBHOOK_URL: 'https://hooks.example/T0/B0/x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/root', TZ: STEALTH_TIMEZONE, LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy:3128' });
  });
});
