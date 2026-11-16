import { describe, expect, test } from 'bun:test';
import { currentCaller, runAsCaller } from './caller.js';

/**
 * 「いま呼んでいる利用者（tenant）」を、深い呼び出しまで渡す（設計 6。穴 25）。
 * 共有の資源（外部の問い合わせの待ち行列・予算）が、利用者を区別するために読む。呼び出しの引数を、全部の経路で増やさないための仕組み。
 */
describe('呼んでいる利用者', () => {
  test('範囲の外では legacy（利用者を渡さない経路は、1 つの利用者として数える）', () => {
    expect(currentCaller()).toBe('legacy');
  });

  test('範囲の中では、渡した tenant', () => {
    expect(runAsCaller('name:alice', () => currentCaller())).toBe('name:alice');
  });

  test('範囲を出ると、元に戻る', () => {
    runAsCaller('name:alice', () => undefined);
    expect(currentCaller()).toBe('legacy');
  });

  test('入れ子では、内側の tenant（外側は、内側が終わると戻る）', () => {
    const seen = runAsCaller('name:alice', () => {
      const inner = runAsCaller('name:bob', () => currentCaller());
      return [inner, currentCaller()];
    });
    expect(seen).toEqual(['name:bob', 'name:alice']);
  });

  test('await をまたいでも、setTimeout の先でも、同じ tenant', async () => {
    const seen = await runAsCaller('name:alice', async () => {
      const first = currentCaller();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const second = currentCaller();
      const third = await new Promise<string>((resolve) => setTimeout(() => resolve(currentCaller()), 5));
      return [first, second, third];
    });
    expect(seen).toEqual(['name:alice', 'name:alice', 'name:alice']);
  });

  test('同時に動く 2 つの範囲が、混ざらない', async () => {
    const run = (tenant: string, ms: number) =>
      runAsCaller(tenant, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return currentCaller();
      });
    expect(await Promise.all([run('name:alice', 20), run('name:bob', 5), run('name:carol', 10)])).toEqual(['name:alice', 'name:bob', 'name:carol']);
  });

  test('fn が投げても、範囲は外れる', () => {
    expect(() => runAsCaller('name:alice', () => { throw new Error('x'); })).toThrow('x');
    expect(currentCaller()).toBe('legacy');
  });

  test('空の tenant は legacy として扱う（空の名前で、別の入れ物を作らせない）', () => {
    expect(runAsCaller('', () => currentCaller())).toBe('legacy');
  });
});
