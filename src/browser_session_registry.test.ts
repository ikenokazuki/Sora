import { beforeEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError, ScrapeInputError } from './errors.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { type SessionCaps, SessionRegistry, sessionKey } from './browser_session_registry.js';

/**
 * ブラウザセッションの登録簿（設計 6。穴 22・23）。セッションの名前（ID）は利用者（tenant）ごとの空間で、
 * 数の上限は、利用者ごとと全体の 2 つ。全体がいっぱいでも、ほかの利用者のセッションは閉じない。
 * ブラウザは使わない（登録簿だけの単体テスト）。
 */

interface Fake {
  id: string;
  tenantId: string;
  lastActive: number;
}
const fake = (tenantId: string, id: string, lastActive = 0): Fake => ({ id, tenantId, lastActive });
const caps = (perTenant: number, total: number): SessionCaps => ({ perTenant, total });

/** 予約して、登録まで進める。追い出されたセッションを返す */
function create(registry: SessionRegistry<Fake>, session: Fake, limit: SessionCaps): Fake | undefined {
  const evicted = registry.reserve(session.tenantId, session.id, limit);
  registry.commit(session);
  return evicted;
}

beforeEach(() => resetSecurityMetrics());

describe('sessionKey', () => {
  test('tenant と ID の組を、区切りの曖昧さなしに 1 つの鍵にする（tenant や ID に区切りに見える文字があっても、別の組と同じ鍵にならない）', () => {
    expect(sessionKey('a', 'b')).not.toBe(sessionKey('b', 'a'));
    expect(sessionKey('a\u0000b', 'c')).not.toBe(sessionKey('a', 'b\u0000c'));
    expect(sessionKey('a:b', 'c')).not.toBe(sessionKey('a', 'b:c'));
    expect(sessionKey('name:alice', 'x')).toBe(sessionKey('name:alice', 'x'));
  });

  test('tenant が空（渡されていない）は legacy', () => {
    expect(sessionKey(undefined, 'x')).toBe(sessionKey('legacy', 'x'));
    expect(sessionKey('', 'x')).toBe(sessionKey('legacy', 'x'));
  });
});

describe('名前の空間', () => {
  test('同じ ID でも、tenant が違えば別のセッション。ほかの tenant の ID を引いても、見つからない（存在は分からない）', () => {
    const registry = new SessionRegistry<Fake>();
    const alice = fake('name:alice', 'shared');
    const bob = fake('name:bob', 'shared');
    create(registry, alice, caps(5, 20));
    create(registry, bob, caps(5, 20));
    expect(registry.get('name:alice', 'shared')).toBe(alice);
    expect(registry.get('name:bob', 'shared')).toBe(bob);
    expect(registry.get('name:carol', 'shared')).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  test('remove は、その tenant の分だけを消す。消したものを返し、無ければ undefined', () => {
    const registry = new SessionRegistry<Fake>();
    const alice = fake('name:alice', 'shared');
    const bob = fake('name:bob', 'shared');
    create(registry, alice, caps(5, 20));
    create(registry, bob, caps(5, 20));
    expect(registry.remove('name:bob', 'shared')).toBe(bob);
    expect(registry.get('name:alice', 'shared')).toBe(alice);
    expect(registry.remove('name:bob', 'shared')).toBeUndefined();
    expect(registry.remove('name:carol', 'shared')).toBeUndefined();
  });

  test('tenant が undefined の呼び出しは legacy として数える', () => {
    const registry = new SessionRegistry<Fake>();
    const legacy = fake('legacy', 'x');
    create(registry, legacy, caps(5, 20));
    expect(registry.get(undefined, 'x')).toBe(legacy);
    expect(registry.remove(undefined, 'x')).toBe(legacy);
  });
});

describe('作成の予約', () => {
  test('同じ ID の作成が、作成中に来たら、断る（入力の誤り）。予約の取り消しのあとは、作れる', () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'dup', caps(5, 20));
    expect(() => registry.reserve('name:alice', 'dup', caps(5, 20))).toThrow(ScrapeInputError);
    expect(() => registry.reserve('name:alice', 'dup', caps(5, 20))).toThrow(/dup/);
    // 別の tenant の同じ ID は、別の空間なので作れる
    expect(() => registry.reserve('name:bob', 'dup', caps(5, 20))).not.toThrow();
    registry.cancel('name:alice', 'dup');
    expect(() => registry.reserve('name:alice', 'dup', caps(5, 20))).not.toThrow();
  });

  test('登録済みの ID を、もう一度予約すると断る（呼ぶ側は、先に get で確かめる）', () => {
    const registry = new SessionRegistry<Fake>();
    create(registry, fake('name:alice', 'x'), caps(5, 20));
    expect(() => registry.reserve('name:alice', 'x', caps(5, 20))).toThrow(ScrapeInputError);
  });

  test('予約は、登録の前は get に見えず、size にも入らない。登録すると見える', () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'x', caps(5, 20));
    expect(registry.get('name:alice', 'x')).toBeUndefined();
    expect(registry.size).toBe(0);
    const session = fake('name:alice', 'x');
    registry.commit(session);
    expect(registry.get('name:alice', 'x')).toBe(session);
    expect(registry.size).toBe(1);
    // 登録したので、予約は残らない（もう一度予約すると、登録済みとして断られる。予約中ではない）
    expect(() => registry.reserve('name:alice', 'x', caps(5, 20))).toThrow(ScrapeInputError);
  });

  test('取り消しは、予約だけを消す。登録済みのセッションは消さない', () => {
    const registry = new SessionRegistry<Fake>();
    const session = fake('name:alice', 'x');
    create(registry, session, caps(5, 20));
    registry.cancel('name:alice', 'x');
    expect(registry.get('name:alice', 'x')).toBe(session);
  });
});

describe('作成中の待ち（pending）', () => {
  test('作成中でなければ undefined。作成中は、登録か取り消しで終わる Promise（鍵ごと）', async () => {
    const registry = new SessionRegistry<Fake>();
    expect(registry.pending('name:alice', 'x')).toBeUndefined();
    registry.reserve('name:alice', 'x', caps(5, 20));
    const waiting = registry.pending('name:alice', 'x');
    expect(waiting).toBeInstanceOf(Promise);
    expect(registry.pending('name:bob', 'x')).toBeUndefined(); // ほかの利用者の同じ ID は、別の空間
    expect(registry.pending('name:alice', 'y')).toBeUndefined();
    const session = fake('name:alice', 'x');
    let settled = false;
    void waiting?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // 作成が終わるまで、終わらない
    registry.commit(session);
    await waiting;
    expect(settled).toBe(true);
    expect(registry.get('name:alice', 'x')).toBe(session); // 待っていた側は、終わったあとに引けば、作られたセッションがある
    expect(registry.pending('name:alice', 'x')).toBeUndefined();
  });

  test('作成が取り消されても終わる（待っていた側は、引いても無ければ、自分で作る）', async () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'x', caps(5, 20));
    const waiting = registry.pending('name:alice', 'x');
    registry.cancel('name:alice', 'x');
    await waiting;
    expect(registry.get('name:alice', 'x')).toBeUndefined();
    expect(registry.pending('name:alice', 'x')).toBeUndefined();
    expect(() => registry.reserve('name:alice', 'x', caps(5, 20))).not.toThrow();
  });

  test('待っている側が複数いても、全員が終わる', async () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'x', caps(5, 20));
    const waiters = [registry.pending('name:alice', 'x'), registry.pending('name:alice', 'x')];
    registry.commit(fake('name:alice', 'x'));
    await Promise.all(waiters);
    expect(waiters.every((w) => w instanceof Promise)).toBe(true);
  });
});

describe('利用者ごとの上限', () => {
  test('上限に達した利用者の新しい作成は、その利用者の中で一番使われていないセッションを追い出す（返す）。登録簿から先に消える', () => {
    const registry = new SessionRegistry<Fake>();
    const a1 = fake('name:alice', 'a1', 100);
    const a2 = fake('name:alice', 'a2', 50);
    const a3 = fake('name:alice', 'a3', 200);
    for (const s of [a1, a2, a3]) create(registry, s, caps(3, 20));
    const evicted = registry.reserve('name:alice', 'a4', caps(3, 20));
    expect(evicted).toBe(a2);
    expect(registry.get('name:alice', 'a2')).toBeUndefined();
    expect(registry.size).toBe(2);
    registry.commit(fake('name:alice', 'a4'));
    expect(registry.size).toBe(3);
  });

  test('使われた時刻が同じなら、先に作ったほうを追い出す', () => {
    const registry = new SessionRegistry<Fake>();
    const first = fake('name:alice', 'a1', 7);
    create(registry, first, caps(2, 20));
    create(registry, fake('name:alice', 'a2', 7), caps(2, 20));
    expect(registry.reserve('name:alice', 'a3', caps(2, 20))).toBe(first);
  });

  test('上限に達していなければ、何も追い出さない（上限ちょうどの 1 つ手前まで）', () => {
    const registry = new SessionRegistry<Fake>();
    create(registry, fake('name:alice', 'a1'), caps(3, 20));
    create(registry, fake('name:alice', 'a2'), caps(3, 20));
    expect(registry.reserve('name:alice', 'a3', caps(3, 20))).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  test('追い出すのは、その利用者のセッションだけ。ほかの利用者の、もっと古いセッションは閉じない', () => {
    const registry = new SessionRegistry<Fake>();
    const bobOld = fake('name:bob', 'b1', 1);
    create(registry, bobOld, caps(2, 20));
    const a1 = fake('name:alice', 'a1', 100);
    const a2 = fake('name:alice', 'a2', 200);
    create(registry, a1, caps(2, 20));
    create(registry, a2, caps(2, 20));
    const evicted = registry.reserve('name:alice', 'a3', caps(2, 20));
    expect(evicted).toBe(a1);
    expect(registry.get('name:bob', 'b1')).toBe(bobOld);
  });

  test('作成中の予約も、その利用者の数に入る（作成中の分で上限に達したら、登録済みの古いセッションを追い出す）', () => {
    const registry = new SessionRegistry<Fake>();
    const a1 = fake('name:alice', 'a1', 10);
    create(registry, a1, caps(2, 20));
    registry.reserve('name:alice', 'a2', caps(2, 20)); // 作成中
    expect(registry.reserve('name:alice', 'a3', caps(2, 20))).toBe(a1);
  });

  test('その利用者の数が全部作成中（追い出せるものが無い）なら、断る', () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'a1', caps(1, 20));
    const error = (() => {
      try {
        registry.reserve('name:alice', 'a2', caps(1, 20));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect((error as ResourceBusyError).reason).toBe('session_limit');
    expect(registry.reserve('name:bob', 'b1', caps(1, 20))).toBeUndefined(); // ほかの利用者は影響を受けない
  });
});

describe('全体の上限', () => {
  test('全体がいっぱいなら、ほかの利用者のセッションを閉じずに、断る（ResourceBusyError の session_limit・Retry-After 30 秒）。数えて、予約も残さない', () => {
    const registry = new SessionRegistry<Fake>();
    const sessions = [fake('name:alice', 'a1', 1), fake('name:alice', 'a2', 2), fake('name:bob', 'b1', 3)];
    for (const s of sessions) create(registry, s, caps(5, 3));
    let error: unknown;
    try {
      registry.reserve('name:carol', 'c1', caps(5, 3));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect((error as ResourceBusyError).reason).toBe('session_limit');
    expect((error as ResourceBusyError).retryAfterSec).toBe(30);
    expect((error as ResourceBusyError).message).toContain('3');
    expect(getSecurityMetrics().sora_browser_busy_session_limit_total).toBe(1);
    // 古いセッションは、1 つも閉じられていない
    expect(registry.size).toBe(3);
    for (const s of sessions) expect(registry.get(s.tenantId, s.id)).toBe(s);
    // 予約が残っていない: 空きができたら、同じ ID で作れる
    registry.remove('name:bob', 'b1');
    expect(() => registry.reserve('name:carol', 'c1', caps(5, 3))).not.toThrow();
  });

  test('作成中の予約も、全体の数に入る', () => {
    const registry = new SessionRegistry<Fake>();
    registry.reserve('name:alice', 'a1', caps(5, 2));
    registry.reserve('name:bob', 'b1', caps(5, 2));
    expect(() => registry.reserve('name:carol', 'c1', caps(5, 2))).toThrow(ResourceBusyError);
  });

  test('利用者が自分の上限で追い出したときは、その分の空きで足りるので、全体がいっぱいでも作れる', () => {
    const registry = new SessionRegistry<Fake>();
    const a1 = fake('name:alice', 'a1', 1);
    create(registry, a1, caps(1, 2));
    create(registry, fake('name:bob', 'b1', 2), caps(1, 2));
    expect(registry.reserve('name:alice', 'a2', caps(1, 2))).toBe(a1);
    expect(registry.get('name:bob', 'b1')).toBeDefined();
  });

  test('全体の上限の 1 つ手前までは作れる（ちょうどで断る）', () => {
    const registry = new SessionRegistry<Fake>();
    create(registry, fake('name:alice', 'a1'), caps(5, 3));
    create(registry, fake('name:bob', 'b1'), caps(5, 3));
    expect(() => registry.reserve('name:carol', 'c1', caps(5, 3))).not.toThrow();
    expect(() => registry.reserve('name:dave', 'd1', caps(5, 3))).toThrow(ResourceBusyError);
  });

  test('断ったとき、利用者の追い出しは、すでに起きていない（断る前に何も閉じない）', () => {
    // 利用者が上限に達していて、全体もいっぱいで、追い出しても足りない場合は無い（追い出せば 1 つ空く）ので、
    // 全体だけがいっぱいの場合: 利用者の上限に達していない利用者が断られ、その利用者のセッションは残る
    const registry = new SessionRegistry<Fake>();
    const a1 = fake('name:alice', 'a1');
    create(registry, a1, caps(5, 2));
    create(registry, fake('name:bob', 'b1'), caps(5, 2));
    expect(() => registry.reserve('name:alice', 'a2', caps(5, 2))).toThrow(ResourceBusyError);
    expect(registry.get('name:alice', 'a1')).toBe(a1);
  });
});

describe('一覧と数', () => {
  test('all は登録済みを返し、countFor は予約も含めて利用者ごとに数える', () => {
    const registry = new SessionRegistry<Fake>();
    const a1 = fake('name:alice', 'a1');
    const b1 = fake('name:bob', 'b1');
    create(registry, a1, caps(5, 20));
    create(registry, b1, caps(5, 20));
    registry.reserve('name:alice', 'a2', caps(5, 20));
    expect(registry.all().toSorted((x, y) => x.id.localeCompare(y.id))).toEqual([a1, b1]);
    expect(registry.countFor('name:alice')).toBe(2);
    expect(registry.countFor('name:bob')).toBe(1);
    expect(registry.countFor('name:carol')).toBe(0);
  });
});
