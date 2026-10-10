// イベント（JSON-LD の Event など）の並び替えと、複数ページの予定の統合。表示用の順序と重複の整理だけを行い、予定は削除しない。
import type { EventItem } from './types.js';

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

export type ScheduleItem = EventItem & {
  /** この予定を載せていたページの URL（出現順、重複なし） */
  sources: string[];
};

const FILLABLE_KEYS = ['endDate', 'location', 'performer', 'description', 'url', 'eventStatus', 'eventAttendanceMode', 'offers'] as const;

/** 表記ゆれ（全角・半角、大文字小文字、空白・記号）を無視するための名称の正規化。 */
function normalizeEventName(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase();
  return folded.replace(/[\s\p{P}\p{S}]/gu, '') || folded.trim();
}

/**
 * 複数ページの予定（events）を 1 つの一覧にまとめる。
 * 開始日（JST）と正規化した名称が同じ予定は 1 件にし、先に出たものを採って空の項目を後から補う。
 * ponytail: 名称が違えば同日・同会場でも別の予定のまま残す（重複が残る側に倒す。誤って 1 件にまとめて予定を隠す方が害が大きい）。
 * 並びは sortEventsByProximity（今後の近い順、日時不明、過去）。入力は書き換えない。
 */
export function buildSchedule(
  items: ReadonlyArray<{ url?: string; link?: string; events?: readonly EventItem[] } | null | undefined>,
  now: number = Date.now(),
): ScheduleItem[] {
  const merged = new Map<string, ScheduleItem>();
  for (const item of items) {
    if (!item || !Array.isArray(item.events)) continue;
    const source = typeof item.url === 'string' && item.url ? item.url : typeof item.link === 'string' ? item.link : '';
    for (const event of item.events) {
      if (!event || typeof event.name !== 'string' || !event.name.trim()) continue;
      const start = parseEventTime(event.startDate, 'start');
      const key = `${start !== undefined ? jstDateOf(start) : 'nodate'}|${normalizeEventName(event.name)}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...event, sources: source ? [source] : [] });
        continue;
      }
      for (const field of FILLABLE_KEYS) {
        if (existing[field] === undefined && event[field] !== undefined) Object.assign(existing, { [field]: event[field] });
      }
      if (source && !existing.sources.includes(source)) existing.sources.push(source);
    }
  }
  return sortEventsByProximity([...merged.values()], now);
}
