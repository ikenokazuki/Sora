import { describe, expect, test } from 'bun:test';
import { jstDateOf, parseEventTime, sortEventsByProximity } from './events.js';

const NOW = Date.parse('2026-10-10T12:00:00+09:00');
const names = (events: Array<{ name: string }>) => events.map((e) => e.name);

describe('parseEventTime', () => {
  test('日付だけの値は JST の日の始め・終わりになる', () => {
    expect(parseEventTime('2026-10-10', 'start')).toBe(Date.parse('2026-10-10T00:00:00+09:00'));
    expect(parseEventTime('2026-10-10', 'end')).toBe(Date.parse('2026-10-10T23:59:59.999+09:00'));
  });

  test('タイムゾーンの無い日時は JST、指定があればそのまま', () => {
    expect(parseEventTime('2026-10-10T17:00:00', 'start')).toBe(Date.parse('2026-10-10T17:00:00+09:00'));
    expect(parseEventTime('2026-10-10 17:00', 'start')).toBe(Date.parse('2026-10-10T17:00:00+09:00'));
    expect(parseEventTime('2026-10-10T08:00:00Z', 'start')).toBe(Date.parse('2026-10-10T08:00:00Z'));
    expect(parseEventTime('2026-10-10T17:00:00+09:00', 'start')).toBe(Date.parse('2026-10-10T08:00:00Z'));
  });

  test('読めない値は undefined', () => {
    expect(parseEventTime(undefined, 'start')).toBeUndefined();
    expect(parseEventTime('', 'start')).toBeUndefined();
    expect(parseEventTime('未定', 'start')).toBeUndefined();
  });
});

describe('jstDateOf', () => {
  test('UTC では前日でも JST の日付を返す', () => {
    expect(jstDateOf(Date.parse('2026-10-10T16:00:00Z'))).toBe('2026-10-11');
    expect(jstDateOf(Date.parse('2026-10-10T14:59:59Z'))).toBe('2026-10-10');
  });
});

describe('sortEventsByProximity', () => {
  test('今後の予定を近い順、日時不明、過去を新しい順に並べる', () => {
    const events = [
      { name: '過去(古)', startDate: '2025-02-03' },
      { name: '今後(遠)', startDate: '2026-12-01T18:00:00+09:00' },
      { name: '日時不明A' },
      { name: '過去(新)', startDate: '2026-10-01T18:00:00+09:00' },
      { name: '今後(近)', startDate: '2026-10-15T18:00:00+09:00' },
      { name: '日時不明B', startDate: '未定' },
    ];
    expect(names(sortEventsByProximity(events, NOW))).toEqual([
      '今後(近)', '今後(遠)', '日時不明A', '日時不明B', '過去(新)', '過去(古)',
    ]);
  });

  test('TimeTree の例: 入力の先頭が過去でも、今後の予定が先頭に来る', () => {
    const events = [
      { name: '2025-02 の予定', startDate: '2025-02-03', endDate: '2025-02-03' },
      { name: '来月の予定', startDate: '2026-11-03', endDate: '2026-11-03' },
    ];
    expect(sortEventsByProximity(events, NOW)[0].name).toBe('来月の予定');
  });

  test('終日の予定は当日中なら今後の扱い', () => {
    const events = [
      { name: '昨日', startDate: '2026-10-09' },
      { name: '今日(終日)', startDate: '2026-10-10' },
    ];
    expect(names(sortEventsByProximity(events, NOW))).toEqual(['今日(終日)', '昨日']);
  });

  test('開催中（終了が未来）の予定は今後として扱う', () => {
    const events = [
      { name: '来週', startDate: '2026-10-17T10:00:00+09:00' },
      { name: '開催中', startDate: '2026-10-09T10:00:00+09:00', endDate: '2026-10-12T20:00:00+09:00' },
    ];
    expect(names(sortEventsByProximity(events, NOW))).toEqual(['開催中', '来週']);
  });

  test('同じ時刻の予定は元の順を保ち、入力を書き換えない', () => {
    const events = [
      { name: 'A', startDate: '2026-10-20T18:00:00+09:00' },
      { name: 'B', startDate: '2026-10-20T18:00:00+09:00' },
      { name: 'C', startDate: '2026-10-20T18:00:00+09:00' },
    ];
    const copy = JSON.parse(JSON.stringify(events));
    expect(names(sortEventsByProximity(events, NOW))).toEqual(['A', 'B', 'C']);
    expect(events).toEqual(copy);
  });

  test('空配列', () => {
    expect(sortEventsByProximity([], NOW)).toEqual([]);
  });
});
