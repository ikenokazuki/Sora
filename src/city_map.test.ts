import { describe, expect, it } from 'bun:test';
import { MUNICIPALITY_CITY_MAP } from './city_map.js';
import { JMA_CLASS10, JMA_CLASS20, PREFECTURE_NAMES } from './jma_areas.js';
import { AreaInputError, prefectureOf, resolveCityId, resolveMunicipality, resolvePlace } from './services/jma_area.js';

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
/** 1〜4 の段（名前そのまま）で引ける名前: city_map の地名、市町村の名前と市区町村を省いた形、区域に分かれた市の名前、予報区の名前と「地方」を除いた形、気温の地点 */
const EXACT = new Set([
  ...Object.keys(MUNICIPALITY_CITY_MAP),
  ...Object.keys(JMA_CLASS20).flatMap((n) => [n, n.replace(/[市区町村]$/, ''), ...(/[市町村]$/.test(n) ? [] : [n.match(/^(.+?市)./)?.[1] ?? n])]),
  ...Object.values(JMA_CLASS10).flatMap((a) => [a.name, a.name.replace(/地方$/, '')]),
  ...POINTS,
]);
/** city_map の地名の書き出し（"日高川" は日高川町川辺の書き出し） */
const KEY_PREFIXES = new Set(Object.keys(MUNICIPALITY_CITY_MAP).flatMap((k) => [...k].map((_, i) => k.slice(0, i + 1))));
/** 一部の一致を確かめる元の名前: 市町村の名前と市区町村を省いた形（2 文字以上）、予報区の名前 */
const BASE_NAMES = [...new Set([...Object.keys(JMA_CLASS20).flatMap((n) => [n, n.replace(/[市区町村]$/, '')]), ...Object.values(JMA_CLASS10).map((a) => a.name)])].filter((n) => n.length >= 2);
/** 天気の解決の結果（入力の誤りはその文）。表から作る入力は数が多いので、同じ入力は覚えておく */
const RESOLVED = new Map<string, string>();
const resolved = (name: string): string => {
  const hit = RESOLVED.get(name);
  if (hit !== undefined) return hit;
  let result: string;
  try {
    result = resolveCityId(name);
  } catch (err) {
    if (!(err instanceof AreaInputError)) throw err;
    result = `error: ${err.message}`;
  }
  RESOLVED.set(name, result);
  return result;
};
/** 警報の解決の結果（予報区の番号。入力の誤りはその文） */
const place = (name: string): string => {
  try {
    return resolvePlace(name, { town: true }).class10;
  } catch (err) {
    if (!(err instanceof AreaInputError)) throw err;
    return `error: ${err.message}`;
  }
};
/** 見つからないエラー（入力の空白は除いて挙げる） */
const notFound = (n: string) => resolved(n).startsWith(`error: 地名「${n.replace(/\s/g, '')}」が見つかりません`);
/** q が n と同じ予報区か、どちらもエラー */
const sameAs = (n: string, q: string) => resolved(q) === resolved(n) || (resolved(q).startsWith('error: ') && resolved(n).startsWith('error: '));
/** 表から作る入力が多いテストの時間の上限（読み込みの重い機械でも落ちないように） */
const LONG = 30_000;

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

  it('「〜島」で終わる入力は、都道府県名・市区町村の名前・「〜島」の地名で始まるときだけ一部の一致を使う（"小浜" + 島 を福井県の小浜市にしない）', () => {
    // 名前に「島」が付いて別の地名になる形、先頭に無い名前、市区町村を省いた名前の後ろに「〜島」の別の語が続く形は、見つからないエラー（天気・警報とも）。
    // 先頭の名前はよくほかの地名と同じなので当てない（"諏訪之瀬島" を長野県、"安芸江田島" を高知県、"金沢八景島" を石川県にしない）
    const blocked = [
      '伊豆諸島', '宮城島', '石川島', '能美島', '若松島', '大津島', '佐久島', '男鹿島', '大三島', '宮古伊良部島', '宮古池間島', '伊豆新島', '伊豆八丈島', '小浜黒島',
      '八重山西表島', '三河佐久島', '大崎下島', '八雲町島', 'かつらぎ町諸島', '諏訪之瀬島', '御所浦島', '安芸厳島', '安芸江田島', '安芸大崎上島', '金沢八景島', '金沢野島',
      '瀬戸田生口島', '伊勢湾篠島', '江東大島', '尾道因島', '尾道 因島', '藤沢江の島', '七尾能登島', '石垣竹富島', '上天草松島', '天草松島', '倉敷児島', '横浜八景島',
      '尾道向島', '札幌中島', '名古屋中島',
    ];
    expect(blocked.filter((n) => !notFound(n) || place(n) !== resolved(n))).toEqual([]);
    // 市区町村の名前の後ろの島、都道府県名で始まる入力、「〜島」の地名で始まる入力は当てる（島ではない「〜半島」もそのまま）
    const ok: Array<[string, string]> = [
      ['江東区大島', '130010'], ['東京都江東区大島', '130010'], ['鹿児島市桜島', '460010'], ['鹿児島県鹿児島市桜島', '460010'], ['鹿児島県桜島', '460010'],
      ['福岡市東区志賀島', '400010'], ['福岡県福岡市東区志賀島', '400010'], ['宮城県気仙沼市大島', '040010'], ['気仙沼市大島', '040010'], ['竹富町小浜島', '474010'],
      ['沖縄県竹富町小浜島', '474010'], ['廿日市市宮島', '340010'], ['尾道市因島', '340010'], ['藤沢市江の島', '140010'], ['上天草市松島', '430030'],
      ['横浜市金沢区八景島', '140010'], ['新潟市中央区万代島', '150010'], ['大阪福島', '270000'], ['沖縄宮古島', '473000'], ['沖縄 宮古島', '473000'],
      ['沖縄 石垣島', '474010'], ['東京 大島', '130020'], ['新潟県佐渡島', '150040'], ['宮古島伊良部島', '473000'], ['五島列島', '420040'],
      ['石垣島', '474010'], ['東京都八丈島', '130030'], ['知床半島', '013010'], ['伊豆半島', '220020'], ['広島市中島', '340010'],
    ];
    expect(ok.filter(([n, code]) => resolved(n) !== code).map(([n, code]) => `${n}: ${resolved(n)}（${code}）`)).toEqual([]);
    expect(resolved('今治市大三島')).toBe(resolved('今治市'));
    // 市区町村を省いた名前・予報区の名前 +「島」（その名前の地名が無いもの）は、どれも見つからない
    // （区域の名前とその省いた形、"日光市今" "神戸市東灘" などは市区町村の名前で始まるので除く。"東村山" は東村で始まるが、予報区が違うので含む）
    const startsWithTown = (n: string) => [...n].some((_, i) => i >= 2 && /[市区町村]$/.test(n.slice(0, i)) && EXACT.has(n.slice(0, i)) && resolved(n.slice(0, i)) === resolved(n));
    const island = BASE_NAMES.filter((n) => !/[市区町村島]$/.test(n) && !startsWithTown(n) && !EXACT.has(`${n}島`) && !KEY_PREFIXES.has(`${n}島`));
    expect(island.length).toBeGreaterThan(1500);
    expect(island.filter((n) => !resolved(`${n}島`).startsWith('error: ')).map((n) => `${n}島: ${resolved(`${n}島`)}`)).toEqual([]);
    // 市区町村の名前 + 大島・桜島（区域の名前）は、市区町村の名前だけのときと同じ（1 つに決まらない名前はどちらもエラー。都道府県名を付けても同じ）
    const district = Object.entries(JMA_CLASS20)
      .filter(([n]) => /[市区町村]$/.test(n))
      .flatMap(([n, towns]) => [n, ...towns.map((t) => prefectureOf(t.code) + n)])
      .flatMap((n) => ['大島', '桜島'].map((s) => [n, n + s] as const));
    expect(district.length).toBeGreaterThan(6000);
    expect(district.filter(([n, q]) => !sameAs(n, q)).map(([n, q]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
  }, LONG);

  it('city_map に足した島などの名前は、その市町村（気象庁の市町村の表）の予報区。天気・警報とも', () => {
    // [名前, 都道府県, その市町村]
    const islands: Array<[string, string, string[]]> = [
      ['伊豆大島', '東京都', ['大島町']], ['三宅島', '東京都', ['三宅村']], ['母島', '東京都', ['小笠原村']], ['佐渡島', '新潟県', ['佐渡市']],
      ['淡路島', '兵庫県', ['淡路市', '洲本市', '南あわじ市']], ['利尻島', '北海道', ['利尻町', '利尻富士町']], ['礼文島', '北海道', ['礼文町']], ['奥尻島', '北海道', ['奥尻町']],
      ['喜界島', '鹿児島県', ['喜界町']], ['与論島', '鹿児島県', ['与論町']], ['沖永良部島', '鹿児島県', ['和泊町', '知名町']],
      ['奄美群島', '鹿児島県', ['奄美市', '大和村', '宇検村', '瀬戸内町', '龍郷町', '喜界町', '徳之島町', '天城町', '伊仙町', '和泊町', '知名町', '与論町']],
      ['桜島', '鹿児島県', ['鹿児島市']], ['多良間島', '沖縄県', ['多良間村']], ['伊江島', '沖縄県', ['伊江村']], ['伊是名島', '沖縄県', ['伊是名村']],
      ['伊平屋島', '沖縄県', ['伊平屋村']], ['粟国島', '沖縄県', ['粟国村']], ['渡名喜島', '沖縄県', ['渡名喜村']], ['渡嘉敷島', '沖縄県', ['渡嘉敷村']],
      ['小浜島', '沖縄県', ['竹富町']], ['福江島', '長崎県', ['五島市']], ['平戸島', '長崎県', ['平戸市']], ['壱岐島', '長崎県', ['壱岐市']],
      ['志賀島', '福岡県', ['福岡市']], ['筑前大島', '福岡県', ['宗像市']], ['気仙沼大島', '宮城県', ['気仙沼市']], ['紀伊大島', '和歌山県', ['串本町']],
      ['江の島', '神奈川県', ['藤沢市']], ['江ノ島', '神奈川県', ['藤沢市']], ['能登島', '石川県', ['七尾市']],
      ['奄美諸島', '鹿児島県', ['奄美市', '大和村', '宇検村', '瀬戸内町', '龍郷町', '喜界町', '徳之島町', '天城町', '伊仙町', '和泊町', '知名町', '与論町']],
      ['天草諸島', '熊本県', ['天草市', '上天草市', '苓北町']], ['天草上島', '熊本県', ['天草市', '上天草市', '苓北町']], ['天草下島', '熊本県', ['天草市', '上天草市', '苓北町']],
      ['小値賀島', '長崎県', ['小値賀町']], ['上五島', '長崎県', ['新上五島町']], ['笠岡諸島', '岡山県', ['笠岡市']],
      ['隠岐諸島', '島根県', ['隠岐の島町', '西ノ島町', '海士町', '知夫村']], ['宮古諸島', '沖縄県', ['宮古島市', '多良間村']], ['宮古列島', '沖縄県', ['宮古島市', '多良間村']],
      ['伊予三島', '愛媛県', ['四国中央市']], ['安芸の宮島', '広島県', ['廿日市市']], ['安芸宮島', '広島県', ['廿日市市']], ['厳島', '広島県', ['廿日市市']],
      ['八景島', '神奈川県', ['横浜市南部']],
    ];
    const bad = islands.flatMap(([island, pref, towns]) => {
      const areas = new Set(towns.flatMap((t) => (JMA_CLASS20[t] ?? []).filter((x) => prefectureOf(x.code) === pref).map((x) => x.class10)));
      const want = areas.size === 1 ? [...areas][0] : `市町村の予報区が ${areas.size} つ`;
      return resolved(island) === want && place(island) === want ? [] : [`${island}: ${resolved(island)} / ${place(island)}（${want}）`];
    });
    expect(bad).toEqual([]);
  });

  it('高原（宮崎県高原町の名前）は一部の一致に使わない。知らない名前 + 高原は見つからない', () => {
    expect(['美ヶ原高原', '菅平高原', '霧ヶ峰高原', '蒜山高原', '安比高原', '野辺山高原', '八ヶ岳高原'].filter((n) => !notFound(n))).toEqual([]);
    expect([resolved('高原'), resolved('高原町')]).toEqual(['450030', '450030']);
    // 前の地名で引けるものはそのまま（乗鞍高原は松本市乗鞍上高地の区域）
    const keep: Array<[string, string]> = [['那須高原', '090020'], ['妙高高原', '150030'], ['伊豆高原', '220020'], ['えびの高原', resolved('えびの市')], ['乗鞍高原', JMA_CLASS20['松本市乗鞍上高地'][0].class10]];
    expect(keep.filter(([n, code]) => resolved(n) !== code)).toEqual([]);
  });

  it('一部の一致は、入力の中でいちばん前から始まる地名で引く（ほかの地名の途中や重なりを拾って別の県にしない）', () => {
    const cases: Array<[string, string]> = [
      ['日光市中宮祠', '090020'], ['苫小牧市錦町', '015010'], ['北上市本通り', '030010'], ['美濃加茂市太田町', '210010'], ['札幌市中央区北一条西', '016010'],
      ['千葉県銚子市犬吠埼', '120020'], ['函館山', '017010'], ['北上川', '030010'], ['東京都新宿区西新宿', '130010'], ['箱根温泉', '140020'], ['下北半島', '020020'],
      ['青森県下北半島', '020020'], ['北海道宗谷岬', '011000'],
    ];
    expect(cases.filter(([q, code]) => resolved(q) !== code).map(([q]) => `${q}: ${resolved(q)}`)).toEqual([]);
    // 地名の後ろに町名や山・川・温泉が付いた形（その名前の地名が無いもの）は、地名だけのときと同じ予報区か、どちらもエラー
    const towns = Object.keys(JMA_CLASS20).filter((n) => !sameAs(n, `${n}本町`)).map((n) => `${n}本町: ${resolved(`${n}本町`)}（${resolved(n)}）`);
    expect(towns).toEqual([]);
    // 高原（宮崎県高原町）は一部の一致に使わないので除く（"高原山" は見つからない）
    const forms = BASE_NAMES.filter((n) => n !== '高原').flatMap((n) => ['山', '川', '温泉'].map((s) => [n, n + s])).filter(([, q]) => !EXACT.has(q) && !KEY_PREFIXES.has(q));
    expect(forms.length).toBeGreaterThan(9000);
    expect(forms.filter(([n, q]) => !sameAs(n, q)).map(([n, q]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
  }, LONG);

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
    expect(['北部', '東部', '西部', '九州', '島', '山'].filter((n) => !notFound(n))).toEqual([]);
    expect(resolved('津市北')).toBe('240010');
    // 区域ではない市町村の名前の途中（東村山市・武蔵村山市の "山市"）は当てない（"釜山市" "徳山市" を東京にしない。天気・警報とも）
    expect(['釜山市', '徳山市', '青山市', '山市'].filter((n) => !notFound(n) || place(n) !== resolved(n))).toEqual([]);
    // 区域に分かれていない市町村の名前の、中の市・町・村の後ろ（その名前の地名が無いもの）は、その市町村にしない
    const split = new Set(Object.keys(JMA_CLASS20).flatMap((n) => (/[市町村]$/.test(n) ? [] : (n.match(/^(.+?[市町村])./)?.[1] ?? []))));
    const tails = Object.keys(JMA_CLASS20)
      .filter((n) => /[市町村]$/.test(n) && ![...split].some((t) => n.startsWith(t)))
      .flatMap((n) => [...n].flatMap((c, i) => (i >= 1 && /[市町村]/.test(c) && n.length - i - 1 >= 2 ? [[n, n.slice(i + 1)] as const] : [])))
      .filter(([, t]) => !EXACT.has(t) && !KEY_PREFIXES.has(t));
    expect(tails.filter(([n, t]) => resolved(t) === resolved(n)).map(([n, t]) => `${t}: ${resolved(t)}（${n}）`)).toEqual([]);
  });

  it('先頭の都道府県名（短い形も）は、いちばん長い地名のときだけ外し、その都道府県で後ろの名前を引く', () => {
    const cases: Array<[string, string]> = [
      ['長崎佐世保', '420020'], ['長崎 佐世保', '420020'], ['福島郡山', '070010'], ['福岡筑前', resolved('筑前町')], ['岐阜羽島', '210010'], ['東京八丈島', '130030'],
      ['京都嵐山', '260010'], ['大阪福島', '270000'], ['沖縄市胡屋', resolved('沖縄市')], ['鹿児島市桜島', '460010'], ['広島市南区宇品', '340010'],
    ];
    expect(cases.filter(([q, code]) => resolved(q) !== code).map(([q, code]) => `${q}: ${resolved(q)}（${code}）`)).toEqual([]);
    // 都道府県の中で 1 つに決まらない名前は、入力を挙げた候補のエラー（長野県の松川町・松川村）
    expect(resolved('長野松川')).toStartWith('error: 地名「長野松川」に当たる市町村が複数あります（長野県松川町、長野県松川村）');
    expect(resolved('岐阜白川')).toStartWith('error: 地名「岐阜白川」に当たる市町村が複数あります（');
    // 短い形 + その都道府県の市町村の名前は、正式名を付けたときと同じ。先頭からほかの地名とも読める形（"山形村山市" は長野県の山形村、
    // "長野原村" は群馬県の長野原町と読める）は除く
    const towns = Object.entries(JMA_CLASS20)
      .flatMap(([n, ts]) => ts.map((t) => [prefectureOf(t.code), n] as const))
      .filter(([p, n]) => /[都府県]$/.test(p) && ![...EXACT].some((k) => k.length > p.length - 1 && (p.slice(0, -1) + n).startsWith(k)));
    const bad = towns.filter(([p, n]) => resolved(p.slice(0, -1) + n) !== resolved(p + n)).map(([p, n]) => `${p.slice(0, -1)}${n}: ${resolved(p.slice(0, -1) + n)}（${resolved(p + n)}）`);
    expect(bad).toEqual([]);
  }, LONG);

  it('いちばん前の地名が 1 つに決まらなければ、見つからないではなく、入力を挙げた候補のエラー', () => {
    const cases: Array<[string, string]> = [
      ['伊達市中島', '北海道伊達市'], ['府中市大島', '東京都府中市'], ['清水町本町', '静岡県清水町'], ['高知土佐', '高知県土佐市'],
    ];
    expect(cases.filter(([q, town]) => !resolved(q).startsWith(`error: 地名「${q}」に当たる市町村が複数あります（`) || !resolved(q).includes(town)).map(([q]) => `${q}: ${resolved(q)}`)).toEqual([]);
    expect(place('伊達市中島')).toBe(resolved('伊達市中島'));
    // いくつもの地名の書き出しや途中に当たるだけの名前は、見つからないのまま
    expect(notFound('東部')).toBe(true);
    // 候補のエラーは候補の一覧と付け方だけ（最初の候補を「例」に挙げない。"草津温泉" に滋賀県の草津市を勧めない）。入力の $ はそのまま挙げる
    for (const q of ['草津温泉', '草津', '府中市', '伊達市中島']) expect([q, resolved(q).includes('例')]).toEqual([q, false]);
    expect(resolved('伊達市$&本町')).toStartWith('error: 地名「伊達市$&本町」に当たる市町村が複数あります（');
    // 見つからないエラーは、付けるとよいもの（市区町村の名前か都道府県名）を書く。例の地名は挙げない
    expect(resolved('ほげほげ')).toBe('error: 地名「ほげほげ」が見つかりません。市区町村の名前（〜市・〜区・〜町・〜村）か、都道府県名を付けた名前で指定してください');
  });

  it('郡の付いた住所は、都道府県名が無くても郡の後ろの市町村で引く（郡の名前をほかの県の市にしない。天気・警報とも）', () => {
    const cases: Array<[string, string]> = [
      ['久慈郡大子町池田', resolved('茨城県大子町')], ['安芸郡府中町鹿籠', resolved('広島県府中町')], ['西臼杵郡高千穂町三田井', resolved('宮崎県高千穂町')],
      ['愛知郡愛荘町愛知川', resolved('滋賀県愛荘町')], ['山県郡北広島町有田', resolved('広島県北広島町')], ['安芸郡江田島町', resolved('江田島市')],
      ['茨城県久慈郡大子町池田', resolved('茨城県大子町')], ['北海道上川郡上川町', '012010'], ['北海道上川郡上川町中央', '012010'], ['中新川郡上市町本町', resolved('上市町')],
      // 郡の名前の中に上郡町の上郡がある郡（足柄上郡・犬上郡・川上郡）。"中新川郡上市町" は郡上市でなく上市町
      ...['中井町', '大井町', '松田町', '山北町', '開成町', '中井町比奈窪'].map((t): [string, string] => [`足柄上郡${t}`, '140020']),
      ...['豊郷町', '甲良町', '多賀町', '多賀町多賀'].map((t): [string, string] => [`犬上郡${t}`, '250020']),
      ['神奈川県足柄上郡中井町', '140020'], ['滋賀県犬上郡多賀町', '250020'], ['川上郡標茶町', '014020'], ['北海道川上郡標茶町', '014020'], ['川上郡標茶町開運', '014020'],
      ['中新川郡上市町', resolved('上市町')],
      // 郡から始まる地名（郡上・郡山）の前の名前は郡の名前ではない。市区町村の名前の後ろの「郡〜」は町名（"交野市郡津" を三重県の津市にしない）
      ['美濃郡上八幡', '210010'], ['長良川鉄道郡上八幡', '210010'], ['美濃郡上市', '210010'], ['美濃郡上', '210010'], ['中通り郡山', '070010'], ['仙台郡山', '040010'],
      ['鹿児島市郡元', '460010'], ['伊予市郡中', '380010'], ['八頭町郡家', '310010'], ['福島市郡山', '070010'], ['高槻市郡家新町', '270000'], ['丸亀市郡家町', '370000'],
      ['淡路市郡家', '280010'], ['宮崎市郡司分', '450010'], ['茨木市郡山', '270000'], ['羽曳野市郡戸', '270000'], ['仙台市太白区郡山', '040010'], ['交野市郡津', '270000'],
      // 市町村の名前の中の郡
      ['上郡町上郡', '280010'], ['蒲郡市原', '230020'], ['小郡市原', '400040'],
    ];
    expect(cases.filter(([q, code]) => code.startsWith('error') || resolved(q) !== code || place(q) !== code).map(([q, code]) => `${q}: ${resolved(q)} / ${place(q)}（${code}）`)).toEqual([]);
    // 郡の後ろの町村が 1 つに決まらなければ、入力を挙げた候補のエラー。"会津郡山" は会津（同じ県）
    expect(resolved('三重郡朝日町柿')).toStartWith('error: 地名「三重郡朝日町柿」に当たる市町村が複数あります（');
    expect(resolved('三重郡朝日町柿')).toContain('三重県朝日町');
    expect(prefectureOf(resolved('会津郡山'))).toBe('福島県');
    // 町村 × 郡の名前（ほかの県の市町村と同じ名前や、上郡町の上郡を含む名前）は、都道府県名の有無とも町村だけのときと同じ（1 つに決まらない町村は同じ候補のエラー）
    const towns = new Map(Object.entries(JMA_CLASS20).filter(([n]) => /[町村]$/.test(n)).flatMap(([n, ts]) => [['', n], ...ts.map((t) => [prefectureOf(t.code), n])]).map(([p, n]) => [p + n, p]));
    const guns = ['犬上', '足柄上', '川上', '最上', '築上', '久慈', '安芸', '中新川'];
    const full = [...towns].flatMap(([n, p]) => guns.map((g) => [n, `${p}${g}郡${n.slice(p.length)}`] as const));
    expect(full.length).toBeGreaterThan(14000);
    expect(full.filter(([n, q]) => resolved(q) !== resolved(n)).map(([n, q]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
    // 郡の名前 + 町村 + 町名は、町村だけのときと同じ（1 つに決まらない町村はどちらもエラー）
    const forms = Object.keys(JMA_CLASS20).filter((n) => /[町村]$/.test(n)).flatMap((t) => ['某', ...guns].map((g) => [t, `${g}郡${t}本町`] as const));
    expect(forms.length).toBeGreaterThan(7500);
    expect(forms.filter(([t, q]) => !sameAs(t, q)).map(([t, q]) => `${q}: ${resolved(q)}（${resolved(t)}）`)).toEqual([]);
    // 市区町村の名前 + 郡元・郡中・郡家・郡山・郡津（町名）は、市区町村の名前だけのときと同じ（都道府県名を付けても同じ）
    const districts = Object.entries(JMA_CLASS20)
      .filter(([n]) => /[市区町村]$/.test(n))
      .flatMap(([n, ts]) => [n, ...ts.map((t) => prefectureOf(t.code) + n)])
      .flatMap((n) => ['郡元', '郡中', '郡家', '郡山', '郡津'].map((d) => [n, n + d] as const));
    expect(districts.length).toBeGreaterThan(15000);
    expect(districts.filter(([n, q]) => !sameAs(n, q)).map(([n, q]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
    // 市町村の名前の中の郡（蒲郡市・小郡市・上郡町・郡上市・大和郡山市）は外さない。都道府県の短い形と同じ名前の郡（福島県の石川郡）も郡
    const keep: Array<[string, string]> = [['蒲郡市本町', '蒲郡市'], ['小郡市本町', '小郡市'], ['上郡町大島', '上郡町'], ['岐阜郡上市本町', '郡上市'], ['大和郡山市本町', '大和郡山市'], ['石川郡石川町本町', '福島県石川町']];
    expect(keep.filter(([q, n]) => resolved(q) !== resolved(n) || resolved(n).startsWith('error')).map(([q, n]) => `${q}: ${resolved(q)}（${resolved(n)}）`)).toEqual([]);
  }, LONG);

  it('実在の郡 + その郡の町村は、その町村の予報区。町・村を省いた形は、その町村の予報区か入力の誤り（別の県・予報区にしない。天気・警報とも）', () => {
    // [都道府県, 郡, 町村]: 上・山で始まる町村（郡上・郡山と読める）、犬上郡・足柄上郡（上郡町の上郡を含む）の町、〜島の町村、
    // 町・村を省くとほかの市や気温の地点と同じ名前になる町村（清水・横浜・高山・神戸・新庄・白石・大津・西郷）
    const pairs: Array<[string, string, string]> = [
      ['山形県', '東村山', '山辺町'], ['長野県', '下高井', '山ノ内町'], ['北海道', '河東', '上士幌町'], ['富山県', '中新川', '上市町'], ['北海道', '空知', '上富良野町'],
      ['滋賀県', '犬上', '豊郷町'], ['滋賀県', '犬上', '甲良町'], ['滋賀県', '犬上', '多賀町'], ['神奈川県', '足柄上', '中井町'], ['神奈川県', '足柄上', '大井町'],
      ['神奈川県', '足柄上', '松田町'], ['神奈川県', '足柄上', '山北町'], ['神奈川県', '足柄上', '開成町'], ['岩手県', '下閉伊', '山田町'], ['奈良県', '山辺', '山添村'],
      ['和歌山県', '西牟婁', '上富田町'], ['佐賀県', '三養基', '上峰町'], ['栃木県', '河内', '上三川町'], ['埼玉県', '児玉', '上里町'], ['群馬県', '多野', '上野村'],
      ['奈良県', '吉野', '上北山村'], ['山口県', '熊毛', '上関町'], ['徳島県', '勝浦', '上勝町'], ['徳島県', '板野', '上板町'], ['福岡県', '築上', '上毛町'],
      ['秋田県', '北秋田', '上小阿仁村'], ['北海道', '空知', '上砂川町'], ['北海道', '檜山', '上ノ国町'], ['長野県', '木曽', '上松町'], ['奈良県', '北葛城', '上牧町'],
      ['宮城県', '亘理', '山元町'], ['熊本県', '球磨', '山江村'], ['山梨県', '南都留', '山中湖村'], ['熊本県', '上益城', '山都町'], ['北海道', '上川', '上川町'],
      ['兵庫県', '赤穂', '上郡町'], ['愛媛県', '越智', '上島町'], ['長野県', '東筑摩', '山形村'], ['宮城県', '宮城', '松島町'], ['鹿児島県', '熊毛', '屋久島町'],
      ['香川県', '小豆', '小豆島町'], ['島根県', '隠岐', '隠岐の島町'], ['香川県', '香川', '直島町'], ['岡山県', '都窪', '早島町'], ['長崎県', '南松浦', '新上五島町'],
      ['鹿児島県', '大島', '徳之島町'], ['広島県', '豊田', '大崎上島町'], ['大分県', '東国東', '姫島村'], ['鹿児島県', '出水', '長島町'], ['愛知県', '海部', '飛島村'],
      ['埼玉県', '比企', '川島町'], ['長野県', '上伊那', '飯島町'], ['島根県', '隠岐', '西ノ島町'],
      ['北海道', '上川', '清水町'], ['静岡県', '駿東', '清水町'], ['青森県', '上北', '横浜町'], ['群馬県', '吾妻', '高山村'], ['長野県', '上高井', '高山村'],
      ['岐阜県', '安八', '神戸町'], ['岡山県', '真庭', '新庄村'], ['佐賀県', '杵島', '白石町'], ['熊本県', '菊池', '大津町'], ['福島県', '西白河', '西郷村'],
    ];
    expect(pairs).toHaveLength(63);
    const bad = pairs.flatMap(([pref, gun, town]) => {
      const want = JMA_CLASS20[town]?.find((t) => prefectureOf(t.code) === pref)?.class10 ?? `${pref}${town}が表に無い`;
      // 町村の名前がほかの県にもあれば（清水町・高山村）、都道府県名の無い形は候補のエラーでもよい
      const shared = (JMA_CLASS20[town]?.length ?? 0) > 1;
      const full = [`${gun}郡${town}`, `${gun}郡${town}本町`].filter((q) => [resolved(q), place(q)].some((r) => r !== want && !(shared && r.startsWith('error: '))));
      const stem = `${gun}郡${town.replace(/[町村]$/, '')}`;
      const stemBad = [resolved(stem), place(stem)].some((r) => r !== want && !r.startsWith('error: '));
      return [...full, ...(stemBad ? [stem] : [])].map((q) => `${q}: ${resolved(q)} / ${place(q)}（${want}）`);
    });
    expect(bad).toEqual([]);
  });

  it('長い入力（2 万字）も、かかる時間は入力の長さに比例する', () => {
    const long = 'あ'.repeat(20_000);
    const inputs = [`${long}郡上川町`, `${long}郡上川町中央`, `${long}大島`, '安芸郡'.repeat(6_667), '交野市郡津市'.repeat(3_334), '上郡町'.repeat(6_667), '郡'.repeat(20_000), '市'.repeat(20_000)];
    const slow = inputs.flatMap((q) => {
      const start = performance.now();
      place(q);
      const ms = performance.now() - start;
      return ms < 200 ? [] : [`${q.slice(0, 3)}…${q.slice(-6)}: ${Math.round(ms)} ms`];
    });
    expect(slow).toEqual([]);
  }, LONG);

  it('入力の中の空白は、どの段でも無視する（"上 野" も候補のエラー）', () => {
    for (const n of ['上 野', '上　野', ' 上野 ']) expect(resolved(n)).toBe(resolved('上野'));
    expect(resolved('上野')).toStartWith('error: 地名「上野」は、市町村（群馬県上野村）');
    expect([resolved('東京都 新宿区'), resolved('北海道 上川郡 上川町'), resolved('富士 河口')]).toEqual(['130010', '012010', '190020']);
  });

  it('区域に分かれた市の全体は、ちょうどその市の区域（"日光市今市" のように市で終わる区域も含む）。区域だけでも引ける', () => {
    // `${都道府県}${市}` → 気象庁の市町村の表で、その都道府県でその市の名前で始まる名前の番号
    const cities = new Map<string, Set<string>>();
    for (const [name, list] of Object.entries(JMA_CLASS20)) {
      const city = /[市町村]$/.test(name) ? undefined : name.match(/^(.+?市)./)?.[1];
      for (const t of list) if (city) cities.set(prefectureOf(t.code) + city, new Set());
    }
    for (const [name, list] of Object.entries(JMA_CLASS20)) {
      for (const t of list) {
        const pref = prefectureOf(t.code);
        for (const [key, codes] of cities) if (key.startsWith(pref) && name.startsWith(key.slice(pref.length))) codes.add(t.code);
      }
    }
    expect(cities.size).toBeGreaterThan(30);
    const bad = [...cities].filter(([key, codes]) => [...(resolveMunicipality(key)?.codes ?? [])].sort().join() !== [...codes].sort().join()).map(([key, codes]) => `${key}: ${resolveMunicipality(key)?.codes.join(',')}（${[...codes].sort().join(',')}）`);
    expect(bad).toEqual([]);
    expect(resolvePlace('日光市', { town: true }).town?.codes).toContain('0920601');
    expect(resolvePlace('日光市今市', { town: true }).town?.codes).toEqual(['0920601']);
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
