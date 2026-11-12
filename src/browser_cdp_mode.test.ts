import { describe, expect, test } from 'bun:test';
import { browserCdpMode, bunAtLeast } from './browser_engine.js';

describe('bunAtLeast', () => {
  test('版の数を、先頭から順に比べる', () => {
    expect(bunAtLeast([1, 4, 4], '1.4.4')).toBe(true);
    expect(bunAtLeast([1, 4, 4], '1.4.10')).toBe(true);
    expect(bunAtLeast([1, 4, 4], '1.5.0')).toBe(true);
    expect(bunAtLeast([1, 4, 4], '2.0.0')).toBe(true);
    expect(bunAtLeast([1, 4, 4], '1.4.3')).toBe(false);
    expect(bunAtLeast([1, 4, 4], '1.3.3')).toBe(false);
    expect(bunAtLeast([1, 4, 4], '0.9.9')).toBe(false);
  });

  test('canary などの接尾辞は、数の部分だけを見る。読めなければ false', () => {
    expect(bunAtLeast([1, 4, 4], '1.4.5-canary.20261112.1+abc123')).toBe(true);
    expect(bunAtLeast([1, 4, 4], '1.4.3-canary.1')).toBe(false);
    expect(bunAtLeast([1, 4, 4], 'garbage')).toBe(false);
    expect(bunAtLeast([1, 4, 4], '')).toBe(false);
  });
});

describe('browserCdpMode（CDP の繋ぎ方）', () => {
  test('既定は、Bun 1.4.4 以上ならパイプ、それ未満ならポート（1.3.3 では、起動と終了を繰り返したあとに接続が閉じる・止まることがある）', () => {
    expect(browserCdpMode({}, '1.4.4')).toBe('pipe');
    expect(browserCdpMode({}, '1.5.0')).toBe('pipe');
    expect(browserCdpMode({}, '1.3.3')).toBe('port');
    expect(browserCdpMode({ SORA_BROWSER_PIPE: '' }, '1.3.3')).toBe('port');
    expect(browserCdpMode({ SORA_BROWSER_PIPE: 'auto' }, '1.4.4')).toBe('pipe');
  });

  test('SORA_BROWSER_PIPE=false（0・off・no も可、大文字小文字・前後の空白は問わない）で、版によらずポートに戻せる', () => {
    for (const value of ['false', '0', 'off', 'no', ' FALSE ']) expect(browserCdpMode({ SORA_BROWSER_PIPE: value }, '1.4.4')).toBe('port');
  });

  test('SORA_BROWSER_PIPE=true（1・on・yes も可）で、版によらずパイプにする', () => {
    for (const value of ['true', '1', 'on', 'yes', ' True ']) expect(browserCdpMode({ SORA_BROWSER_PIPE: value }, '1.3.3')).toBe('pipe');
  });
});
