import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BROWSER_UID,
  DEFAULT_LAUNCHER,
  createProfileDir,
  planBrowserLaunch,
  removeProfileDir,
  SandboxFallback,
  withoutNoSandbox,
} from './browser_launch_plan.js';

const base = { env: {}, currentUid: 0 as number | undefined, launcherExists: true, nodeEnv: 'production' as string | undefined };

describe('planBrowserLaunch（別 uid で起動するか・サンドボックスを使うか）', () => {
  test('root で、起動用バイナリがあれば、既定の uid（65532）に落として起動し、サンドボックスは試す', () => {
    const { plan, warnings } = planBrowserLaunch(base);
    expect(plan).toEqual({ drop: { uid: DEFAULT_BROWSER_UID, gid: DEFAULT_BROWSER_UID, launcher: DEFAULT_LAUNCHER }, sandbox: 'try' });
    expect(DEFAULT_BROWSER_UID).toBe(65532);
    expect(warnings).toEqual([]);
  });

  test('root で、起動用バイナリがなければ、落とせない。root の Chromium はサンドボックスを使えないので、従来どおり（--no-sandbox）', () => {
    expect(planBrowserLaunch({ ...base, launcherExists: false }).plan).toEqual({ drop: null, sandbox: 'none' });
  });

  test('SORA_BROWSER_UID=off（大文字小文字・前後の空白は問わない）で、落とさない（従来どおり root・--no-sandbox）', () => {
    expect(planBrowserLaunch({ ...base, env: { SORA_BROWSER_UID: ' OFF ' } }).plan).toEqual({ drop: null, sandbox: 'none' });
  });

  test('SORA_BROWSER_UID に数を入れると、その uid・gid に落とす', () => {
    expect(planBrowserLaunch({ ...base, env: { SORA_BROWSER_UID: '10001' } }).plan.drop).toEqual({ uid: 10001, gid: 10001, launcher: DEFAULT_LAUNCHER });
  });

  test('不正な SORA_BROWSER_UID（数でない・0・負・大きすぎる）は、既定に戻して警告する', () => {
    for (const bad of ['abc', '0', '-5', '4294967295', '1.5', '65532x']) {
      const { plan, warnings } = planBrowserLaunch({ ...base, env: { SORA_BROWSER_UID: bad } });
      expect(plan.drop?.uid, bad).toBe(DEFAULT_BROWSER_UID);
      expect(warnings.join('\n'), bad).toContain('SORA_BROWSER_UID');
    }
  });

  test('root でなければ、落とさず、サンドボックスを試す', () => {
    expect(planBrowserLaunch({ ...base, currentUid: 1000 }).plan).toEqual({ drop: null, sandbox: 'try' });
    expect(planBrowserLaunch({ ...base, currentUid: 1000, launcherExists: false }).plan).toEqual({ drop: null, sandbox: 'try' });
  });

  test('uid が分からない環境（Windows など）は、落とさず、サンドボックスを試す', () => {
    expect(planBrowserLaunch({ ...base, currentUid: undefined }).plan).toEqual({ drop: null, sandbox: 'try' });
  });

  test('SORA_BROWSER_SANDBOX=off で、サンドボックスを使わない（落とす設定はそのまま）', () => {
    expect(planBrowserLaunch({ ...base, env: { SORA_BROWSER_SANDBOX: 'off' } }).plan).toEqual({
      drop: { uid: 65532, gid: 65532, launcher: DEFAULT_LAUNCHER },
      sandbox: 'none',
    });
  });

  test('SORA_BROWSER_SANDBOX=on は、使えなければ起動を失敗させる。root のまま（落とせない）なら、有効にできないので、計画の時点で例外', () => {
    expect(planBrowserLaunch({ ...base, env: { SORA_BROWSER_SANDBOX: 'on' } }).plan.sandbox).toBe('require');
    expect(planBrowserLaunch({ ...base, currentUid: 1000, env: { SORA_BROWSER_SANDBOX: 'on' } }).plan.sandbox).toBe('require');
    expect(() => planBrowserLaunch({ ...base, launcherExists: false, env: { SORA_BROWSER_SANDBOX: 'on' } })).toThrow('SORA_BROWSER_SANDBOX=on');
    expect(() => planBrowserLaunch({ ...base, env: { SORA_BROWSER_SANDBOX: 'on', SORA_BROWSER_UID: 'off' } })).toThrow('SORA_BROWSER_SANDBOX=on');
  });

  test('SORA_BROWSER_SANDBOX の不正な値は、auto として警告する。未設定は auto', () => {
    const { plan, warnings } = planBrowserLaunch({ ...base, env: { SORA_BROWSER_SANDBOX: 'maybe' } });
    expect(plan.sandbox).toBe('try');
    expect(warnings.join('\n')).toContain('SORA_BROWSER_SANDBOX');
    expect(planBrowserLaunch({ ...base, env: { SORA_BROWSER_SANDBOX: 'auto' } }).plan.sandbox).toBe('try');
  });

  test('テスト（NODE_ENV=test）の既定はサンドボックスなし（全テストの挙動を変えない）。明示すれば、テストでも試せる', () => {
    expect(planBrowserLaunch({ ...base, nodeEnv: 'test', currentUid: 1000 }).plan.sandbox).toBe('none');
    expect(planBrowserLaunch({ ...base, nodeEnv: 'test', currentUid: 1000, env: { SORA_BROWSER_SANDBOX: 'auto' } }).plan.sandbox).toBe('try');
  });
});

describe('withoutNoSandbox', () => {
  test('--no-sandbox と --disable-setuid-sandbox だけを外す。元の配列は書き換えない', () => {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080'];
    expect(withoutNoSandbox(args)).toEqual(['--disable-dev-shm-usage', '--window-size=1920,1080']);
    expect(args).toHaveLength(4);
  });
});

describe('プロファイルのディレクトリ（別 uid の Chromium が書ける場所）', () => {
  test('一時ディレクトリを作り、落とし先の uid・gid に chown して、0700 にする', () => {
    const calls: string[] = [];
    const dir = createProfileDir(
      { uid: 65532, gid: 65532 },
      {
        mkdtemp: (prefix) => {
          calls.push(`mkdtemp ${prefix}`);
          return `${prefix}ABC123`;
        },
        chown: (path, uid, gid) => calls.push(`chown ${path} ${uid}:${gid}`),
        chmod: (path, mode) => calls.push(`chmod ${path} ${mode.toString(8)}`),
      },
    );
    expect(dir).toMatch(/sora-chromium-ABC123$/);
    expect(calls).toEqual([expect.stringMatching(/^mkdtemp .*sora-chromium-$/), `chown ${dir} 65532:65532`, `chmod ${dir} 700`]);
  });

  test('chown が失敗したら、作ったディレクトリを消して、例外を投げる', () => {
    const removed: string[] = [];
    expect(() =>
      createProfileDir(
        { uid: 65532, gid: 65532 },
        {
          mkdtemp: (prefix) => `${prefix}X`,
          chown: () => {
            throw new Error('EPERM');
          },
          chmod: () => {},
          remove: (path) => removed.push(path),
        },
      ),
    ).toThrow('EPERM');
    expect(removed).toEqual([expect.stringMatching(/sora-chromium-X$/)]);
  });

  test('removeProfileDir は、無いディレクトリでも例外にしない', () => {
    expect(() => removeProfileDir('/tmp/sora-chromium-does-not-exist-xyz')).not.toThrow();
  });
});

describe('SandboxFallback（サンドボックスを試して、起動できなければ戻す）', () => {
  const failure = new Error('No usable sandbox!');

  test('none: サンドボックスなしで 1 回だけ起動する', async () => {
    const fallback = new SandboxFallback();
    const calls: boolean[] = [];
    const launch = async (sandbox: boolean) => {
      calls.push(sandbox);
      return 'browser';
    };
    expect(await fallback.launch('none', launch, () => {})).toBe('browser');
    expect(calls).toEqual([false]);
    expect(fallback.status()).toBe('off');
  });

  test('require: サンドボックスありで起動する。失敗はそのまま投げ、戻さない', async () => {
    const fallback = new SandboxFallback();
    const calls: boolean[] = [];
    const launch = async (sandbox: boolean): Promise<string> => {
      calls.push(sandbox);
      throw failure;
    };
    const error = await fallback.launch('require', launch, () => {}).catch((e: unknown) => e);
    // 元の文も、SORA_BROWSER_SANDBOX=on のせいだという説明も、読める
    expect((error as Error).message).toContain('SORA_BROWSER_SANDBOX=on');
    expect((error as Error).message).toContain('No usable sandbox');
    expect(((error as Error).cause as Error).message).toBe('No usable sandbox!');
    expect(calls).toEqual([true]);
  });

  test('try で起動できたら、サンドボックスあり。次からは、試さずに、そのまま使う', async () => {
    const fallback = new SandboxFallback();
    const calls: boolean[] = [];
    const launch = async (sandbox: boolean) => {
      calls.push(sandbox);
      return 'browser';
    };
    await fallback.launch('try', launch, () => {});
    await fallback.launch('try', launch, () => {});
    expect(calls).toEqual([true, true]);
    expect(fallback.status()).toBe('on');
  });

  test('try で起動できなければ、警告して、サンドボックスなしで起動し直す。次からは、試さずに、なしで起動する', async () => {
    const fallback = new SandboxFallback();
    const calls: boolean[] = [];
    const warnings: string[] = [];
    const launch = async (sandbox: boolean) => {
      calls.push(sandbox);
      if (sandbox) throw failure;
      return 'browser';
    };
    expect(await fallback.launch('try', launch, (message) => warnings.push(message))).toBe('browser');
    expect(await fallback.launch('try', launch, (message) => warnings.push(message))).toBe('browser');
    expect(calls).toEqual([true, false, false]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('No usable sandbox');
    expect(fallback.status()).toBe('off');
  });

  test('try で、サンドボックスなしでも起動できなければ、その例外を投げる。戻すとは決めず、警告も出さず、次の起動で、もう一度サンドボックスから試す', async () => {
    const fallback = new SandboxFallback();
    const calls: boolean[] = [];
    const warnings: string[] = [];
    let broken = true;
    const launch = async (sandbox: boolean) => {
      calls.push(sandbox);
      if (broken) throw new Error('missing library');
      return 'browser';
    };
    await expect(fallback.launch('try', launch, (message) => warnings.push(message))).rejects.toThrow('missing library');
    expect(calls).toEqual([true, false]);
    expect(warnings).toEqual([]);
    expect(fallback.status()).toBe('unknown');
    broken = false;
    expect(await fallback.launch('try', launch, (message) => warnings.push(message))).toBe('browser');
    expect(calls).toEqual([true, false, true]);
    expect(fallback.status()).toBe('on');
  });

  test('起動する前の status は unknown', () => {
    expect(new SandboxFallback().status()).toBe('unknown');
  });
});
