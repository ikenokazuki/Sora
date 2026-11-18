import { describe, expect, test } from 'bun:test';
import { BrowserSlots } from './browser_slots.js';

/**
 * tenant ごとのブラウザのプロセスの、番号（uid の池の位置）の割り当て（設計 2。段階 6）。
 * 番号は 0 以上 max 未満。使っていない最小の番号を渡し、空きが無ければ断る。閉じてよいプロセスは、最も長く使われていないものから選ぶ。
 */
describe('BrowserSlots', () => {
  const make = (max = 3) => {
    let now = 1000;
    const slots = new BrowserSlots(() => max, () => now);
    return { slots, tick: (ms = 1) => { now += ms; } };
  };

  test('使っていない最小の番号から渡す。同じ key には、同じ番号を返す', () => {
    const { slots } = make();
    expect(slots.allocate('a')).toBe(0);
    expect(slots.allocate('b')).toBe(1);
    expect(slots.allocate('a')).toBe(0);
    expect(slots.size).toBe(2);
  });

  test('空きが無ければ undefined（max まで）', () => {
    const { slots } = make(2);
    slots.allocate('a');
    slots.allocate('b');
    expect(slots.allocate('c')).toBeUndefined();
    expect(slots.size).toBe(2);
  });

  test('手放した番号は、次の割り当てで、いちばん小さい空きとして使われる', () => {
    const { slots } = make();
    slots.allocate('a');
    slots.allocate('b');
    slots.allocate('c');
    slots.release('b');
    expect(slots.allocate('d')).toBe(1);
    slots.release('a');
    expect(slots.allocate('e')).toBe(0);
  });

  test('手放していない key の番号は、別の key に渡さない（同じ uid を 2 つの tenant が使わない）', () => {
    const { slots } = make(5);
    const indexes = ['a', 'b', 'c', 'd', 'e'].map((key) => slots.allocate(key));
    expect(new Set(indexes).size).toBe(5);
  });

  test('存在しない key の手放しは、何も起こさない', () => {
    const { slots } = make();
    slots.allocate('a');
    slots.release('zzz');
    expect(slots.size).toBe(1);
  });

  test('indexOf は割り当て済みの番号。無ければ undefined', () => {
    const { slots } = make();
    slots.allocate('a');
    expect(slots.indexOf('a')).toBe(0);
    expect(slots.indexOf('b')).toBeUndefined();
  });

  test('candidates: 最も長く使われていない順（touch で新しくなる）', () => {
    const { slots, tick } = make(4);
    slots.allocate('a'); tick();
    slots.allocate('b'); tick();
    slots.allocate('c'); tick();
    slots.touch('a'); tick();
    expect(slots.candidates()).toEqual(['b', 'c', 'a']);
  });

  test('max が小さくなっても（水準の切り替え）、すでに持っている番号は消さず、新しい割り当てだけ断る', () => {
    let max = 3;
    const slots = new BrowserSlots(() => max);
    slots.allocate('a');
    slots.allocate('b');
    slots.allocate('c');
    max = 1;
    expect(slots.indexOf('c')).toBe(2);
    expect(slots.allocate('d')).toBeUndefined();
    slots.release('a');
    slots.release('b');
    // 番号 0・1 は空いたが、max = 1 なので、新しい割り当ては、max 未満の番号だけ（0 は使える。1 は使えない）
    expect(slots.allocate('e')).toBe(0);
    expect(slots.allocate('f')).toBeUndefined();
  });
});
