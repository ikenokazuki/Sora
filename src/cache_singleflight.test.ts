import { describe, expect, test } from 'bun:test';
import { runWithSingleFlight } from './cache.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('singleflight regression (spec sections 58-60)', () => {
  test('10 concurrent identical searches issue one provider request', async () => {
    let calls = 0;
    const key = `sf-same-${Date.now()}-1`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runWithSingleFlight(key, async () => {
          calls++;
          await tick();
          return 'shared';
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r === 'shared')).toBe(true);
  });

  test('different queries do not coalesce', async () => {
    let calls = 0;
    const stamp = Date.now();
    const run = (q: string) =>
      Array.from({ length: 5 }, () =>
        runWithSingleFlight(`sf-${stamp}-${q}`, async () => {
          calls++;
          await tick();
          return q;
        }),
      );
    const [a, b] = await Promise.all([Promise.all(run('A')), Promise.all(run('B'))]);
    expect(calls).toBe(2);
    expect(a.every((r) => r === 'A')).toBe(true);
    expect(b.every((r) => r === 'B')).toBe(true);
  });

  test('a rejected flight is evicted and the query can be retried', async () => {
    const key = `sf-reject-${Date.now()}`;
    let attempt = 0;
    await expect(
      runWithSingleFlight(key, async () => {
        attempt++;
        await tick();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await runWithSingleFlight(key, async () => {
      attempt++;
      return 'recovered';
    });
    expect(attempt).toBe(2);
    expect(retry).toBe('recovered');
  });
});
