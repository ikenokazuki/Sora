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

/** 都道府県名（"静岡県"・略称の "静岡"・"北海道"。空白は無視する）なら 2 桁の都道府県コード */
export function prefectureCodeOf(name: string): string | undefined {
  const s = name.replace(/\s/g, '');
  const i = PREFECTURE_NAMES.findIndex((p) => s === p || s === p.replace(/[都府県]$/, ''));
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
  // 区域に分かれた市: 市の名前の後に続きがある名前の市（"余市町" などの町村と "四日市市" などの市は除く）
  const split = new Set(
    Object.entries(JMA_CLASS20).flatMap(([name, towns]) => {
      const city = /[市町村]$/.test(name) ? undefined : name.match(/^(.+?市)./)?.[1];
      return city ? towns.map((t) => t.code.slice(0, 2) + city) : [];
    }),
  );
  for (const [name, towns] of Object.entries(JMA_CLASS20)) {
    // その市の名前で始まる名前は、続きが市で終わっても区域（"日光市今市"）
    const city = name.match(/^(.+?市)./)?.[1];
    for (const t of towns) {
      add({ name, codes: [t.code], class10: t.class10 });
      if (!city || !split.has(t.code.slice(0, 2) + city)) continue;
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

/** 途中に郡を含む市町村の名前（蒲郡市・小郡市・上郡町・大和郡山市。郡で始まる郡上市・郡山市は除く） */
const GUN_TOWNS = [...MUNICIPALITIES.keys()].filter((n) => n.indexOf('郡') > 0);
/** s の k 文字目の郡が、その前から始まる市町村の名前の中か（"蒲郡市川町" "上郡町上郡" の郡。郡の名前の終わりではない） */
const inGunTown = (s: string, k: number): boolean => GUN_TOWNS.some((n) => k >= n.indexOf('郡') && s.startsWith(n, k - n.indexOf('郡')));

/**
 * 市町村を名前から引く。市・区・町・村は省いてよい（"札幌" → 札幌市）。先頭の都道府県名で同じ名前の候補を絞り
 * （"北海道森町"）、政令指定都市の区は市全体に当てる（"横浜市中区" → 横浜市。区ごとの区域がある神戸市・広島市の
 * 区と、東京の特別区はその区のまま）。郡の付いた住所は、当たらず郡の後ろが市町村の名前そのままなら、その名前で引き直す（"北海道上川郡上川町" →
 * 上川町。"交野市郡津" の津は市町村の名前でないので引き直さない。郡が市町村の名前の中の "蒲郡市川町" も）。当たらなければ undefined。候補が複数残れば候補を挙げたエラー。
 */
export function resolveMunicipality(query: string): Municipality | undefined {
  const s = query.replace(/\s/g, '');
  const pref = PREFECTURE_NAMES.find((p) => s.startsWith(p) && s.length > p.length);
  let name = pref ? s.slice(pref.length) : s;
  const city = name.match(/^(.[^市]*市).+区$/)?.[1];
  if (city && !MUNICIPALITIES.has(name) && MUNICIPALITIES.has(city)) name = city;
  const hits = townsNamed(name).filter((m) => !pref || prefectureOf(m.codes[0]) === pref);
  const gun = name.match(/^[^郡]+郡/)?.[0] ?? '';
  const town = name.slice(gun.length);
  if (hits.length === 0 && gun && MUNICIPALITIES.has(town) && !inGunTown(name, gun.length - 1)) return resolveMunicipality((pref ?? '') + town);
  if (hits.length > 1) {
    const names = hits.map((m) => prefectureOf(m.codes[0]) + m.name);
    throw new AreaInputError(`地名「${query}」に当たる市町村が複数あります（${names.join('、')}）。都道府県名や市・区・町・村まで付けてください`);
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
 * 予報区の 2 つ目以降の気温の地点の名前（最初の地点は city_map にある）。2 つの予報区に当たる名前（"東部" など）は、都道府県名を付けた形
 * （"神奈川県東部"）だけ
 */
const AREA_NAMES = (() => {
  const codes = new Map<string, Set<string>>();
  const add = (name: string, code: string) => codes.set(name, (codes.get(name) ?? new Set<string>()).add(code));
  for (const [code, area] of Object.entries(JMA_CLASS10)) {
    add(area.name, code);
    if (/.地方$/.test(area.name)) add(area.name.slice(0, -2), code);
    for (const point of area.points.slice(1)) add(point, code);
  }
  for (const [name, c] of [...codes]) if (c.size > 1) for (const code of c) add(prefectureOf(code) + name, code);
  return new Map([...codes].filter(([, c]) => c.size === 1).map(([name, c]) => [name, [...c][0]]));
})();

/** 気象台の名前（"上川・留萌地方" "八重山地方" など。予報区と同じ名前のものと都道府県名は除く）→ 気象台の番号 */
const OFFICE_NAMES = new Map(
  Object.entries(JMA_OFFICES).filter(([, name]) => !AREA_NAMES.has(name) && !PREFECTURE_NAMES.includes(name)).map(([code, name]) => [name, code]),
);

/** 気象台の名前（空白は無視する）なら気象台の番号（警報はその範囲を合わせる。天気では予報区を挙げたエラー） */
export const officeCodeOf = (name: string): string | undefined => OFFICE_NAMES.get(name.replace(/\s/g, ''));

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
 * 5. 一部の一致（partialPlace）。どれにも当たらなければエラー
 * 入力の中の空白はどの段でも無視する。警報は、都道府県名と気象台の名前をこの前に県全体・気象台の範囲にする（disaster.ts）。天気では、
 * city_map に無い都道府県名（気象台が複数ある北海道）は、予報区の番号と名前を挙げたエラー
 */
export function resolvePlace(query: string, { town: preferTown = false } = {}): Place {
  const clean = query.replace(/\s/g, '');
  const place = exactPlace(clean, preferTown);
  if (place) return place;
  const id = partialPlace(clean);
  if (id) return { class10: id };
  throw new AreaInputError(`地名「${clean}」が見つかりません。市区町村の名前（〜市・〜区・〜町・〜村）か、都道府県名を付けた名前で指定してください`);
}

/** resolvePlace の 1〜4（名前そのまま）。当たらなければ undefined、1 つに決まらなければ候補を挙げたエラー */
function exactPlace(clean: string, preferTown: boolean): Place | undefined {
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
  return undefined;
}

/** 2 文字以上の city_map の地名（一部の一致に使う） */
const CITY_KEYS = Object.keys(MUNICIPALITY_CITY_MAP).filter((k) => k.length >= 2);

/** 区域に分かれた市町村の名前（"釧路市" "八雲町"。区域の名前 "釧路市阿寒" "八雲町熊石" の前の部分） */
const SPLIT_TOWNS = new Set(
  Object.keys(JMA_CLASS20).flatMap((n) => (/[市町村]$/.test(n) ? [] : (n.match(/^(.+?[市町村])./)?.[1] ?? []))),
);
/** 区域の名前から市町村の名前を除いた部分（"釧路市阿寒" の阿寒、"日光市今市" の今市。"東村山市" は区域ではない） */
const AREA_PARTS = Object.keys(JMA_CLASS20).flatMap((n) => [...SPLIT_TOWNS].filter((t) => n.startsWith(t) && n.length > t.length).map((t) => n.slice(t.length)));

/**
 * 地名として読む 2 文字以上の名前: city_map の地名、市町村の名前と市区町村を省いた形、区域の名前の部分（"釧路市阿寒" の阿寒）、予報区・気象台の名前、
 * 気温の地点、都道府県名
 */
const PLACE_NAMES = new Set(
  [
    ...CITY_KEYS,
    ...[...MUNICIPALITIES.keys()].flatMap((n) => [n, n.replace(/[市区町村]$/, '')]),
    ...AREA_PARTS,
    ...Object.values(JMA_CLASS10).flatMap((a) => [a.name, a.name.replace(/地方$/, ''), ...a.points]),
    ...Object.values(JMA_OFFICES),
    ...PREFECTURE_NAMES.flatMap((p) => [p, p.replace(/[都府県]$/, '')]),
  ].filter((n) => n.length >= 2),
);
// 高原は宮崎県高原町の名前だが、地名の後ろに付く普通の言葉でもあるので、一部の一致には使わない（"美ヶ原高原" を高原町にしない）
PLACE_NAMES.delete('高原');
const LONGEST_NAME = Math.max(...[...PLACE_NAMES].map((n) => n.length));

/** s の i 文字目から始まる、いちばん長い地名（names は市町村の名前だけで探すとき） */
function placeNameAt(s: string, i: number, names: { has(name: string): boolean } = PLACE_NAMES): string | undefined {
  for (let n = Math.min(LONGEST_NAME, s.length - i); n >= 2; n--) if (names.has(s.slice(i, i + n))) return s.slice(i, i + n);
  return undefined;
}

/**
 * 入力の中でいちばん前から始まる地名（同じ位置なら長い方）。すぐ後ろに郡が続く名前は郡の名前（"安芸郡江田島町" の安芸）なので飛ばし、郡の後ろから探す。
 * 市区町村の名前（"鹿児島市郡元" の郡元は町名）と、郡から地名が始まるとき（"美濃郡上八幡" の郡上）は飛ばさない
 */
function firstPlaceName(s: string): string | undefined {
  for (let i = 0; i < s.length - 1; i++) {
    const name = placeNameAt(s, i);
    if (!name) continue;
    const k = i + name.length;
    if (s[k] !== '郡' || /[市区町村]$/.test(name) || placeNameAt(s, k)) return name;
    i = k;
  }
  return undefined;
}

/**
 * 郡の後ろから始まる市町村の名前（いちばん長いもの。"足柄上郡中井町比奈窪" の中井町、"中新川郡上市町" は郡上市でなく上市町）。郡が市町村の名前の中
 * （"蒲郡市原" "上郡町上郡"）のときと、郡の前が市町村の名前（"交野市郡津市"。郡〜は町名）のときは除く
 */
function townAfterGun(s: string): string | undefined {
  for (let k = s.indexOf('郡'); k >= 0; k = s.indexOf('郡', k + 1)) {
    const town = placeNameAt(s, k + 1, MUNICIPALITIES);
    if (town && !inGunTown(s, k) && !MUNICIPALITIES.has(s.slice(0, k))) return town;
  }
  return undefined;
}

/**
 * resolvePlace の 5（一部の一致）の予報区。先頭の都道府県名（正式名か短い形）は、先頭でいちばん長い地名で、後ろに 2 文字以上続くときだけ外し
 * （"鹿児島市桜島" は鹿児島市、"宮城島" は外さない）、その後ろをその都道府県の地名だけで引く（そのまま地名ならそれ。何も当たらなければ都道府県の予報区）。
 * - 入力（2 文字以上）が city_map の地名の書き出しか、区域に分かれた市町村の名前の後ろ（"富士河口" → 富士河口湖町、"乗鞍" → 松本市乗鞍上高地、
 *   "垂水区" → 神戸市垂水区）なら、そう当たる地名がすべて同じ予報区のときだけ。地名の途中（"九州" と北九州、"山市" と東村山市）は当てない
 * - それ以外は、入力の中でいちばん前から始まる地名を 1〜4 と上の決まりで引く。ほかの地名の途中や重なりは拾わない（"日光市中宮祠" は光市でなく
 *   日光市、"函館山" は館山でなく函館）。その地名が 1 つに決まらなければ、入力を挙げた候補のエラー
 * - 「〜島」（「〜半島」は除く）で終わる入力は、いちばん前の地名を次のときだけ使う。都道府県名で始まるとき。市区町村の名前のとき（"江東区大島"）。
 *   「〜島」の名前が先頭のとき（"宮古島伊良部島"）。名前に「島」が付いて別の地名になる形（"小浜島" を福井県の小浜市にする形）と、市区町村を省いた
 *   名前の後ろに「〜島」の別の語が続く形（"安芸江田島" "金沢八景島"。先頭の名前はほかの県の地名と同じことが多い）は当てない。地名の書き出しに
 *   当たる形（"粟島" → 粟島浦村）はそのまま
 * - 郡の後ろに市町村の名前があれば、その市町村（"足柄上郡中井町比奈窪" は中井町。上郡町の上郡や久慈市の久慈にしない）。いちばん前の地名では、すぐ後ろに
 *   郡が続く名前（郡の名前。"安芸郡江田島町" の安芸）を飛ばす（firstPlaceName・townAfterGun）
 */
function partialPlace(clean: string): string | undefined {
  const lead = placeNameAt(clean, 0);
  // 都道府県名のすぐ後ろの郡が地名の始まりでなければ、郡の名前の一部（"愛知郡愛荘町" は滋賀県。"福島郡山" は福島県の郡山）
  const gunName = lead && clean[lead.length] === '郡' && !placeNameAt(clean, lead.length);
  const prefCode = lead && clean.length - lead.length >= 2 && !gunName ? prefectureCodeOf(lead) : undefined;
  const pref = prefCode ? PREFECTURE_NAMES[Number(prefCode) - 1] : undefined;
  const rest = pref && lead ? clean.slice(lead.length) : clean;
  const inPref = (id?: string) => (id && (!pref || prefectureOf(id) === pref) ? id : undefined);
  // part が書き出しか、区域に分かれた市町村の名前の後ろに当たる city_map の地名。当たらなければ undefined、1 つに決まらなければ null。
  // 区域に分かれた町の区域どうし（"八雲町八雲" と "八雲町熊石"）は、予報区が違っても最初の区域
  const fragment = (part: string): string | null | undefined => {
    const at = (k: string, i = k.indexOf(part)) => i === 0 || (i > 0 && SPLIT_TOWNS.has(k.slice(0, i)));
    const keys = part.length >= 2 ? CITY_KEYS.filter((k) => at(k) && inPref(MUNICIPALITY_CITY_MAP[k])) : [];
    const townOf = (k: string) => k.match(/^.+?[市町村](?=.)/)?.[0] ?? k;
    if (keys.length === 0) return undefined;
    return new Set(keys.map((k) => MUNICIPALITY_CITY_MAP[k])).size === 1 || new Set(keys.map(townOf)).size === 1 ? MUNICIPALITY_CITY_MAP[keys[0]] : null;
  };
  // 名前そのまま（city_map と 1〜4）の予報区。1 つに決まらなければ、入力を挙げた候補のエラー。都道府県名を外したときは、その都道府県のものだけを見る
  const exactOf = (name: string): string | undefined => {
    try {
      const id = inPref(lookup(MUNICIPALITY_CITY_MAP, name)) ?? exactPlace((pref ?? '') + name, false)?.class10;
      if (id || !pref) return id;
    } catch (err) {
      if (err instanceof AreaInputError) throw new AreaInputError(err.message.replace(/「[^」]*」/, () => `「${clean}」`));
      throw err;
    }
    try {
      return inPref(exactPlace(name, false)?.class10);
    } catch (err) {
      if (err instanceof AreaInputError) return undefined;
      throw err;
    }
  };
  const fallback = () => (pref ? inPref(lookup(MUNICIPALITY_CITY_MAP, pref)) : undefined);
  const whole = pref ? exactOf(rest) : undefined;
  if (whole) return whole;
  const hit = fragment(rest);
  if (hit !== undefined) return hit ?? undefined;
  const town = townAfterGun(rest);
  const townId = town && exactOf(town);
  if (townId) return townId;
  const name = firstPlaceName(rest);
  if (!name) return fallback();
  let id: string | undefined;
  let ambiguous: AreaInputError | undefined;
  try {
    id = exactOf(name) ?? fragment(name) ?? undefined;
  } catch (err) {
    if (!(err instanceof AreaInputError)) throw err;
    ambiguous = err;
  }
  if (/[^半]島$/.test(clean) && !pref && !islandHead(rest, name, id)) return undefined;
  if (ambiguous) throw ambiguous;
  return id ?? fallback();
}

/** 「〜島」で終わる入力（都道府県名なし）で、いちばん前の地名 name を使ってよいか（partialPlace の「〜島」の決まり）。id は name の予報区 */
function islandHead(rest: string, name: string, id: string | undefined): boolean {
  if (/[市区町村]$/.test(name) || (name.endsWith('島') && rest.startsWith(name))) return true;
  // 残りが市区町村の名前で始まり、いちばん前の地名がその予報区（"広島市中島" は広島市中区の中島。"東村山島" は沖縄県の東村にしない）
  const head = rest.slice(0, LONGEST_NAME + 1);
  const town = [...head].map((_, n) => head.slice(0, n)).find((s) => s.length >= 2 && /[市区町村]$/.test(s) && PLACE_NAMES.has(s));
  return !!town && !!id && placeAreaOf(town) === id;
}

/** 市区町村の名前の予報区（1 つに決まらなければ undefined） */
function placeAreaOf(town: string): string | undefined {
  try {
    return lookup(MUNICIPALITY_CITY_MAP, town) ?? exactPlace(town, false)?.class10;
  } catch (err) {
    if (err instanceof AreaInputError) return undefined;
    throw err;
  }
}

/** 都市名または都道府県名から 6 桁の予報区の番号を解決する（6 桁の数字はそのまま）。見つからなければエラー */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  return /^\d{6}$/.test(clean) ? clean : resolvePlace(clean).class10;
}
