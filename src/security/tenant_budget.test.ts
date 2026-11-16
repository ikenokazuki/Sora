import { afterEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError } from '../errors.js';
import { runAsCaller } from './caller.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';
import { TenantBudget } from './tenant_budget.js';

/**
 * 利用者ごとの予算（一定の時間あたりの回数。設計 6。穴 25）。共有の外部資源（Nominatim・Yahoo）は、提供元が 1 つの出口（Sora）を見て制限する。
 * 1 人の連打が提供元の制限（429）に当たると、全員が止まるので、提供元に当たる前に、その人だけを止める。
 */

let clock = 1_000_000;
const now = () => clock;
const budget = (perWindow: number, over: { windowMs?: number; maxTenants?: number } = {}) =>
  new TenantBudget({ resource: 'geocoding', policy: () => ({ perWindow, windowMs: over.windowMs ?? 60_000 }), now, maxTenants: () => over.maxTenants ?? 10_000 });

const busyOf = (fn: () => void): ResourceBusyError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ResourceBusyError);
    return e as ResourceBusyError;
  }
  throw new Error('断られなかった');
};

afterEach(() => {
  clock = 1_000_000;
  resetSecurityMetrics();
});

describe('予算の中', () => {
  test('予算の回数までは通る。超えた 1 回が、tenant_budget で断られる（resource・reason）', () => {
    const b = budget(3);
    b.spend('A');
    b.spend('A');
    b.spend('A');
    const busy = busyOf(() => b.spend('A'));
    expect(busy).toMatchObject({ resource: 'geocoding', reason: 'tenant_budget' });
  });

  test('0（制限なし）では、何回でも通り、何も覚えない（メモリを使わない）', () => {
    const b = budget(0);
    for (let i = 0; i < 1000; i++) b.spend('A');
    expect(b.size).toBe(0);
  });

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY * 0])('予算が %p のように読めない値のときも、制限なしとして通す（投げない）', (perWindow) => {
    const b = budget(perWindow);
    expect(() => b.spend('A')).not.toThrow();
    expect(b.size).toBe(0);
  });

  test('時間の幅が 0 以下・NaN のときも、制限なしとして通す', () => {
    for (const windowMs of [0, -5, Number.NaN]) {
      const b = budget(1, { windowMs });
      b.spend('A');
      expect(() => b.spend('A')).not.toThrow();
    }
  });

  test('小数の予算は切り捨てる（2.9 は 2 回）。1 未満でも、1 回は通る（0.4 は 1 回）', () => {
    const b = budget(2.9);
    b.spend('A');
    b.spend('A');
    busyOf(() => b.spend('A'));
    const c = budget(0.4);
    c.spend('A');
    busyOf(() => c.spend('A'));
    // 文の回数も、切り捨てた回数（実際に断る回数）
    expect(busyOf(() => b.spend('A')).message).toContain('1 分に 2 回');
    expect(busyOf(() => c.spend('A')).message).toContain('1 分に 1 回');
  });

  test('1 回きりの予算（1）: 2 回目が断られる', () => {
    const b = budget(1);
    b.spend('A');
    expect(busyOf(() => b.spend('A')).reason).toBe('tenant_budget');
  });
});

describe('時間の幅（すべる窓）', () => {
  test('最も古い 1 回が窓から出ると、1 回分あく', () => {
    const b = budget(2, { windowMs: 60_000 });
    b.spend('A'); // t = 0
    clock += 10_000;
    b.spend('A'); // t = 10 s
    busyOf(() => b.spend('A'));
    clock += 49_999; // t = 59.999 s。最初の 1 回は、まだ窓の中（59.999 秒前）
    busyOf(() => b.spend('A'));
    clock += 1; // t = 60 s。最初の 1 回が、ちょうど窓から出る（60 秒前）
    b.spend('A');
    busyOf(() => b.spend('A'));
  });

  test('窓が全部すぎれば、また予算の回数まで通る', () => {
    const b = budget(2);
    b.spend('A');
    b.spend('A');
    clock += 60_000;
    b.spend('A');
    b.spend('A');
    busyOf(() => b.spend('A'));
  });

  test('断られた回は、予算を使わず、窓も延ばさない（連打しても、最初の窓が空けば通る）', () => {
    const b = budget(2);
    b.spend('A'); // t = 0
    b.spend('A');
    for (let i = 0; i < 50; i++) {
      clock += 1_000;
      busyOf(() => b.spend('A')); // 50 秒間、断られ続ける
    }
    clock += 10_000; // t = 60 s
    b.spend('A');
    b.spend('A');
  });

  test('Retry-After は、最も古い 1 回が窓から出るまでの秒（切り上げ。最低 1）', () => {
    const b = budget(1, { windowMs: 60_000 });
    b.spend('A'); // t = 0
    clock += 20_500; // 20.5 秒後。残り 39.5 秒 → 40
    expect(busyOf(() => b.spend('A')).retryAfterSec).toBe(40);
    clock += 39_499; // 残り 0.001 秒 → 1
    expect(busyOf(() => b.spend('A')).retryAfterSec).toBe(1);
  });

  test('時計が戻っても（記録が未来になっても）、ずっと断らない', () => {
    const b = budget(1);
    b.spend('A');
    clock -= 3_600_000; // 1 時間戻る
    b.spend('A'); // 未来の記録は、窓から出たものとして外す
    busyOf(() => b.spend('A'));
  });

  test('断った文に、資源の名前・予算・待つ秒が入る', () => {
    const b = budget(20);
    for (let i = 0; i < 20; i++) b.spend('A');
    clock += 15_000;
    const message = busyOf(() => b.spend('A')).message;
    expect(message).toContain('地名の検索');
    expect(message).toContain('1 分に 20 回');
    expect(message).toContain('45 秒');
  });

  test('窓が 1 分でないときは、秒で書く', () => {
    const b = budget(1, { windowMs: 30_000 });
    b.spend('A');
    expect(busyOf(() => b.spend('A')).message).toContain('30 秒に 1 回');
  });
});

describe('利用者ごと', () => {
  test('1 人が使い切っても、ほかの利用者は通る', () => {
    const b = budget(2);
    b.spend('A');
    b.spend('A');
    busyOf(() => b.spend('A'));
    b.spend('B');
    b.spend('B');
    busyOf(() => b.spend('B'));
  });

  test('tenant を渡さなければ、いま呼んでいる利用者（runAsCaller）。範囲の外は legacy', () => {
    const b = budget(1);
    runAsCaller('name:alice', () => b.spend());
    busyOf(() => runAsCaller('name:alice', () => b.spend()));
    runAsCaller('name:bob', () => b.spend()); // 別の利用者は通る
    b.spend(); // 範囲の外 = legacy
    busyOf(() => b.spend());
    busyOf(() => b.spend('legacy'));
  });

  test('方針は、呼ぶたびに読む（水準を切り替えると、すぐ追従する）', () => {
    let perWindow = 1;
    const b = new TenantBudget({ resource: 'yahoo', policy: () => ({ perWindow, windowMs: 60_000 }), now });
    b.spend('A');
    busyOf(() => b.spend('A'));
    perWindow = 2;
    b.spend('A');
    perWindow = 0; // 制限なしに戻す
    b.spend('A');
  });
});

describe('返す（順番で断られた回は、予算を使わなかったことにする）', () => {
  test('spend が返す関数を呼ぶと、その 1 回が戻り、また使える', () => {
    const b = budget(1);
    const refund = b.spend('A');
    busyOf(() => b.spend('A'));
    refund();
    b.spend('A');
  });

  test('2 回呼んでも、1 回分だけ（余分には戻らない）', () => {
    const b = budget(2);
    const refund = b.spend('A');
    b.spend('A');
    refund();
    refund();
    b.spend('A'); // 戻った 1 回で、2 回目の spend の分は使える
    busyOf(() => b.spend('A')); // 2 回分あいたわけではない
  });

  test('戻るのは、その 1 回だけ（ほかの回は戻らない）。ほかの利用者にも触れない', () => {
    const b = budget(2);
    b.spend('A');
    clock += 1_000;
    const second = b.spend('A');
    b.spend('B');
    second();
    b.spend('A'); // 戻した分だけ
    busyOf(() => b.spend('A'));
    busyOf(() => { b.spend('B'); b.spend('B'); }); // B は自分の 2 回目で断られる（A の返しが B に足されていない）
  });

  test('全部戻すと、その利用者は覚えから消える（覚える数が増えない）', () => {
    const b = budget(2);
    const refund = b.spend('A');
    expect(b.size).toBe(1);
    refund();
    expect(b.size).toBe(0);
  });

  test('覚えから外れたあと・窓がすぎたあとに呼んでも、投げず、ほかに影響しない', () => {
    const b = budget(1, { maxTenants: 1 });
    const refund = b.spend('A');
    clock += 61_000;
    b.spend('B'); // 上限 1 件。窓がすぎた A は、覚えから外れる
    expect(b.size).toBe(1);
    expect(() => refund()).not.toThrow();
    busyOf(() => b.spend('B')); // B の予算は変わらない
  });

  test('戻すのは、いま使った回の記録（先頭の古い回を戻さない）: 古い回は、窓から出る時刻のまま', () => {
    const b = budget(2);
    b.spend('A'); // t = 0
    clock += 10_000;
    const second = b.spend('A'); // t = 10 s
    second();
    clock += 50_000; // t = 60 s。最初の回は窓から出る。戻した 2 回目は、もう無い
    b.spend('A');
    b.spend('A');
    busyOf(() => b.spend('A'));
  });

  test('制限なし（0）では、何も戻さず、投げない関数が返る', () => {
    const b = budget(0);
    const refund = b.spend('A');
    expect(() => refund()).not.toThrow();
    expect(b.size).toBe(0);
  });

  test('断られた回は、返す関数を持たない（例外で、戻り値が無い）', () => {
    const b = budget(1);
    b.spend('A');
    busyOf(() => b.spend('A'));
    b.spend('B'); // B は影響を受けない
  });
});

describe('使った回数を読む（usedBy）', () => {
  test('窓の中で使った回数を、利用者ごとに返す。使っていない利用者は 0', () => {
    const b = budget(5);
    expect(b.usedBy('A')).toBe(0);
    b.spend('A');
    b.spend('A');
    b.spend('B');
    expect(b.usedBy('A')).toBe(2);
    expect(b.usedBy('B')).toBe(1);
    expect(b.usedBy('C')).toBe(0);
  });

  test('返すと減る。窓がすぎた回は数えない。読んでも、覚えは増えない・動かない', () => {
    const b = budget(5, { windowMs: 60_000 });
    const refund = b.spend('A');
    clock += 10_000;
    b.spend('A');
    refund();
    expect(b.usedBy('A')).toBe(1);
    clock += 50_000; // 2 回目は窓の中（50 秒前）、最初の回は戻したので無い
    expect(b.usedBy('A')).toBe(1);
    clock += 10_000; // 2 回目も窓から出る
    expect(b.usedBy('A')).toBe(0);
    expect(b.usedBy('nobody')).toBe(0);
    expect(b.size).toBe(1); // 読んだだけの利用者は、覚えない
  });

  test('制限なし（0）では、何も覚えないので 0。覚えたあとで制限なしにしても 0', () => {
    const b = budget(0);
    b.spend('A');
    expect(b.usedBy('A')).toBe(0);
    let perWindow = 2;
    const c = new TenantBudget({ resource: 'geocoding', policy: () => ({ perWindow, windowMs: 60_000 }), now });
    c.spend('A');
    expect(c.usedBy('A')).toBe(1);
    perWindow = 0;
    expect(c.usedBy('A')).toBe(0);
  });

  test('時計が戻って、未来になった記録は数えない。tenant を渡さなければ、いま呼んでいる利用者', () => {
    const b = budget(5);
    b.spend('A');
    clock -= 3_600_000;
    expect(b.usedBy('A')).toBe(0);
    clock += 3_600_000;
    runAsCaller('name:alice', () => b.spend());
    expect(runAsCaller('name:alice', () => b.usedBy())).toBe(1);
    expect(runAsCaller('name:bob', () => b.usedBy())).toBe(0);
    expect(b.usedBy()).toBe(0); // 範囲の外 = legacy
  });
});

describe('数える', () => {
  test('断るたびに、資源ごとのカウンター sora_<resource>_busy_tenant_budget_total が増える。通った回は数えない', () => {
    const geo = budget(1);
    const yahoo = new TenantBudget({ resource: 'yahoo', policy: () => ({ perWindow: 1, windowMs: 60_000 }), now });
    geo.spend('A');
    yahoo.spend('A');
    expect(getSecurityMetrics().sora_geocoding_busy_tenant_budget_total).toBeUndefined();
    busyOf(() => geo.spend('A'));
    busyOf(() => geo.spend('A'));
    busyOf(() => yahoo.spend('A'));
    expect(getSecurityMetrics().sora_geocoding_busy_tenant_budget_total).toBe(2);
    expect(getSecurityMetrics().sora_yahoo_busy_tenant_budget_total).toBe(1);
  });
});

describe('覚える利用者の数の上限（メモリが増える一方にならない）', () => {
  test('上限を超えたら、窓がすぎた利用者を先に外す。まだ超えるなら古い順に外す', () => {
    const b = budget(5, { maxTenants: 10 });
    for (let i = 0; i < 10; i++) b.spend(`old${i}`);
    expect(b.size).toBe(10);
    clock += 61_000; // 10 人とも、窓がすぎた
    b.spend('new'); // 11 人目。窓がすぎた 10 人が先に外れる
    expect(b.size).toBe(1);
  });

  test('窓の中の利用者だけで上限を超えるなら、入れた順に古い方から外す（いま入れた利用者は残る）', () => {
    const b = budget(5, { maxTenants: 10 });
    for (let i = 0; i < 50; i++) b.spend(`t${i}`);
    expect(b.size).toBeLessThanOrEqual(10);
    // 一番新しい利用者は覚えている: 予算 5 を使い切れば断られる
    for (let i = 0; i < 4; i++) b.spend('t49');
    busyOf(() => b.spend('t49'));
  });

  test('覚えから外れた利用者は、予算が満タンに戻る（外れるのは古い利用者だけ。いま連打している利用者は、外れない）', () => {
    const b = budget(2, { maxTenants: 5 });
    b.spend('hot');
    b.spend('hot');
    busyOf(() => b.spend('hot'));
    for (let i = 0; i < 4; i++) b.spend(`cold${i}`);
    // hot を連打し続ける（書き直すたびに、入れた順の最後に動く）
    for (let i = 0; i < 20; i++) {
      busyOf(() => b.spend('hot'));
      b.spend(`other${i}`);
    }
    busyOf(() => b.spend('hot'));
  });

  test('clear で、全部忘れる', () => {
    const b = budget(1);
    b.spend('A');
    b.clear();
    expect(b.size).toBe(0);
    b.spend('A');
  });
});
