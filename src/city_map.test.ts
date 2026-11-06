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
    const shared = POINT_AREAS.filter(([, p, i]) => i > 0 && !MUNICIPALITY_CITY_MAP[p]);
    const bad = POINT_AREAS.filter((pa) => !shared.includes(pa)).filter(([code, p]) => MUNICIPALITY_CITY_MAP[p] !== code || resolved(p) !== code);
    expect(bad.map(([code, p]) => `${p}: ${code}`)).toEqual([]);
    // city_map に無いのは、ほかの予報区の市町村の名前にも当たる 2 つ目以降の地点だけ。市町村と、その地点の予報区を挙げたエラー
    expect(shared.map(([, p]) => p).sort()).toEqual(['上野', '大野', '池田', '湯沢'].sort());
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
    const bad = PREFECTURE_NAMES.map((p) => [p, p.replace(/[都府県]$/, '')])
      .filter(([full, short]) => full !== short && MUNICIPALITY_CITY_MAP[full] !== MUNICIPALITY_CITY_MAP[short])
      .map(([full, short]) => `${full} ${MUNICIPALITY_CITY_MAP[full]} / ${short} ${MUNICIPALITY_CITY_MAP[short]}`);
    expect(bad).toEqual([]);
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
