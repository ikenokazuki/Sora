import { Database, type Statement } from 'bun:sqlite';
import { kanji2number } from '@geolonia/japanese-numeral';
import { parseCsvMatrix } from './address_csv.js';

export type PostalKind = 'general' | 'office' | 'po_box';

export interface PostalRowInput {
  zip: string;
  kind: PostalKind;
  lg5: string;
  pref: string;
  city: string;
  /** 括弧の注記と「以下に掲載がない場合」を除いた町域。市区町村の既定行では空。 */
  town: string;
  /** 原文の町域（括弧の注記つき）。 */
  townRaw: string;
  /** 括弧の中身（丁目・番地の範囲、階、その他）。 */
  annotation: string;
  /** JIGYOSYO の小字・丁目・番地等。 */
  detail: string;
  /** JIGYOSYO の事業所名。 */
  office: string;
}

export interface PostalRow extends PostalRowInput {
  id: number;
}

// ---------- 解析 ----------

export function splitTown(raw: string): { town: string; annotation: string } {
  if (raw === '以下に掲載がない場合' || raw.endsWith('の次に番地がくる場合')) return { town: '', annotation: '' };
  const match = raw.match(/^([^（]*)(?:（(.*)）)?$/);
  return { town: match?.[1] ?? raw, annotation: match?.[2] ?? '' };
}

/** 日本郵便の utf_ken_all.csv（UTF-8、ヘッダー無し、15 列）。 */
export function parseKenAll(text: string): PostalRowInput[] {
  const rows: PostalRowInput[] = [];
  for (const r of parseCsvMatrix(text)) {
    const zip = r[2] ?? '';
    if (r.length < 9 || !/^\d{7}$/.test(zip)) continue;
    const raw = r[8] ?? '';
    const { town, annotation } = splitTown(raw);
    rows.push({ zip, kind: 'general', lg5: r[0] ?? '', pref: r[6] ?? '', city: r[7] ?? '', town, townRaw: raw, annotation, detail: '', office: '' });
  }
  return rows;
}

/** 日本郵便の事業所の個別郵便番号（JIGYOSYO.CSV。Shift_JIS を復号した文字列、13 列）。 */
export function parseJigyosyo(text: string): PostalRowInput[] {
  const rows: PostalRowInput[] = [];
  for (const r of parseCsvMatrix(text)) {
    const zip = r[7] ?? '';
    if (r.length < 11 || !/^\d{7}$/.test(zip)) continue;
    rows.push({
      zip, kind: r[10] === '1' ? 'po_box' : 'office', lg5: r[0] ?? '', pref: r[3] ?? '', city: r[4] ?? '',
      town: r[5] ?? '', townRaw: r[5] ?? '', annotation: '', detail: r[6] ?? '', office: r[2] ?? '',
    });
  }
  return rows;
}

// ---------- SQLite ----------

interface DbRow {
  id: number;
  zip: string;
  kind: PostalKind;
  lg5: string;
  pref: string;
  city: string;
  town: string;
  town_raw: string;
  annotation: string;
  detail: string;
  office: string;
}

const toRow = (r: DbRow): PostalRow => ({
  id: r.id, zip: r.zip, kind: r.kind, lg5: r.lg5, pref: r.pref, city: r.city,
  town: r.town, townRaw: r.town_raw, annotation: r.annotation, detail: r.detail, office: r.office,
});

export function buildPostalDb(path: string, rows: readonly PostalRowInput[]): void {
  const db = new Database(path, { create: true });
  try {
    db.run(`CREATE TABLE postal (
      id INTEGER PRIMARY KEY, zip TEXT NOT NULL, kind TEXT NOT NULL, lg5 TEXT NOT NULL, pref TEXT NOT NULL, city TEXT NOT NULL,
      town TEXT NOT NULL, town_raw TEXT NOT NULL, annotation TEXT NOT NULL, detail TEXT NOT NULL, office TEXT NOT NULL)`);
    const insert = db.prepare('INSERT INTO postal (zip, kind, lg5, pref, city, town, town_raw, annotation, detail, office) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const r of rows) insert.run(r.zip, r.kind, r.lg5, r.pref, r.city, r.town, r.townRaw, r.annotation, r.detail, r.office);
    })();
    db.run('CREATE INDEX postal_zip ON postal(zip)');
    db.run('CREATE INDEX postal_lg5 ON postal(lg5)');
  } finally {
    db.close();
  }
}

export class PostalReader {
  private readonly db: Database;
  private readonly byZipStatement: Statement<DbRow, [string]>;
  private readonly byLg5Statement: Statement<DbRow, [string]>;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
    this.byZipStatement = this.db.prepare<DbRow, [string]>('SELECT * FROM postal WHERE zip = ? ORDER BY id');
    this.byLg5Statement = this.db.prepare<DbRow, [string]>("SELECT * FROM postal WHERE lg5 = ? AND kind = 'general' ORDER BY id");
  }

  byZip(zip: string): PostalRow[] {
    return this.byZipStatement.all(zip).map(toRow);
  }

  /** 市区町村（5 桁コード）の一般の行。事業所・私書箱は含めない。 */
  byLg5(lg5: string): PostalRow[] {
    return this.byLg5Statement.all(lg5).map(toRow);
  }

  close(): void {
    this.db.close();
  }
}

// ---------- 町域名の照合 ----------

const FOLD_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['大字', ''], ['字', ''], ['ヶ', 'ケ'], ['ヵ', 'カ'], ['ッ', 'ツ'], ['ノ', '之'], ['の', '之'], ['丁目', ''], [' ', ''], ['　', ''],
];

/** KEN_ALL の町域名と ABR の町字名を比べるために、表記の違いをそろえる。 */
export function foldName(input: string): string {
  let text = input.normalize('NFKC').replace(/[〇一二三四五六七八九十百]+/g, (run) => {
    try {
      return String(kanji2number(run));
    } catch {
      return run;
    }
  });
  for (const [from, to] of FOLD_REPLACEMENTS) text = text.split(from).join(to);
  return text;
}

export function parseChomeRange(annotation: string): { lo: number; hi: number } | null {
  const match = annotation.normalize('NFKC').match(/^(\d+)[〜~\-－−ー]\s*(\d+)丁目$/);
  return match ? { lo: Number(match[1]), hi: Number(match[2]) } : null;
}

/**
 * 番地の範囲（「１〜１０番地」）や番地の列挙（「３６４９、３６６１」）の注記に、住所の番地が入るか。
 * 番地を判定できない注記（階・建物・地割・「その他」など）や、番地の無い住所は null。
 */
export function annotationMatchesNumber(annotation: string, addr: string): boolean | null {
  const head = addr.match(/^(\d+)/)?.[1];
  if (!head) return null;
  const text = annotation.normalize('NFKC').replace(/[−‐‑–—ー－]/g, '-');
  const range = text.match(/^(\d+)[〜~](\d+)(?:番地?)?$/);
  if (range) {
    const n = Number(head);
    return n >= Number(range[1]) && n <= Number(range[2]);
  }
  if (/^\d+(?:-\d+)*(?:[、,]\d+(?:-\d+)*)*$/.test(text)) {
    return text.split(/[、,]/).some((entry) => addr === entry || addr.startsWith(`${entry}-`));
  }
  return null;
}

// ---------- 町字への結びつけ ----------

export interface TownRef {
  machiaza_id: string;
  oaza_cho?: string;
  koaza?: string;
  chome?: string;
  chome_n?: number;
  point?: [number, number];
}

export interface PostalLink {
  machiazaIds: string[];
  /** 注記（丁目の範囲など）まで解釈できて、この町字に当たること。 */
  exact: boolean;
}

/**
 * 同じ市区町村の一般の郵便番号の行を、ABR の町字に名前で結びつける。
 * 建物別の行（階の注記）、市区町村の既定行、町字に当たらない行は結果に含めない。
 */
export function linkPostalRows(rows: readonly PostalRow[], towns: readonly TownRef[]): Map<number, PostalLink> {
  const index = new Map<string, TownRef[]>();
  const add = (key: string, town: TownRef): void => {
    if (!key) return;
    const list = index.get(key);
    if (!list) index.set(key, [town]);
    else if (!list.includes(town)) list.push(town);
  };
  for (const town of towns) {
    const oaza = town.oaza_cho ?? '';
    const koaza = town.koaza ?? '';
    const chome = town.chome ?? '';
    add(foldName(oaza), town);
    if (koaza) {
      add(foldName(koaza), town);
      add(foldName(oaza + koaza), town);
    }
    if (chome) add(foldName(oaza + chome), town);
  }

  const items: Array<{ row: PostalRow; key: string }> = [];
  for (const row of rows) {
    if (row.kind !== 'general' || row.town === '' || row.annotation.includes('階')) continue;
    // 「一円」は漢数字の「一」を含むので、照合名にそろえる前に外す。
    const base = row.town.endsWith('一円') ? row.town.slice(0, -2) : row.town;
    items.push({ row, key: foldName(base) });
  }

  const links = new Map<number, PostalLink>();
  const taken = new Map<string, Set<string>>();
  // 丁目の範囲つきの行を先に結びつけ、「その他」の行が残りを受ける。
  for (const { row, key } of items) {
    const range = parseChomeRange(row.annotation);
    if (!range) continue;
    const ids = (index.get(key) ?? [])
      .filter((town) => town.chome_n !== undefined && town.chome_n >= range.lo && town.chome_n <= range.hi)
      .map((town) => town.machiaza_id);
    if (ids.length === 0) continue;
    links.set(row.id, { machiazaIds: ids, exact: true });
    const set = taken.get(key) ?? new Set<string>();
    for (const id of ids) set.add(id);
    taken.set(key, set);
  }
  for (const { row, key } of items) {
    if (links.has(row.id)) continue;
    const candidates = index.get(key) ?? [];
    if (candidates.length === 0) continue;
    if (row.annotation === '') {
      links.set(row.id, { machiazaIds: candidates.map((town) => town.machiaza_id), exact: true });
    } else if (row.annotation === 'その他') {
      const used = taken.get(key);
      const ids = candidates.filter((town) => !used?.has(town.machiaza_id)).map((town) => town.machiaza_id);
      if (ids.length > 0) links.set(row.id, { machiazaIds: ids, exact: true });
    } else if (parseChomeRange(row.annotation) === null) {
      links.set(row.id, { machiazaIds: candidates.map((town) => town.machiaza_id), exact: false });
    }
  }
  return links;
}

export interface ZipMatch {
  row: PostalRow;
  exact: boolean;
  /** 町字の専用番号が無く、市区町村の既定番号を返したこと。 */
  fallback: boolean;
}

/** 町字（と、分かれば住所の番地）に当たる郵便番号。exact のものを先に、同じ番号は 1 件にまとめる。 */
export function zipsForTown(
  rows: readonly PostalRow[],
  links: ReadonlyMap<number, PostalLink>,
  machiazaId: string,
  addr?: string,
): ZipMatch[] {
  const linked = rows.filter((row) => links.get(row.id)?.machiazaIds.includes(machiazaId));
  let matches: ZipMatch[];
  if (linked.length > 0) {
    matches = linked.map((row) => ({ row, exact: links.get(row.id)?.exact ?? false, fallback: false }));
    if (addr !== undefined) {
      const judged = matches.map((match) => ({ match, hit: annotationMatchesNumber(match.row.annotation, addr) }));
      const kept = judged.filter((item) => item.hit !== false);
      matches = kept.length > 0
        ? kept.map(({ match, hit }) => (hit === true ? { ...match, exact: true } : match))
        : matches.map((match) => ({ ...match, exact: false }));
    }
  } else {
    matches = rows.filter((row) => row.kind === 'general' && row.town === '').map((row) => ({ row, exact: false, fallback: true }));
  }
  const seen = new Set<string>();
  const result: ZipMatch[] = [];
  for (const match of [...matches].sort((a, b) => Number(b.exact) - Number(a.exact))) {
    if (seen.has(match.row.zip)) continue;
    seen.add(match.row.zip);
    result.push(match);
  }
  return result;
}
