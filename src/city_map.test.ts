import { describe, expect, it } from 'bun:test';
import { MUNICIPALITY_CITY_MAP } from './city_map.js';
import { JMA_CLASS10, JMA_CLASS20, PREFECTURE_NAMES } from './jma_areas.js';
import { AreaInputError, resolveCityId, resolveMunicipality } from './services/life.js';

// city_map.ts（地名 → 予報区）が、気象庁の表（jma_areas.ts）と食い違わないことを確かめる
const PREFECTURES = new Set(PREFECTURE_NAMES.flatMap((p) => [p, p.replace(/[都府県]$/, '')]));
const CLASS10_OF = new Map(Object.values(JMA_CLASS20).flat().map((t) => [t.code, t.class10]));
const POINTS = new Set(Object.values(JMA_CLASS10).map((v) => v.point));

describe('city_map.ts と気象庁の表', () => {
  it('値はすべて気象庁の予報区の番号', () => {
    expect(Object.entries(MUNICIPALITY_CITY_MAP).filter(([, v]) => !JMA_CLASS10[v])).toEqual([]);
  });

  it('市町村の名前そのままの地名（候補が 1 つ）は、その市町村の予報区', () => {
    const bad = Object.entries(MUNICIPALITY_CITY_MAP).filter(([k, v]) => JMA_CLASS20[k]?.length === 1 && JMA_CLASS20[k][0].class10 !== v);
    expect(bad).toEqual([]);
  });

  it('気象庁の気温の地点の名前は、その予報区への地名で、天気でもその予報区になる', () => {
    const bad = Object.entries(JMA_CLASS10).filter(([code, v]) => MUNICIPALITY_CITY_MAP[v.point] !== code || resolveCityId(v.point) !== code);
    expect(bad.map(([code, v]) => `${v.point}: ${code}`)).toEqual([]);
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
