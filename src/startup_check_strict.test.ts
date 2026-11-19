import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from './config.js';
import { launchProbe, strictBrowserLaunchProblems } from './browser_engine.js';
import { resetApiKeyStoreCache } from './security/api_keys.js';
import { checkStartupEnv } from './startup_check.js';

/**
 * 起動の検査（checkStartupEnv）の、strict の分（設計 0。段階 8）。
 * 設定の検査は security/strict_config.test.ts、起動の計画の検査は browser_launch_strict.test.ts。ここは、起動の検査につながっていることを確かめる。
 */

const PREFIX = '[Sora/Config]';
let dir: string;
let keysFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-strict-startup-'));
  keysFile = join(dir, 'keys.json');
  writeFileSync(keysFile, JSON.stringify({ keys: [{ name: 'alice', key: 'alice-key-0123456789abcdef' }] }), { mode: 0o600 });
  resetApiKeyStoreCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
});

const compliant = (): Env => ({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: keysFile, SORA_BROWSER_SANDBOX: 'on', SORA_EGRESS_GATEWAY: 'on' });

function run(env: Env, options: { launch?: () => string[]; transport?: 'http' | 'stdio' } = {}) {
  const lines: string[] = [];
  const exits: number[] = [];
  const launchCalls: Env[] = [];
  checkStartupEnv({
    env,
    transport: options.transport,
    stderr: (line) => lines.push(line),
    exit: (code) => void exits.push(code),
    exists: () => true,
    strictLaunch: (given) => {
      launchCalls.push(given);
      return options.launch?.() ?? [];
    },
  });
  return { lines, exits, launchCalls };
}
const errorLines = (lines: string[]) => lines.filter((line) => line.startsWith(`${PREFIX} エラー:`));

describe('checkStartupEnv（strict）', () => {
  test('必要な設定がそろい、uid も分けられるなら、何も出さずに起動する', () => {
    const { lines, exits, launchCalls } = run(compliant());
    expect(lines).toEqual([]);
    expect(exits).toEqual([]);
    expect(launchCalls).toHaveLength(1);
  });

  test('設定が足りなければ、すべてを知らせて、exit(1)（1 回だけ）。件数を数える', () => {
    const { lines, exits } = run({ SORA_ISOLATION: 'strict' });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toHaveLength(3);
    expect(lines.at(-1)).toBe(`${PREFIX} 環境変数の誤りが 3 件あるので、起動しません`);
    expect(lines.join('\n')).toContain('SORA_AUTH_KEYS_FILE');
  });

  test('uid を分けられないときも断る。設定の誤りと、あわせて数える', () => {
    const { lines, exits } = run({ ...compliant(), SORA_EGRESS_GATEWAY: 'off' }, { launch: () => ['SORA_ISOLATION=strict では、Sora を root で起動する必要があります（いまは uid 1000）'] });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toHaveLength(2);
    expect(lines.join('\n')).toContain('uid 1000');
    expect(lines.at(-1)).toBe(`${PREFIX} 環境変数の誤りが 2 件あるので、起動しません`);
  });

  test('起動の計画の検査には、検査する環境を渡す（プロセスの環境でなく）', () => {
    const env = { ...compliant(), SORA_BROWSER_UID: '70000' };
    expect(run(env).launchCalls).toEqual([env]);
  });

  test('standard（既定・未設定）では、strict の検査を一切しない。同じ設定の足りなさでも、止めない', () => {
    for (const env of [{}, { SORA_ISOLATION: 'standard' }, { SORA_ISOLATION: '' }]) {
      const { lines, exits, launchCalls } = run(env);
      expect(lines, JSON.stringify(env)).toEqual([]);
      expect(exits, JSON.stringify(env)).toEqual([]);
      expect(launchCalls, JSON.stringify(env)).toEqual([]);
    }
  });

  test('SORA_ISOLATION の書き方が誤りなら、その誤りだけを言う（strict の検査には進まない）', () => {
    const { lines, exits, launchCalls } = run({ SORA_ISOLATION: 'strcit' });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toHaveLength(1);
    expect(errorLines(lines)[0]).toContain('SORA_ISOLATION');
    expect(launchCalls).toEqual([]);
  });

  test('SORA_BROWSER_MAX_PROCESSES は strict のときだけ効く。strict では警告しない。standard で設定していたら、効かないと警告する(止めない)', () => {
    const strictRun = run({ ...compliant(), SORA_BROWSER_MAX_PROCESSES: '8' });
    expect(strictRun.lines).toEqual([]);
    expect(strictRun.exits).toEqual([]);
    for (const env of [{ SORA_BROWSER_MAX_PROCESSES: '8' }, { SORA_ISOLATION: 'standard', SORA_BROWSER_MAX_PROCESSES: '8' }]) {
      const { lines, exits } = run(env);
      expect(exits, JSON.stringify(env)).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith(`${PREFIX} 警告: SORA_BROWSER_MAX_PROCESSES は`);
      expect(lines[0]).toContain('strict');
    }
    // 設定していなければ、何も言わない
    expect(run({ SORA_ISOLATION: 'standard' }).lines).toEqual([]);
  });

  test('stdio では使えない', () => {
    const { lines, exits } = run(compliant(), { transport: 'stdio' });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toHaveLength(1);
    expect(errorLines(lines)[0]).toContain('stdio');
  });

  test('鍵ファイルが読めないときは、その誤りだけを言う（設定が「ある」ので、足りないとは言わない）', () => {
    const { lines, exits } = run({ ...compliant(), SORA_AUTH_KEYS_FILE: join(dir, 'missing.json') });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toHaveLength(1);
    expect(errorLines(lines)[0]).toContain('SORA_AUTH_KEYS_FILE');
    expect(errorLines(lines)[0]).toContain('読めません');
  });
});

describe('strictBrowserLaunchProblems（実環境を読む。launchProbe を差し替えて確かめる）', () => {
  const original = { ...launchProbe };
  afterEach(() => Object.assign(launchProbe, original));

  test('Chromium が無いときは、検査しない（ブラウザを使えないので、落とす先が無い）', () => {
    launchProbe.currentUid = () => 1000;
    expect(strictBrowserLaunchProblems({}, false)).toEqual([]);
  });

  test('Chromium があり、root でなければ、断る', () => {
    launchProbe.currentUid = () => 1000;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    const problems = strictBrowserLaunchProblems({}, true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('uid 1000');
  });

  test('root で、起動用バイナリがあり、capability が足りていれば、問題はない。足りなければ、断る', () => {
    launchProbe.currentUid = () => 0;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    expect(strictBrowserLaunchProblems({}, true)).toEqual([]);
    launchProbe.missingCapabilities = () => ['CAP_SETUID'];
    expect(strictBrowserLaunchProblems({}, true)[0]).toContain('CAP_SETUID');
  });

  test('ブラウザとの接続は、パイプだけ（ポートは、127.0.0.1 で待ち受けるので、別の uid の tenant のプロセスから届く）', () => {
    launchProbe.currentUid = () => 0;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    // 既定（Bun 1.4.4 以上）はパイプ
    expect(strictBrowserLaunchProblems({}, true, '1.4.4')).toEqual([]);
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_PIPE: 'true' }, true, '1.3.3')).toEqual([]);
    // 明示してポートにする
    for (const value of ['false', '0', 'off', 'no']) {
      const problems = strictBrowserLaunchProblems({ SORA_BROWSER_PIPE: value }, true, '1.4.4');
      expect(problems, value).toHaveLength(1);
      expect(problems[0]).toContain('SORA_BROWSER_PIPE');
    }
    // Bun が古いと、既定がポートになる
    const old = strictBrowserLaunchProblems({}, true, '1.3.3');
    expect(old).toHaveLength(1);
    expect(old[0]).toContain('1.4.4');
    // Chromium が無ければ、接続を使わないので検査しない
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_PIPE: 'false' }, false, '1.3.3')).toEqual([]);
  });

  test('設定したプロセス数(SORA_BROWSER_MAX_PROCESSES)で、uid の範囲を調べる(最後の番号を足した uid が、最大を超えないか)', () => {
    launchProbe.currentUid = () => 0;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    const MAX_UID = 4_294_967_294;
    for (const processes of [1, 4, 10, 64]) {
      const ok = String(MAX_UID - (processes - 1)); // 最後の番号(processes - 1)を足して、ちょうど最大
      const over = String(MAX_UID - (processes - 1) + 1);
      expect(strictBrowserLaunchProblems({ SORA_BROWSER_MAX_PROCESSES: String(processes), SORA_BROWSER_UID: ok }, true, '1.4.4'), `${processes} 個・基準 ${ok}`).toEqual([]);
      if (processes === 1) continue; // 1 個のときは、基準そのものが最大を超える値になり、uid として読めない(自動に戻る)
      const problems = strictBrowserLaunchProblems({ SORA_BROWSER_MAX_PROCESSES: String(processes), SORA_BROWSER_UID: over }, true, '1.4.4');
      expect(problems, `${processes} 個・基準 ${over}`).toHaveLength(1);
    }
    // 設定が無ければ、表の値(4)で調べる
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_UID: String(MAX_UID - 3) }, true, '1.4.4')).toEqual([]);
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_UID: String(MAX_UID - 2) }, true, '1.4.4')).toHaveLength(1);
  });

  test('SORA_BROWSER_UID=off と SORA_BROWSER_SANDBOX=on の組は、実行環境の検査では何も言わない（設定の検査が 1 件だけ言う。同じ原因を 2 回言わない）', async () => {
    launchProbe.currentUid = () => 0;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    const env = { SORA_BROWSER_UID: 'off', SORA_BROWSER_SANDBOX: 'on' };
    expect(strictBrowserLaunchProblems(env, true, '1.4.4')).toEqual([]);
    const { strictConfigProblems } = await import('./security/strict_config.js');
    expect(strictConfigProblems({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: '/x', SORA_EGRESS_GATEWAY: 'on', ...env }, 'http')).toHaveLength(1);
  });

  test('番号の数は、strict の上限（STRICT_LIMITS.browserProcessMax）で調べる', async () => {
    const { STRICT_LIMITS } = await import('./security/limits.js');
    launchProbe.currentUid = () => 0;
    launchProbe.launcherExists = () => true;
    launchProbe.missingCapabilities = () => [];
    // 最後の番号を足すと最大をちょうど超える基準の uid
    const base = 4_294_967_294 - (STRICT_LIMITS.browserProcessMax - 1) + 1;
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_UID: String(base) }, true)).toHaveLength(1);
    expect(strictBrowserLaunchProblems({ SORA_BROWSER_UID: String(base - 1) }, true)).toEqual([]);
  });
});
