import { describe, expect, test } from 'bun:test';
import type { Env } from '../config.js';
import { strictConfigProblems } from './strict_config.js';

/**
 * `SORA_ISOLATION=strict` が、起動のときに求める設定（設計 0。段階 8）。満たさないものは、1 つずつ、変数の名前と直し方を添えて返す。
 * 水準の判定は呼ぶ側（startup_check.ts）。ここは、strict として検査した結果だけを返す。
 */

const COMPLIANT: Env = {
  SORA_ISOLATION: 'strict',
  SORA_AUTH_KEYS_FILE: '/run/secrets/sora-keys.json',
  SORA_BROWSER_SANDBOX: 'on',
  SORA_EGRESS_GATEWAY: 'on',
};

const without = (name: string): Env => Object.fromEntries(Object.entries(COMPLIANT).filter(([key]) => key !== name));

describe('strictConfigProblems', () => {
  test('必要な設定がそろっていれば、問題はない', () => {
    expect(strictConfigProblems(COMPLIANT, 'http')).toEqual([]);
  });

  test('名前つきの鍵（SORA_AUTH_KEYS_FILE）が無ければ断る。単一の鍵（SORA_API_KEY）や匿名では、利用者を分けられない', () => {
    for (const env of [without('SORA_AUTH_KEYS_FILE'), { ...without('SORA_AUTH_KEYS_FILE'), SORA_API_KEY: 'k' }, { ...COMPLIANT, SORA_AUTH_KEYS_FILE: '  ' }]) {
      const problems = strictConfigProblems(env, 'http');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('SORA_AUTH_KEYS_FILE');
    }
  });

  test('サンドボックスは on だけ（未設定・auto・off は、使えなくても黙って --no-sandbox に戻るので断る）。大文字・前後の空白は受ける', () => {
    for (const value of [undefined, 'auto', 'off', '', 'yes']) {
      const env = value === undefined ? without('SORA_BROWSER_SANDBOX') : { ...COMPLIANT, SORA_BROWSER_SANDBOX: value };
      const problems = strictConfigProblems(env, 'http');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('SORA_BROWSER_SANDBOX=on');
    }
    for (const value of ['ON', ' On ', 'on']) expect(strictConfigProblems({ ...COMPLIANT, SORA_BROWSER_SANDBOX: value }, 'http')).toEqual([]);
  });

  test('出口のゲートウェイが無効なら断る', () => {
    for (const env of [without('SORA_EGRESS_GATEWAY'), { ...COMPLIANT, SORA_EGRESS_GATEWAY: 'off' }, { ...COMPLIANT, SORA_EGRESS_GATEWAY: 'false' }]) {
      const problems = strictConfigProblems(env, 'http');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('SORA_EGRESS_GATEWAY=on');
    }
    for (const value of ['true', '1', 'yes', 'ON']) expect(strictConfigProblems({ ...COMPLIANT, SORA_EGRESS_GATEWAY: value }, 'http')).toEqual([]);
  });

  test('内部への取得を許す設定（SORA_FETCH_ALLOW_PRIVATE_NETWORK=true）は、ゲートウェイを使わなくなるので断る', () => {
    const problems = strictConfigProblems({ ...COMPLIANT, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, 'http');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SORA_FETCH_ALLOW_PRIVATE_NETWORK');
    expect(problems[0]).toContain('ゲートウェイ');
    // false は問題ない
    expect(strictConfigProblems({ ...COMPLIANT, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'false' }, 'http')).toEqual([]);
  });

  test('ゲートウェイが無効で、内部への取得も許しているときは、原因の 1 つ（ゲートウェイが無効）だけを言う', () => {
    const problems = strictConfigProblems({ ...without('SORA_EGRESS_GATEWAY'), SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, 'http');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SORA_EGRESS_GATEWAY=on');
  });

  test('Chromium の uid を落とさない設定（SORA_BROWSER_UID=off）は、tenant を uid で分けられないので断る。数や auto は受ける', () => {
    for (const value of ['off', 'OFF', ' off ']) {
      const problems = strictConfigProblems({ ...COMPLIANT, SORA_BROWSER_UID: value }, 'http');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('SORA_BROWSER_UID');
    }
    for (const value of ['auto', '65532', '70000']) expect(strictConfigProblems({ ...COMPLIANT, SORA_BROWSER_UID: value }, 'http')).toEqual([]);
  });

  test('stdio では使えない（利用者を分ける鍵が無い）。鍵ファイルの有無は重ねて言わない', () => {
    const problems = strictConfigProblems(without('SORA_AUTH_KEYS_FILE'), 'stdio');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stdio');
    expect(strictConfigProblems(COMPLIANT, 'stdio')).toHaveLength(1);
  });

  test('複数の問題は、すべて、まとめて返す（1 つ直すたびに起動し直させない）', () => {
    const problems = strictConfigProblems({ SORA_ISOLATION: 'strict' }, 'http');
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('SORA_AUTH_KEYS_FILE');
    expect(problems.join('\n')).toContain('SORA_BROWSER_SANDBOX=on');
    expect(problems.join('\n')).toContain('SORA_EGRESS_GATEWAY=on');
  });

  test('どの問題の文にも、直し方（何にするか）が入っている', () => {
    for (const problem of strictConfigProblems({ SORA_ISOLATION: 'strict', SORA_BROWSER_UID: 'off', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, 'http')) {
      expect(problem).toMatch(/SORA_[A-Z_]+/);
      expect(problem.length).toBeGreaterThan(30);
    }
  });
});
