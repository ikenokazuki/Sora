import { describe, expect, it } from 'bun:test';
import { MUNICIPALITY_CITY_MAP } from './city_map.js';
import { JMA_CLASS10, JMA_CLASS20, PREFECTURE_NAMES } from './jma_areas.js';
import { AreaInputError, resolveCityId, resolveMunicipality } from './services/jma_area.js';

// city_map.ts（地名 → 予報区）が、気象庁の表（jma_areas.ts）と食い違わないことを確かめる
const PREFECTURES = new Set(PREFECTURE_NAMES.flatMap((p) => [p, p.replace(/[都府県]$/, '')]));
const CLASS10_OF = new Map(Object.values(JMA_CLASS20).flat().map((t) => [t.code, t.class10]));
/** 気象庁の気温の地点（短期予報・週間予報）の [予報区, 地点の名前] */
const POINT_AREAS = Object.entries(JMA_CLASS10).flatMap(([code, v]) => v.points.map((p) => [code, p] as const));
const POINTS = new Set(POINT_AREAS.map(([, p]) => p));

describe('city_map.ts と気象庁の表', () => {
  it('値はすべて気象庁の予報区の番号', () => {
    expect(Object.entries(MUNICIPALITY_CITY_MAP).filter(([, v]) => !JMA_CLASS10[v])).toEqual([]);
  });

  it('市町村の名前そのままの地名（候補が 1 つ）は、その市町村の予報区', () => {
    const bad = Object.entries(MUNICIPALITY_CITY_MAP).filter(([k, v]) => JMA_CLASS20[k]?.length === 1 && JMA_CLASS20[k][0].class10 !== v);
    expect(bad).toEqual([]);
  });

  it('気象庁の気温の地点の名前は、予報区ごとの全部の地点が、その予報区への地名で、天気でもその予報区になる', () => {
    const bad = POINT_AREAS.filter(([code, p]) => MUNICIPALITY_CITY_MAP[p] !== code || resolveCityId(p) !== code);
    expect(bad.map(([code, p]) => `${p}: ${code}`)).toEqual([]);
    // 予報区の 2 つ目以降の地点（前は候補のエラー・別の県・部分一致になっていた）
    const second: Array<[string, string]> = [['大野', '180010'], ['湯沢', '150020'], ['池田', '360010'], ['上野', '240010'], ['津川', '150010'], ['田島', '070030'], ['古川', '040010']];
    expect(second.filter(([p, code]) => !JMA_CLASS10[code].points.slice(1).includes(p) || resolveCityId(p) !== code)).toEqual([]);
  });

  it('都道府県名は、市町村の表より先に city_map の予報区になる', () => {
    const bad = [...PREFECTURES].filter((p) => MUNICIPALITY_CITY_MAP[p] && resolveCityId(p) !== MUNICIPALITY_CITY_MAP[p]);
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
