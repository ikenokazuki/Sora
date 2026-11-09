/**
 * Temporal Context Anchor
 * 
 * Web ページの公開日時 (publishedTime) を基準日 (Reference Date) とし、
 * 本文や抽出ハイライト内の相対時間表現（「明日」「来週金曜日」「3日前」等）を
 * 決定論的に絶対日時 (YYYY-MM-DD) に解決・マッピングする。
 * 
 * 目的:
 * LLM が過去の記事の「明日発売」を「未来の予定」と誤認する
 * ハルシネーション（時間的誤認）を完全防止する。
 */

import type { TemporalAnchor } from '../types.js';
export type { TemporalAnchor };

const DAYS_JA = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
const DAY_MAP: Record<string, number> = {
  '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6,
};

function parseReferenceDate(dateStr?: string): Date {
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function formatDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 別の語の一部として現れたときは、その日付を指さない表現の条件。検出（extractTemporalAnchors）と注記（annotate…）で同じものを使う。
// 「一昨日」の中の「昨日」は 2 日前（1 日前ではない）。「当日券」「当日精算」「当日受付」「当日払い」「当日料金」の「当日」は日付ではない。
const NOT_AFTER_ICHI = '(?<!一)';
const NOT_COMPOUND = '(?![券精受払料])';
const EXPRESSION_GUARDS: Record<string, [before: string, after: string]> = {
  '昨日': [NOT_AFTER_ICHI, ''],
  '当日': ['', NOT_COMPOUND],
};

/** 月だけずらす。ずらした先の月に同じ日がなければ、その月の末日にする（setMonth だと 1月31日の来月が 3月3日にあふれる） */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

/**
 * テキストから相対時間表現を検出し、基準日に基づく絶対日時アンカーを抽出する
 */
export function extractTemporalAnchors(
  text: string,
  referenceDateStr?: string
): TemporalAnchor[] {
  if (!text || text.trim() === '') return [];

  const refDate = parseReferenceDate(referenceDateStr);
  const refDateFormatted = formatDateIso(refDate);
  const refDay = refDate.getDay(); // 0: 日, 1: 月, ...

  const anchors: TemporalAnchor[] = [];
  const seenExpressions = new Set<string>();

  const addAnchor = (
    expr: string,
    targetDate: Date,
    confidence: 'high' | 'medium' = 'high'
  ) => {
    if (seenExpressions.has(expr)) return;
    seenExpressions.add(expr);

    const resolvedDate = formatDateIso(targetDate);
    const resolvedDayOfWeek = DAYS_JA[targetDate.getDay()];

    anchors.push({
      expression: expr,
      referenceDate: refDateFormatted,
      resolvedDate,
      resolvedDayOfWeek,
      confidence,
    });
  };

  // 1. 固定の相対日表現 (明日、昨日、明後日、一昨日、本日、今日)
  const exactDayMatches: Array<{ regex: RegExp; offset: number; confidence: 'high' | 'medium' }> = [
    { regex: /明後日|あさって/g, offset: 2, confidence: 'high' },
    { regex: /一昨日|おととい/g, offset: -2, confidence: 'high' },
    { regex: /明日|明朝|翌日/g, offset: 1, confidence: 'high' },
    { regex: new RegExp(`${NOT_AFTER_ICHI}昨日|前日`, 'g'), offset: -1, confidence: 'high' },
    { regex: new RegExp(`本日|今日|当日${NOT_COMPOUND}`, 'g'), offset: 0, confidence: 'high' },
  ];

  for (const { regex, offset, confidence } of exactDayMatches) {
    const matches = text.match(regex);
    if (matches) {
      const matchWord = matches[0];
      const d = new Date(refDate);
      d.setDate(d.getDate() + offset);
      addAnchor(matchWord, d, confidence);
    }
  }

  // 2. N日前 / N日後
  // 後読みで数字の並びの先頭からだけ試す（途中の数字ごとに並びの最後まで読むと、長い数字の並びで二乗の時間になる。一致の結果は同じ）
  const nDayRegex = /(?<![0-9０-９])([0-9０-９]+)\s*日(?:前|まえ|後)/g;
  let match: RegExpExecArray | null;
  while ((match = nDayRegex.exec(text)) !== null) {
    const rawNum = match[1].replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
    const num = parseInt(rawNum, 10);
    if (!Number.isNaN(num) && num > 0 && num <= 365) {
      const isPast = match[0].includes('前') || match[0].includes('まえ');
      const d = new Date(refDate);
      d.setDate(d.getDate() + (isPast ? -num : num));
      addAnchor(match[0], d, 'high');
    }
  }

  // 3. 来週・今週・先週 + 曜日 (例: "来週金曜日", "今週の日曜", "来週の火曜")
  const weekDayRegex = /(今週|来週|再来週|先週)の?([月火水木金土日])(?:曜日?)?/g;
  while ((match = weekDayRegex.exec(text)) !== null) {
    const weekModifier = match[1];
    const targetDayChar = match[2];
    const targetDayIdx = DAY_MAP[targetDayChar];

    if (targetDayIdx !== undefined) {
      let weekOffset = 0;
      if (weekModifier === '来週') weekOffset = 1;
      else if (weekModifier === '再来週') weekOffset = 2;
      else if (weekModifier === '先週') weekOffset = -1;

      const d = new Date(refDate);
      // refDate の週の月曜日を起点とする (ISO 週体系: 月曜=1, 日曜=7)
      const currentIsoDay = refDay === 0 ? 7 : refDay;
      const targetIsoDay = targetDayIdx === 0 ? 7 : targetDayIdx;
      const dayDiff = (weekOffset * 7) + (targetIsoDay - currentIsoDay);

      d.setDate(d.getDate() + dayDiff);
      addAnchor(match[0], d, 'high');
    }
  }

  // 4. 来月・先月
  const monthRegex = /(来月|先月|再来月|今月)/g;
  while ((match = monthRegex.exec(text)) !== null) {
    const expr = match[0];
    let monthOffset = 0;
    if (expr === '来月') monthOffset = 1;
    else if (expr === '再来月') monthOffset = 2;
    else if (expr === '先月') monthOffset = -1;

    addAnchor(expr, addMonths(refDate, monthOffset), 'medium');
  }

  return anchors;
}

// リンクと画像の飛び先 `](url "title")`。URL の中の括弧は 1 段まで読む（enrichment.ts の MD_DEST と同じ形）。
// 日本語の URL を字のまま書くので、飛び先の中の「明日」などに注記を入れるとリンクが壊れる。
const MD_LINK_DEST_RE = String.raw`\]\([^()]*(?:\([^()]*\)[^()]*)*\)`;

/**
 * 本文中の相対日時表現に決定論的な絶対日時注記 (例: "明日 [2026-09-02]") を埋め込む。
 * リンクと画像の飛び先 `](…)` の中は書き換えない（リンクの文字と alt には注記を入れる）
 */
export function annotateTextWithTemporalAnchors(
  text: string,
  referenceDateStr?: string
): string {
  const anchors = extractTemporalAnchors(text, referenceDateStr);
  if (anchors.length === 0) return text;

  // 長い表現から順に並べた 1 つの正規表現で 1 回だけ置換する（来週金曜が来週金曜日の一部に当たって二重に注記しない）。
  // 先読みで最初に当たった表現に決め、後ろに注記があれば短い表現へ戻らずにそのままにする。飛び先は先に当てて、そのまま返す
  const sortedAnchors = anchors.slice().sort((a, b) => b.expression.length - a.expression.length);
  const resolved = new Map(sortedAnchors.map((a) => [a.expression, a.resolvedDate]));
  const alternatives = sortedAnchors.map(({ expression }) => {
    const [before, after] = EXPRESSION_GUARDS[expression] ?? ['', ''];
    return `${before}${expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${after}`;
  });
  const regex = new RegExp(`(${MD_LINK_DEST_RE})|(?=(${alternatives.join('|')}))\\2(?!\\s*\\[\\d{4}-\\d{2}-\\d{2}\\])`, 'g');
  return text.replace(regex, (_m, dest: string | undefined, expr: string) => dest ?? `${expr} [${resolved.get(expr)}]`);
}
