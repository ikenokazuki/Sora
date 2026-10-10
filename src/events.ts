// イベント（JSON-LD の Event など）の並び替え。表示用の順序だけを決め、予定は削除しない。
// ponytail: 国内向けのため、日付だけの値とタイムゾーンの無い日時は JST とみなす（海外のイベントが多い用途では要見直し）。

const JST_OFFSET = '+09:00';
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

type DateLike = { startDate?: string; endDate?: string };

/** 日時文字列をミリ秒にする。読めなければ undefined。edge は日付だけの値を日の始め・終わりのどちらに置くか。 */
export function parseEventTime(value: string | undefined, edge: 'start' | 'end'): number | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return undefined;
  let iso = v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    iso = `${v}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}${JST_OFFSET}`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !HAS_ZONE.test(v)) {
    iso = `${v.replace(' ', 'T')}${JST_OFFSET}`;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** ミリ秒を JST の YYYY-MM-DD にする。 */
export function jstDateOf(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function eventTimeRange(event: DateLike): { start?: number; end?: number } {
  const start = parseEventTime(event.startDate, 'start') ?? parseEventTime(event.endDate, 'start');
  const end = parseEventTime(event.endDate, 'end') ?? parseEventTime(event.startDate, 'end');
  return { start, end };
}

/**
 * 開催中・今後の予定を近い順 → 日時が読めない予定（元の順）→ 過去の予定を新しい順、に並べる。
 * 元の配列は変更せず、同じ順位のものは元の順を保つ。
 */
export function sortEventsByProximity<T extends DateLike>(events: readonly T[], now: number = Date.now()): T[] {
  const upcoming: Array<{ event: T; key: number; index: number }> = [];
  const unknown: T[] = [];
  const past: Array<{ event: T; key: number; index: number }> = [];
  events.forEach((event, index) => {
    const { start, end } = eventTimeRange(event);
    if (end === undefined) unknown.push(event);
    else if (end >= now) upcoming.push({ event, key: start ?? end, index });
    else past.push({ event, key: end, index });
  });
  upcoming.sort((a, b) => a.key - b.key || a.index - b.index);
  past.sort((a, b) => b.key - a.key || a.index - b.index);
  return [...upcoming.map((x) => x.event), ...unknown, ...past.map((x) => x.event)];
}
