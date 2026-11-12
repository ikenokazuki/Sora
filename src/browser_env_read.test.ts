import { describe, expect, test } from 'bun:test';
import { browserCdpMode } from './browser_engine.js';
import { planBrowserLaunch } from './browser_launch_plan.js';
import { withEnv } from './test_fixtures/env.js';

// 登録簿（config.ts）の読み口は、env を省くと、プロセスの環境を読む。起動する側（browser_engine.ts）は env を渡さないので、
// 設定がプロセスの環境から届くことを、ここで確かめる（env を渡す形は、browser_cdp_mode.test.ts と browser_launch_plan.test.ts）
describe('ブラウザの隔離の設定は、env を省くと、プロセスの環境を読む', () => {
  const base = { currentUid: 0 as number | undefined, launcherExists: true, nodeEnv: 'production' as string | undefined };

  test('SORA_BROWSER_PIPE は、パイプかポートを決める。未設定なら、Bun の版で決める', async () => {
    await withEnv({ SORA_BROWSER_PIPE: 'false' }, () => expect(browserCdpMode(undefined, '1.4.4')).toBe('port'));
    await withEnv({ SORA_BROWSER_PIPE: 'true' }, () => expect(browserCdpMode(undefined, '1.3.3')).toBe('pipe'));
    await withEnv({ SORA_BROWSER_PIPE: undefined }, () => {
      expect(browserCdpMode(undefined, '1.4.4')).toBe('pipe');
      expect(browserCdpMode(undefined, '1.3.3')).toBe('port');
    });
  });

  test('SORA_BROWSER_UID は、落とすかどうかと落とし先を、SORA_BROWSER_SANDBOX は、サンドボックスの方針を決める', async () => {
    await withEnv({ SORA_BROWSER_UID: 'off', SORA_BROWSER_SANDBOX: undefined }, () => {
      expect(planBrowserLaunch(base).plan).toEqual({ drop: null, sandbox: 'none' });
    });
    await withEnv({ SORA_BROWSER_UID: '10001', SORA_BROWSER_SANDBOX: 'on' }, () => {
      const { plan } = planBrowserLaunch(base);
      expect(plan.drop?.uid).toBe(10001);
      expect(plan.sandbox).toBe('require');
    });
    await withEnv({ SORA_BROWSER_UID: undefined, SORA_BROWSER_SANDBOX: undefined }, () => {
      expect(planBrowserLaunch(base).plan.drop?.uid).toBe(65532);
    });
  });
});
