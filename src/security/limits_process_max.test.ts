import { describe, expect, test } from 'bun:test';
import { checkEnv } from '../config.js';
import { limits, STANDARD_LIMITS, STRICT_LIMITS, strictBrowserProcessMax } from './limits.js';

/**
 * strict の同時のブラウザのプロセス数(SORA_BROWSER_MAX_PROCESSES)。表の値(4)が既定で、設定で 1〜64 に変えられる。
 * 利用者が多い運用(VPS で、不特定多数)で、ブラウザを同時に使える利用者の数を、メモリに合わせて増やすため。
 */

const strict = (extra: Record<string, string> = {}) => ({ SORA_ISOLATION: 'strict', ...extra });

describe('limits().browserProcessMax(strict)', () => {
  test('未設定は、表の値(4)。表そのもの(STRICT_LIMITS)を返す', () => {
    expect(STRICT_LIMITS.browserProcessMax).toBe(4);
    expect(limits(strict()).browserProcessMax).toBe(4);
    expect(limits(strict())).toBe(STRICT_LIMITS);
  });

  test('設定した数になる。ほかの値は、表のまま', () => {
    const wide = limits(strict({ SORA_BROWSER_MAX_PROCESSES: '16' }));
    expect(wide.browserProcessMax).toBe(16);
    expect({ ...wide, browserProcessMax: 4 }).toEqual({ ...STRICT_LIMITS });
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '1' })).browserProcessMax).toBe(1);
  });

  test('表と同じ数なら、表そのものを返す(値を作り直さない)。同じ数なら、同じ物を返す(呼ぶたびに作らない)', () => {
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '4' }))).toBe(STRICT_LIMITS);
    const a = limits(strict({ SORA_BROWSER_MAX_PROCESSES: '9' }));
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '9' }))).toBe(a);
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '10' }))).not.toBe(a);
  });

  test('64 を超える値は 64 にする(誤った桁で、メモリを使い切らない)', () => {
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '64' })).browserProcessMax).toBe(64);
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '65' })).browserProcessMax).toBe(64);
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: '99999999999999999999' })).browserProcessMax).toBe(64);
  });

  test('読めない値(0・負・小数・文字)は、表の値(4)のまま。起動の検査(checkEnv)が誤りとして止める', () => {
    for (const bad of ['0', '-1', '2.5', 'many', '', ' ']) {
      expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: bad })).browserProcessMax, JSON.stringify(bad)).toBe(4);
    }
  });

  test('前後の空白は問わない', () => {
    expect(limits(strict({ SORA_BROWSER_MAX_PROCESSES: ' 8 ' })).browserProcessMax).toBe(8);
  });

  test('返す値は変えられない(凍結)', () => {
    const wide = limits(strict({ SORA_BROWSER_MAX_PROCESSES: '12' }));
    expect(Object.isFrozen(wide)).toBe(true);
  });
});

describe('standard では効かない', () => {
  test('standard の値(0 = 全員で 1 つの共有ブラウザ)のまま。設定があっても変わらない', () => {
    expect(STANDARD_LIMITS.browserProcessMax).toBe(0);
    for (const env of [{}, { SORA_ISOLATION: 'standard' }, { SORA_ISOLATION: 'standard', SORA_BROWSER_MAX_PROCESSES: '16' }, { SORA_BROWSER_MAX_PROCESSES: '16' }]) {
      expect(limits(env).browserProcessMax, JSON.stringify(env)).toBe(0);
      expect(limits(env)).toBe(STANDARD_LIMITS);
    }
  });
});

describe('strictBrowserProcessMax(水準によらず、strict での数を返す。起動の検査が使う)', () => {
  test('設定があればそれ、なければ表の値', () => {
    expect(strictBrowserProcessMax({})).toBe(4);
    expect(strictBrowserProcessMax({ SORA_BROWSER_MAX_PROCESSES: '7' })).toBe(7);
    expect(strictBrowserProcessMax({ SORA_ISOLATION: 'standard', SORA_BROWSER_MAX_PROCESSES: '7' })).toBe(7);
    expect(strictBrowserProcessMax({ SORA_BROWSER_MAX_PROCESSES: '1000' })).toBe(64);
    expect(strictBrowserProcessMax({ SORA_BROWSER_MAX_PROCESSES: 'x' })).toBe(4);
  });
});

describe('登録簿(checkEnv)', () => {
  test('正しい値は、誤りも警告も出ない', () => {
    for (const value of ['1', '4', '16', '64']) expect(checkEnv({ SORA_BROWSER_MAX_PROCESSES: value }), value).toEqual({ errors: [], warnings: [] });
  });

  test('0・負・小数・文字は、誤り(変数の名前と、正しい形を示す)', () => {
    for (const bad of ['0', '-3', '2.5', 'many']) {
      const { errors } = checkEnv({ SORA_BROWSER_MAX_PROCESSES: bad });
      expect(errors, bad).toHaveLength(1);
      expect(errors[0]).toContain('SORA_BROWSER_MAX_PROCESSES');
      expect(errors[0]).toContain('1 以上の整数');
    }
  });

  test('64 を超える値は、誤りでなく、64 にする(説明に書く)', () => {
    expect(checkEnv({ SORA_BROWSER_MAX_PROCESSES: '500' })).toEqual({ errors: [], warnings: [] });
  });
});
