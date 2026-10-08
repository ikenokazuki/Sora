import { describe, expect, test } from 'bun:test';
import { settleWithDeadline } from './scrape_deadline.js';

const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const never = () => new Promise<never>(() => {});

describe('settleWithDeadline', () => {
  test('returns every value in order when all finish before the deadline', async () => {
    const out = await settleWithDeadline([after(5, 'a'), after(1, 'b'), after(3, 'c')], { graceMs: 50, capMs: 500 }, () => 'late');
    expect(out.values).toEqual(['a', 'b', 'c']);
    expect(out.lateCount).toBe(0);
  });

  test('after half are done, waits only the grace period and replaces the rest', async () => {
    const started = Date.now();
    const out = await settleWithDeadline(
      [after(5, 'a'), after(5, 'b'), after(5, 'c'), never(), after(2000, 'e')],
      { graceMs: 60, capMs: 1500 },
      (i) => `late${i}`,
    );
    expect(out.values).toEqual(['a', 'b', 'c', 'late3', 'late4']);
    expect(out.lateCount).toBe(2);
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('the cap applies even when fewer than half have finished', async () => {
    const started = Date.now();
    const out = await settleWithDeadline([after(5, 'a'), never(), never(), never(), never()], { graceMs: 1000, capMs: 80 }, (i) => `late${i}`);
    expect(out.values[0]).toBe('a');
    expect(out.lateCount).toBe(4);
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('capMs <= 0 disables the deadline', async () => {
    const out = await settleWithDeadline([after(5, 'a'), after(120, 'b'), after(120, 'c')], { graceMs: 10, capMs: 0 }, () => 'late');
    expect(out.values).toEqual(['a', 'b', 'c']);
    expect(out.lateCount).toBe(0);
  });

  test('a rejection after the deadline does not become an unhandled rejection', async () => {
    const late = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('boom')), 80));
    const out = await settleWithDeadline([after(1, 'a'), late], { graceMs: 5, capMs: 40 }, () => 'late');
    expect(out.values).toEqual(['a', 'late']);
    await after(120, null);
  });

  test('empty input resolves immediately', async () => {
    expect((await settleWithDeadline([], { graceMs: 5, capMs: 40 }, () => 'x')).values).toEqual([]);
  });
});
