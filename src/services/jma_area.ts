// 天気と警報で共通の地名の解決（気象庁の予報区・市町村の表 jma_areas.ts と、地名の表 city_map.ts から）
import { MUNICIPALITY_CITY_MAP } from '../city_map.js';
import { JMA_CLASS10, JMA_CLASS20, JMA_OFFICES, PREFECTURE_NAMES } from '../jma_areas.js';

export { MUNICIPALITY_CITY_MAP };

/** 地名・番号が見つからない、または 1 つに決まらない（入力の誤り。REST は 400） */
export class AreaInputError extends Error {}

/** 入力の文字列で表を引く（"constructor" などで Object の既定のプロパティを拾わない） */
const lookup = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** 番号の上 2 桁（都道府県コード）から都道府県名 */
export const prefectureOf = (code: string): string => PREFECTURE_NAMES[Number(code.slice(0, 2)) - 1] ?? '';

/** 都道府県名（"静岡県"・略称の "静岡"・"北海道"）なら 2 桁の都道府県コード */
export function prefectureCodeOf(name: string): string | undefined {
  const i = PREFECTURE_NAMES.findIndex((p) => name === p || name === p.replace(/[都府県]$/, ''));
  return i < 0 ? undefined : String(i + 1).padStart(2, '0');
}

/** 市町村。codes は気象庁の市町村（class20）の番号、class10 は最初の区域の予報区 */
export interface Municipality {
  name: string;
  codes: string[];
  class10: string;
}

/**
 * 名前 → 市町村。class20 の番号ごとに 1 つ（同じ名前が別の都道府県にもあれば複数）。気象庁が区域に分けた市（"横浜市北部"・"横浜市南部"、区ごとの
 * "神戸市中央区" など）は、区域を合わせた市全体（"横浜市"）も 1 つの市町村にする。市の名前そのままの区域が
 * ある市（郡山市と郡山市湖南）は、その名前を市全体にする。
 */
const MUNICIPALITIES = (() => {
  const byName = new Map<string, Municipality[]>();
  const add = (m: Municipality) => byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const cities = new Map<string, Municipality>(); // `${都道府県コード}${市の名前}` → 区域を合わせた市
  for (const [name, towns] of Object.entries(JMA_CLASS20)) {
    // 市の名前の後に続きがあれば、その市の区域（"余市町" などの町村と "四日市市" などの市は除く）
    const city = /[市町村]$/.test(name) ? undefined : name.match(/^(.+?市)./)?.[1];
    for (const t of towns) {
      add({ name, codes: [t.code], class10: t.class10 });
      if (!city) continue;
      const key = t.code.slice(0, 2) + city;
      const whole = cities.get(key) ?? { name: city, codes: [], class10: t.class10 };
      whole.codes.push(t.code);
      cities.set(key, whole);
    }
  }
  for (const [key, whole] of cities) {
    const same = byName.get(whole.name) ?? [];
    const main = same.find((m) => m.codes[0].startsWith(key.slice(0, 2)));
    if (main) {
      whole.codes.unshift(...main.codes);
      whole.class10 = main.class10;
    }
    byName.set(whole.name, [...same.filter((m) => m !== main), whole]);
  }
  return byName;
})();

/** 名前に当たる市町村（"上野" なら上野・上野市・上野区・上野町・上野村） */
const townsNamed = (name: string): Municipality[] =>
  MUNICIPALITIES.get(name) ?? ['市', '区', '町', '村'].flatMap((suffix) => MUNICIPALITIES.get(name + suffix) ?? []);

/**
 * 市町村を名前から引く。市・区・町・村は省いてよい（"札幌" → 札幌市）。先頭の都道府県名で同じ名前の候補を絞り
 * （"北海道森町"）、政令指定都市の区は市全体に当てる（"横浜市中区" → 横浜市。区ごとの区域がある神戸市・広島市の
 * 区と、東京の特別区はその区のまま）。郡の付いた住所は、当たらなければ郡を外して引き直す（"北海道上川郡上川町" → 上川町。
 * 小郡市・郡山市などは先に当たるので外さない）。当たらなければ undefined。候補が複数残れば候補を挙げたエラー。
 */
export function resolveMunicipality(query: string): Municipality | undefined {
  const s = query.replace(/\s/g, '');
  const pref = PREFECTURE_NAMES.find((p) => s.startsWith(p) && s.length > p.length);
  let name = pref ? s.slice(pref.length) : s;
  const city = name.match(/^(.+?市).+区$/)?.[1];
  if (city && !MUNICIPALITIES.has(name) && MUNICIPALITIES.has(city)) name = city;
  const hits = townsNamed(name).filter((m) => !pref || prefectureOf(m.codes[0]) === pref);
  const town = name.replace(/^[^郡]+郡/, '');
  if (hits.length === 0 && town && town !== name) return resolveMunicipality((pref ?? '') + town);
  if (hits.length > 1) {
    const names = hits.map((m) => prefectureOf(m.codes[0]) + m.name);
    throw new AreaInputError(`地名「${query}」に当たる市町村が複数あります（${names.join('、')}）。都道府県名や市・区・町・村まで付けてください（例: ${names[0]}）`);
  }
  return hits[0];
}

/** 市町村の番号（class20）→ 名前と予報区 */
export const TOWN_BY_CODE = new Map(
  Object.entries(JMA_CLASS20).flatMap(([name, towns]) => towns.map((t) => [t.code, { name, class10: t.class10 }] as const)),
);

/** 区域の番号 → その区域を含む市全体（区域に分かれた市だけ） */
const WHOLE_CITY_BY_CODE = new Map(
  [...MUNICIPALITIES.values()].flat().filter((m) => m.codes.length > 1).flatMap((m) => m.codes.map((c) => [c, m] as const)),
);

/** 番号がすべて同じ市の区域なら、その市全体 */
export function wholeCityOf(codes: string[]): Municipality | undefined {
  const city = WHOLE_CITY_BY_CODE.get(codes[0]);
  return city && codes.every((c) => city.codes.includes(c)) ? city : undefined;
}

/**
 * 気象庁の予報区の名前 → 予報区の番号。同じ名前の予報区が無い名前（"十勝地方" "下北"）、末尾の「地方」を除いた形（"宗谷" "大東島"）と、
 * 予報区の 2 つ目以降の気温の地点の名前（最初の地点は city_map にある）。2 つの予報区に当たる名前（"東部" など）は除く
 */
const AREA_NAMES = (() => {
  const codes = new Map<string, Set<string>>();
  const add = (name: string, code: string) => codes.set(name, (codes.get(name) ?? new Set<string>()).add(code));
  for (const [code, area] of Object.entries(JMA_CLASS10)) {
    add(area.name, code);
    if (/.地方$/.test(area.name)) add(area.name.slice(0, -2), code);
    for (const point of area.points.slice(1)) add(point, code);
  }
  return new Map([...codes].filter(([, c]) => c.size === 1).map(([name, c]) => [name, [...c][0]]));
})();

/** 気象台の名前（"上川・留萌地方" "八重山地方" など。予報区と同じ名前のものと都道府県名は除く）→ 気象台の番号 */
const OFFICE_NAMES = new Map(
  Object.entries(JMA_OFFICES).filter(([, name]) => !AREA_NAMES.has(name) && !PREFECTURE_NAMES.includes(name)).map(([code, name]) => [name, code]),
);

/** 気象台の名前なら気象台の番号（警報はその範囲を合わせる。天気では予報区を挙げたエラー） */
export const officeCodeOf = (name: string): string | undefined => OFFICE_NAMES.get(name);

/** 地名の解決の結果。class10 は予報区、town は市町村（区域に分かれた市は市全体）に当たったとき */
export interface Place {
  class10: string;
  town?: Municipality;
}

/**
 * 天気と警報で共通の地名の解決。
 * 1. 市町村の名前そのまま（候補が 1 つ。"横浜市" などの市全体を含む）
 * 2. city_map の地名（都道府県名・気温の地点の名前を含む）→ その予報区。town: true（警報）では、地名に「市」「区」を
 *    足した市町村が同じ予報区にあればその市町村（"横浜" → 横浜市。"八幡" は京都府八幡市が別の予報区なので北九州地方のまま）
 * 3. 気象庁の予報区の名前（AREA_NAMES。「地方」を除いた形と 2 つ目以降の気温の地点を含む）→ その予報区。ほかの予報区の市町村にも
 *    当たる名前（"上野" "池田" "日高"）は、市町村と予報区を挙げたエラー。気象台の名前は、その予報区の番号と名前を挙げたエラー
 * 4. 市町村の表（都道府県名の付いた名前・政令指定都市の区・市区町村の省略・郡の付いた住所）。候補が複数なら候補を挙げたエラー
 * 5. city_map の部分一致（先頭が都道府県名なら、その都道府県の地名だけ）。どれにも当たらなければエラー
 * 警報は、都道府県名と気象台の名前をこの前に県全体・気象台の範囲にする（disaster.ts）。天気では、city_map に無い都道府県名
 * （気象台が複数ある北海道）は、予報区の番号と名前を挙げたエラー
 */
export function resolvePlace(query: string, { town: preferTown = false } = {}): Place {
  const clean = query.trim();
  const exact = MUNICIPALITIES.get(clean);
  if (exact?.length === 1) return { class10: exact[0].class10, town: exact[0] };

  const mapped = lookup(MUNICIPALITY_CITY_MAP, clean);
  if (mapped) {
    const towns = preferTown
      ? [`${clean}市`, `${clean}区`].flatMap((n) => MUNICIPALITIES.get(n) ?? []).filter((m) => m.codes.some((c) => TOWN_BY_CODE.get(c)?.class10 === mapped))
      : [];
    return towns.length === 1 ? { class10: mapped, town: towns[0] } : { class10: mapped };
  }

  const area = AREA_NAMES.get(clean);
  if (area) {
    const towns = townsNamed(clean);
    if (towns.some((m) => !m.codes.some((c) => TOWN_BY_CODE.get(c)?.class10 === area))) {
      const point = JMA_CLASS10[area].points.includes(clean) ? 'の気温の地点' : '';
      throw new AreaInputError(
        `地名「${clean}」は、市町村（${towns.map((m) => prefectureOf(m.codes[0]) + m.name).join('、')}）と気象庁の予報区（${area}: ${prefectureOf(area)}${JMA_CLASS10[area].name}${point}）に当たります。都道府県名や市・区・町・村まで付けるか、予報区の番号で指定してください`,
      );
    }
    return { class10: area };
  }
  const office = OFFICE_NAMES.get(clean);
  if (office) {
    const areas = Object.entries(JMA_CLASS10).filter(([, a]) => a.office === office).map(([c, a]) => `${c}（${a.name}）`);
    throw new AreaInputError(`気象台の範囲「${clean}」からは予報区が 1 つに決まりません。予報区の番号か名前で指定してください: ${areas.join('、')}`);
  }

  const town = resolveMunicipality(clean);
  if (town) return { class10: town.class10, town };

  const prefCode = prefectureCodeOf(clean);
  if (prefCode) {
    const areas = Object.entries(JMA_CLASS10).filter(([c]) => c.startsWith(prefCode)).map(([c, a]) => `${c}（${a.name}）`);
    throw new AreaInputError(`都道府県名「${clean}」からは予報区が 1 つに決まりません。予報区の番号か市町村の名前で指定してください: ${areas.join('、')}`);
  }
  const pref = PREFECTURE_NAMES.find((p) => clean.startsWith(p));
  for (const [key, id] of Object.entries(MUNICIPALITY_CITY_MAP)) {
    if (key.length >= 2 && (!pref || prefectureOf(id) === pref) && (clean.includes(key) || key.includes(clean))) return { class10: id };
  }
  throw new AreaInputError(`地名「${clean}」が見つかりません`);
}

/** 都市名または都道府県名から 6 桁の予報区の番号を解決する（6 桁の数字はそのまま）。見つからなければエラー */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  return /^\d{6}$/.test(clean) ? clean : resolvePlace(clean).class10;
}
