import { describe, expect, it } from 'bun:test';
import { MUNICIPALITY_CITY_MAP } from './city_map.js';
import { JMA_CLASS10, JMA_CLASS20, PREFECTURE_NAMES } from './jma_areas.js';
import { AreaInputError, resolveCityId, resolveMunicipality } from './services/jma_area.js';

// city_map.ts（地名 → 予報区）が、気象庁の表（jma_areas.ts）と食い違わないことを確かめる
const PREFECTURES = new Set(PREFECTURE_NAMES.flatMap((p) => [p, p.replace(/[都府県]$/, '')]));
const CLASS10_OF = new Map(Object.values(JMA_CLASS20).flat().map((t) => [t.code, t.class10]));
/** 気象庁の気温の地点（短期予報・週間予報）の [予報区, 地点の名前, 予報区の何番目の地点か] */
const POINT_AREAS = Object.entries(JMA_CLASS10).flatMap(([code, v]) => v.points.map((p, i) => [code, p, i] as const));
const POINTS = new Set(POINT_AREAS.map(([, p]) => p));
/** 名前に当たる市町村（その名前と、名前+市・区・町・村。区域に分かれた市は区域を合わせて 1 つ）ごとの予報区の集まり */
const townAreas = (p: string): Set<string>[] => {
  const towns = new Map<string, Set<string>>();
  for (const [name, list] of Object.entries(JMA_CLASS20)) {
    const base = ['', '市', '区', '町', '村'].map((s) => p + s).find((n) => name === n || (n.endsWith('市') && name.startsWith(n) && !/[市町村]$/.test(name)));
    for (const t of base ? list : []) towns.set(t.code.slice(0, 2) + base, (towns.get(t.code.slice(0, 2) + base) ?? new Set<string>()).add(t.class10));
  }
  return [...towns.values()];
};
/** 1〜4 の段（名前そのまま）で引ける名前: city_map の地名、市町村の名前と市区町村を省いた形、予報区の名前と「地方」を除いた形、気温の地点 */
const EXACT = new Set([
  ...Object.keys(MUNICIPALITY_CITY_MAP),
  ...Object.keys(JMA_CLASS20).flatMap((n) => [n, n.replace(/[市区町村]$/, '')]),
  ...Object.values(JMA_CLASS10).flatMap((a) => [a.name, a.name.replace(/地方$/, '')]),
  ...POINTS,
]);
/** city_map の地名の書き出し（"日高川" は日高川町川辺の書き出し） */
const KEY_PREFIXES = new Set(Object.keys(MUNICIPALITY_CITY_MAP).flatMap((k) => [...k].map((_, i) => k.slice(0, i + 1))));
/** 一部の一致を確かめる元の名前: 市町村の名前と市区町村を省いた形（2 文字以上）、予報区の名前 */
const BASE_NAMES = [...new Set([...Object.keys(JMA_CLASS20).flatMap((n) => [n, n.replace(/[市区町村]$/, '')]), ...Object.values(JMA_CLASS10).map((a) => a.name)])].filter((n) => n.length >= 2);
/** 天気の解決の結果（入力の誤りはその文） */
const resolved = (name: string): string => {
  try {
    return resolveCityId(name);
  } catch (err) {
    if (!(err instanceof AreaInputError)) throw err;
    return `error: ${err.message}`;
  }
};

describe('city_map.ts と気象庁の表', () => {
  it('値はすべて気象庁の予報区の番号', () => {
    expect(Object.entries(MUNICIPALITY_CITY_MAP).filter(([, v]) => !JMA_CLASS10[v])).toEqual([]);
  });

  it('市町村の名前そのままの地名（候補が 1 つ）は、その市町村の予報区', () => {
    const bad = Object.entries(MUNICIPALITY_CITY_MAP).filter(([k, v]) => JMA_CLASS20[k]?.length === 1 && JMA_CLASS20[k][0].class10 !== v);
    expect(bad).toEqual([]);
  });

  it('気温の地点の名前: 予報区の最初の地点と、ほかの予報区の市町村に当たらない 2 つ目以降の地点は、city_map でその予報区', () => {
    // ほかの予報区の市町村と重なる 2 つ目以降の地点は、市町村の表から決める（表を作り直して重なる地点が増えたら、ここで落ちる）
    const shared = POINT_AREAS.filter(([code, p, i]) => i > 0 && townAreas(p).some((areas) => !areas.has(code)));
    expect(shared.map(([, p]) => p).sort()).toEqual(['上野', '大野', '池田', '湯沢'].sort());
    const bad = POINT_AREAS.filter((pa) => !shared.includes(pa)).filter(([code, p]) => MUNICIPALITY_CITY_MAP[p] !== code || resolved(p) !== code);
    expect(bad.map(([code, p]) => `${p}: ${code}`)).toEqual([]);
    // 重なる地点は city_map に載せず（載せると候補のエラーを飛ばす）、市町村と、その地点の予報区を挙げたエラー
    expect(shared.filter(([, p]) => Object.hasOwn(MUNICIPALITY_CITY_MAP, p))).toEqual([]);
    expect(shared.filter(([code, p]) => !resolved(p).startsWith(`error: 地名「${p}」は、市町村（`) || !resolved(p).includes(`（${code}: `))).toEqual([]);
    expect(resolved('湯沢')).toContain('秋田県湯沢市、新潟県湯沢町）と気象庁の予報区（150020: 新潟県中越の気温の地点）');
    // 2 つ目以降の地点で、市町村が同じ予報区にしか無い名前（前は候補のエラー・別の県・部分一致になっていた）
    const second: Array<[string, string]> = [['津川', '150010'], ['田島', '070030'], ['古川', '040010'], ['横手', '050020'], ['郡山', '070010']];
    expect(second.filter(([p, code]) => !JMA_CLASS10[code].points.slice(1).includes(p) || resolved(p) !== code)).toEqual([]);
  });

  it('都道府県名は、市町村の表より先に city_map の予報区になる', () => {
    const bad = [...PREFECTURES].filter((p) => MUNICIPALITY_CITY_MAP[p] && resolveCityId(p) !== MUNICIPALITY_CITY_MAP[p]);
    expect(bad).toEqual([]);
  });

  it('都道府県の正式名（○○県・都・府）と短い形は、天気で同じ予報区になる', () => {
    const pairs = PREFECTURE_NAMES.map((p) => [p, p.replace(/[都府県]$/, '')]).filter(([full, short]) => full !== short);
    expect(pairs).toHaveLength(46);
    expect(pairs.filter(([full, short]) => resolved(full) !== resolved(short)).map(([full, short]) => `${full} ${resolved(full)} / ${short} ${resolved(short)}`)).toEqual([]);
  });

  it('市町村に当たる地名はその予報区、複数の市町村に当たる地名は載せない（都道府県名と気温の地点の名前は除く）', () => {
    const bad: string[] = [];
    for (const [key, value] of Object.entries(MUNICIPALITY_CITY_MAP)) {
      if (PREFECTURES.has(key) || POINTS.has(key)) continue;
      try {
        const town = resolveMunicipality(key);
        if (town && !town.codes.some((c) => CLASS10_OF.get(c) === value)) bad.push(`${key}: ${value}`);
      } catch (err) {
        if (!(err instanceof AreaInputError)) throw err;
        bad.push(`${key}: 複数の市町村`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('市町村で無い地名の誤り（島・温泉）を直してある', () => {
    for (const k of ['石垣島', '竹富島', '西表島']) expect(resolveCityId(k)).toBe('474010');
    // 部分一致で別の県（大阪府大東市・神奈川県座間市）にしない
    for (const k of ['南大東島', '北大東島', '大東諸島']) expect([k, resolveCityId(k)]).toEqual([k, '472000']);
    expect(resolveCityId('座間味島')).toBe('471010');
    expect(resolveCityId('鬼怒川')).toBe('090020');
    expect(() => resolveCityId('千代田')).toThrow(/東京都千代田区、群馬県千代田町/);
  });

  it('「〜島」は、一部の一致で「〜島」で終わらない地名に当てず、見つからないエラー（小浜島を福井県の小浜市にしない）', () => {
    for (const n of ['小浜島', '沖縄県小浜島', '伊豆諸島', '宮古列島', '気仙沼大島', '志賀島']) expect(resolved(n)).toBe(`error: 地名「${n}」が見つかりません`);
    // 「〜島」の地名に当たるもの、「〜島」の名前そのもの、島ではない「〜半島」は今のまま
    const keep: Array<[string, string]> = [['五島列島', '420040'], ['石垣島', '474010'], ['宮古島', '473000'], ['東京都八丈島', '130030'], ['知床半島', '013010'], ['伊豆半島', '220020']];
    expect(keep.filter(([n, code]) => resolved(n) !== code)).toEqual([]);
    // 市町村・予報区の名前 +「島」（その名前の地名が無いもの）は、どれも見つからない
    const island = BASE_NAMES.filter((n) => !n.endsWith('島') && !EXACT.has(`${n}島`));
    expect(island.length).toBeGreaterThan(3000);
    expect(island.filter((n) => !resolved(`${n}島`).startsWith('error: ')).map((n) => `${n}島: ${resolved(`${n}島`)}`)).toEqual([]);
  });

  it('一部の一致は、入力の中でいちばん前から始まる地名で引く（ほかの地名の途中や重なりを拾って別の県にしない）', () => {
    const cases: Array<[string, string]> = [
      ['日光市中宮祠', '090020'], ['苫小牧市錦町', '015010'], ['北上市本通り', '030010'], ['美濃加茂市太田町', '210010'], ['札幌市中央区北一条西', '016010'],
      ['千葉県銚子市犬吠埼', '120020'], ['函館山', '017010'], ['北上川', '030010'], ['東京都新宿区西新宿', '130010'], ['箱根温泉', '140020'], ['下北半島', '020020'],
      ['青森県下北半島', '020020'], ['北海道宗谷岬', '011000'],
    ];
    expect(cases.filter(([q, code]) => resolved(q) !== code).map(([q]) => `${q}: ${resolved(q)}`)).toEqual([]);
    // 地名の後ろに町名や山・川・温泉が付いた形（その名前の地名が無いもの）は、地名だけのときと同じ予報区か、どちらもエラー
    const same = (n: string, q: string) => resolved(q) === resolved(n) || (resolved(q).startsWith('error: ') && resolved(n).startsWith('error: '));
    const towns = Object.keys(JMA_CLASS20).filter((n) => !same(n, `${n}本町`)).map((n) => `${n}本町: ${resolved(`${n}本町`)}（${resolved(n)}）`);
    expect(towns).toEqual([]);
    const forms = BASE_NAMES.flatMap((n) => ['山', '川', '温泉'].map((s) => [n, n + s])).filter(([, q]) => !EXACT.has(q) && !KEY_PREFIXES.has(q));
    expect(forms.length).toBeGreaterThan(9000);
    expect(forms.filter(([n, q]) => !same(n, q)).map(([n, q]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
  });

  it('入力が地名の書き出しか、地名の中の市区町村の名前の後ろなら、そう当たる地名が 1 つの予報区にまとまるときだけ当てる', () => {
    expect([resolved('富士河口'), resolved('苫小')]).toEqual(['190020', '015010']);
    // 区域が 2 つの予報区に分かれた町は、最初の区域の予報区（前と同じ）
    expect([resolved('八雲町'), resolved('八雲'), resolved('大和町')]).toEqual(['017010', '017010', '040010']);
    // 区域に分かれた市町村の区域の名前（"乗鞍" は松本市乗鞍上高地、"垂水区" は神戸市垂水区。鹿児島県の垂水市にしない）
    const areas = Object.entries(JMA_CLASS20).flatMap(([name, towns]) => {
      const part = /[市町村]$/.test(name) ? undefined : name.match(/^.+?[市町村](.{2,})$/)?.[1];
      return part && !EXACT.has(part) && !/^[（(]/.test(part) ? [[part, towns[0].class10] as const] : [];
    });
    const unique = areas.filter(([p, code]) => areas.every(([q, c]) => q !== p || c === code));
    expect(unique.length).toBeGreaterThan(40);
    expect(unique.filter(([p, code]) => resolved(p) !== code).map(([p, code]) => `${p}: ${resolved(p)}（${code}）`)).toEqual([]);
    // 区域の名前の後ろに高原・海岸などが付いても、その区域の予報区かエラー（"垂水区高原" を鹿児島県の垂水市、"山間部西海岸" を長崎県の西海市にしない）
    const forms = unique.flatMap(([p, code]) => ['高原', '海岸', '温泉'].map((s) => [p + s, code] as const)).filter(([q, code]) => resolved(q) !== code && !resolved(q).startsWith('error: '));
    expect(forms.map(([q, code]) => `${q}: ${resolved(q)}（${code}）`)).toEqual([]);
    // いくつもの地名に当たる名前、ほかの地名の途中、1 文字は、どこにも当てない（"北部" を横浜市北部、"九州" を北九州、"島" を鶴ヶ島市にしない）
    for (const n of ['北部', '東部', '西部', '九州', '島', '山']) expect(resolved(n)).toBe(`error: 地名「${n}」が見つかりません`);
    expect(resolved('津市北')).toBe('240010');
  });

  it('入力の中の空白は、どの段でも無視する（"上 野" も候補のエラー）', () => {
    for (const n of ['上 野', '上　野', ' 上野 ']) expect(resolved(n)).toBe(resolved('上野'));
    expect(resolved('上野')).toStartWith('error: 地名「上野」は、市町村（群馬県上野村）');
    expect([resolved('東京都 新宿区'), resolved('北海道 上川郡 上川町'), resolved('富士 河口')]).toEqual(['130010', '012010', '190020']);
  });

  it('区域に分かれた市は、どの区域も同じ気象台の範囲（1 回の取得で足りる）', () => {
    const cities = new Map<string, Set<string>>();
    for (const [name, towns] of Object.entries(JMA_CLASS20)) {
      const city = /[市町村]$/.test(name) ? undefined : name.match(/^(.+?市)./)?.[1];
      for (const t of towns) if (city) cities.set(`${t.code.slice(0, 2)}${city}`, (cities.get(`${t.code.slice(0, 2)}${city}`) ?? new Set()).add(JMA_CLASS10[t.class10].office));
    }
    expect(cities.size).toBeGreaterThan(30);
    expect([...cities].filter(([, offices]) => offices.size > 1)).toEqual([]);
  });
});
