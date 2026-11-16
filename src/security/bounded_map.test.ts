import { describe, expect, test } from 'bun:test';
import { trimMap } from './bounded_map.js';

/** キーが "k0", "k1", … で、値が数の Map（入れた順に並ぶ）。値が 0 のものを、古い（stale）とみなす */
function build(values: number[]): Map<string, number> {
  return new Map(values.map((value, i) => [`k${i}`, value]));
}
const isZero = (value: number) => value === 0;
const keys = (map: Map<string, number>) => [...map.keys()];

describe('trimMap: 上限以下なら、何もしない', () => {
  test('ちょうど上限まで入っていても、古い項目を含めて、そのまま', () => {
    const map = build([0, 1, 0]);
    trimMap(map, 3, isZero);
    expect(keys(map)).toEqual(['k0', 'k1', 'k2']);
  });

  test('上限以下のときは、古いかどうかの判定を呼ばない（毎回の追加で全体を調べない）', () => {
    const map = build([1, 2, 3]);
    let calls = 0;
    trimMap(map, 3, () => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
  });
});

describe('trimMap: 上限を超えたとき', () => {
  test('古い項目を、先に全部外す。それで上限以下になれば、新しい項目は 1 つも外さない', () => {
    const map = build([0, 1, 0, 2, 3]); // 5 件、上限 3。古いのは k0・k2
    trimMap(map, 3, isZero);
    expect(keys(map)).toEqual(['k1', 'k3', 'k4']);
  });

  test('古い項目を外しても上限を超えるなら、入れた順に古い方から、上限の 9 割まで外す', () => {
    const map = build([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // 11 件、上限 10。9 割 = 9
    trimMap(map, 10, isZero);
    expect(keys(map)).toEqual(['k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10']);
  });

  test('9 割まで減らすので、次の数回の追加では、また全体を調べない', () => {
    const map = build(Array.from({ length: 101 }, (_, i) => i + 1)); // 上限 100
    trimMap(map, 100, isZero);
    expect(map.size).toBe(90);
    let calls = 0;
    for (let i = 0; i < 10; i++) {
      map.set(`n${i}`, 1);
      trimMap(map, 100, (value) => {
        calls++;
        return value === 0;
      });
    }
    expect(map.size).toBe(100);
    expect(calls).toBe(0);
  });

  test('古い項目を外した後は、残りを 9 割までは減らさない（古いだけで足りたとき）', () => {
    const map = build([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // 11 件、上限 10。古い 2 件を外すと 9 件
    trimMap(map, 10, isZero);
    expect(map.size).toBe(9);
    const full = build([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // 古い 1 件を外すと 10 件ちょうど
    trimMap(full, 10, isZero);
    expect(full.size).toBe(10);
  });

  test('一番新しく入れた項目は残る', () => {
    const map = build([1, 2, 3, 4, 5, 6]);
    trimMap(map, 5, isZero);
    expect(keys(map)).toContain('k5');
  });
});

describe('trimMap: 上限が小さすぎる値でも、1 件は残す', () => {
  test.each([0, -5, 0.4, Number.NaN])('上限 %p', (max) => {
    const map = build([1, 2, 3]);
    trimMap(map, max, isZero);
    expect(keys(map)).toEqual(['k2']);
  });

  test('上限が小数のとき、切り捨てた件数を上限にする（2.9 は 2）', () => {
    const map = build([1, 2, 3]); // 3 件。上限 2 なら超える（2.9 のまま比べると超えない）
    trimMap(map, 2.9, isZero);
    expect(keys(map)).toEqual(['k2']); // 上限 2 の 9 割 = 1 件
  });

  test('上限 1 のとき、1 件は残る（9 割が 0 になっても）', () => {
    const map = build([1, 2]);
    trimMap(map, 1, isZero);
    expect(keys(map)).toEqual(['k1']);
  });
});
