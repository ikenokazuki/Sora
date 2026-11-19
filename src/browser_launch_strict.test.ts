import { describe, expect, test } from 'bun:test';
import { DEFAULT_LAUNCHER, strictLaunchProblems } from './browser_launch_plan.js';

/**
 * strict の起動のとき、tenant ごとの Chromium を別の uid に落とせるか（設計 2。段階 8）。
 * 入力は planBrowserLaunch と同じ（実際の環境は、呼ぶ側が読んで渡す）。落とせないなら、理由ごとに 1 つずつ問題を返す。
 */

const ok = { env: {}, currentUid: 0 as number | undefined, launcherExists: true, nodeEnv: 'production' as string | undefined, processMax: 4 };

describe('strictLaunchProblems', () => {
  test('root で、起動用バイナリがあり、capability が足りていれば、問題はない', () => {
    expect(strictLaunchProblems(ok)).toEqual([]);
    expect(strictLaunchProblems({ ...ok, missingCapabilities: [] })).toEqual([]);
  });

  test('root でなければ、落とせない。いまの uid を示し、root で起動するよう案内する（uid が分からない環境も同じ）', () => {
    for (const currentUid of [1000, 65532, undefined]) {
      const problems = strictLaunchProblems({ ...ok, currentUid });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('root');
      expect(problems[0]).toContain(currentUid === undefined ? '不明' : `uid ${currentUid}`);
    }
  });

  test('root でなければ、起動用バイナリ・capability の問題は重ねない（root にすれば、そのとき分かる）', () => {
    expect(strictLaunchProblems({ ...ok, currentUid: 1000, launcherExists: false, missingCapabilities: ['CAP_SETUID'] })).toHaveLength(1);
  });

  test('起動用バイナリが無ければ、その場所を示して断る', () => {
    const problems = strictLaunchProblems({ ...ok, launcherExists: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(DEFAULT_LAUNCHER);
  });

  test('capability が足りなければ、足りないものと、足す書き方（--cap-add）を示して断る', () => {
    const problems = strictLaunchProblems({ ...ok, missingCapabilities: ['CAP_SETUID', 'CAP_KILL'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('CAP_SETUID');
    expect(problems[0]).toContain('CAP_KILL');
    expect(problems[0]).toContain('--cap-add=SETUID');
    expect(problems[0]).toContain('--cap-add=KILL');
  });

  test('起動用バイナリが無く、capability も足りないときは、両方を返す', () => {
    expect(strictLaunchProblems({ ...ok, launcherExists: false, missingCapabilities: ['CAP_CHOWN'] })).toHaveLength(2);
  });

  test('基準の uid に最後の番号（processMax - 1）を足すと、uid の最大を超えるなら断る。範囲に収まるなら受ける', () => {
    const over = strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: '4294967294' } });
    expect(over).toHaveLength(1);
    expect(over[0]).toContain('SORA_BROWSER_UID');
    // 最後の番号（3）を足して最大ちょうどは、収まる
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: String(4_294_967_294 - 3) } })).toEqual([]);
    // 番号が 0 だけなら（processMax 1）、基準がそのまま使われる
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: '4294967294' }, processMax: 1 })).toEqual([]);
  });

  test('SORA_BROWSER_UID=off は、この関数では扱わない（設定の検査が言う）。root・バイナリ・capability がそろっていれば、問題を返さない', () => {
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: 'off' } })).toEqual([]);
  });

  test('SORA_BROWSER_UID=off と SORA_BROWSER_SANDBOX=on の組（strict では必ず来る組）でも、この関数は問題を返さない（サンドボックスの失敗を、uid=off の言い直しとして重ねない）', () => {
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: 'off', SORA_BROWSER_SANDBOX: 'on' } })).toEqual([]);
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: 'off', SORA_BROWSER_SANDBOX: 'on' }, nodeEnv: 'test' })).toEqual([]);
  });

  test('サンドボックスの設定が on でも、uid の範囲の検査は効く（検査のために、サンドボックスの設定だけを外して計画を組む）', () => {
    expect(strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: '4294967294', SORA_BROWSER_SANDBOX: 'on' } })).toHaveLength(1);
  });

  test('uid を数で明示し、capability が足りないとき、同じ原因を 2 回言わない（計画の例外を重ねない）', () => {
    const problems = strictLaunchProblems({ ...ok, env: { SORA_BROWSER_UID: '70000' }, missingCapabilities: ['CAP_SETUID'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('CAP_SETUID');
  });
});
