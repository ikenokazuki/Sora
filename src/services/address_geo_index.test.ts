import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeoIndexReader, buildGeoIndex, distanceMeters, type GeoPoint } from './address_geo_index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-geo-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 再現できる擬似乱数（mulberry32）。 */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('distanceMeters', () => {
  test('既知の 2 点（東京駅と新宿駅）の距離に近い', () => {
    const meters = distanceMeters({ lat: 35.681236, lon: 139.767125 }, { lat: 35.690921, lon: 139.700258 });
    expect(meters).toBeGreaterThan(6100);
    expect(meters).toBeLessThan(6200);
  });

  test('同じ点は 0、緯度 1 度はおよそ 111km', () => {
    expect(distanceMeters({ lat: 35, lon: 139 }, { lat: 35, lon: 139 })).toBe(0);
    expect(distanceMeters({ lat: 35, lon: 139 }, { lat: 36, lon: 139 })).toBeGreaterThan(111_000);
    expect(distanceMeters({ lat: 35, lon: 139 }, { lat: 36, lon: 139 })).toBeLessThan(111_500);
  });
});

describe('GeoIndexReader', () => {
  const points = (count: number, seed: number): GeoPoint[] => {
    const next = random(seed);
    return Array.from({ length: count }, (_, index) => ({
      lgCode: '131016', machiazaId: String(index).padStart(7, '0'), lon: 139.6 + next() * 0.3, lat: 35.5 + next() * 0.3, rsdt: index % 2 === 0,
    }));
  };

  test('近い順に最大 limit 件を返し、全探索と同じ結果になる（格子の境界をまたぐ問い合わせを含む）', () => {
    const all = points(4000, 7);
    const path = join(dir, 'geo.sqlite');
    buildGeoIndex(path, all);
    const reader = new GeoIndexReader(path);
    try {
      const next = random(99);
      const queries = [
        { lat: 35.6, lon: 139.7 }, // 格子の境界の真上
        { lat: 35.600001, lon: 139.699999 },
        ...Array.from({ length: 60 }, () => ({ lat: 35.5 + next() * 0.3, lon: 139.6 + next() * 0.3 })),
      ];
      for (const query of queries) {
        const expected = all
          .map((point) => ({ point, distance: distanceMeters(query, point) }))
          .filter((item) => item.distance <= 3000)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 10);
        const actual = reader.nearest(query.lat, query.lon, 10, 3000);
        expect(actual.map((town) => town.machiazaId)).toEqual(expected.map((item) => item.point.machiazaId));
        expect(actual.map((town) => Math.round(town.distanceMeters))).toEqual(expected.map((item) => Math.round(item.distance)));
      }
    } finally {
      reader.close();
    }
  });

  test('返す項目と、上限・件数の制限、何も無い範囲での空', () => {
    const path = join(dir, 'geo.sqlite');
    buildGeoIndex(path, [
      { lgCode: '131016', machiazaId: '0005001', lon: 139.746306, lat: 35.675895, rsdt: true },
      { lgCode: '131016', machiazaId: '0005002', lon: 139.74317, lat: 35.67412, rsdt: false },
      { lgCode: '011011', machiazaId: '0013001', lon: 141.3544, lat: 43.063, rsdt: false },
    ]);
    const reader = new GeoIndexReader(path);
    try {
      const near = reader.nearest(35.6759, 139.7463, 10, 1000);
      expect(near).toHaveLength(2);
      expect(near[0]).toMatchObject({ lgCode: '131016', machiazaId: '0005001', rsdt: true, lon: 139.746306, lat: 35.675895 });
      expect(near[0]?.distanceMeters).toBeLessThan(10);
      expect(near[1]).toMatchObject({ machiazaId: '0005002', rsdt: false });
      expect(reader.nearest(35.6759, 139.7463, 1, 1000)).toHaveLength(1);
      expect(reader.nearest(35.6759, 139.7463, 10, 5)).toHaveLength(1);
      expect(reader.nearest(40, 135, 10, 3000)).toEqual([]);
      expect(reader.nearest(43.0631, 141.3545, 10, 3000)[0]?.lgCode).toBe('011011');
    } finally {
      reader.close();
    }
  });

  test('範囲外の座標や数値でない座標は索引に入れない', () => {
    const path = join(dir, 'geo.sqlite');
    const bad = [
      { lgCode: '1', machiazaId: 'a', lon: Number.NaN, lat: 35, rsdt: false },
      { lgCode: '1', machiazaId: 'b', lon: 139, lat: 95, rsdt: false },
      { lgCode: '1', machiazaId: 'c', lon: 10, lat: 35, rsdt: false },
      { lgCode: '1', machiazaId: 'd', lon: 139.7, lat: 35.6, rsdt: false },
    ];
    expect(buildGeoIndex(path, bad)).toBe(1);
    const reader = new GeoIndexReader(path);
    try {
      expect(reader.nearest(35.6, 139.7, 10, 1000).map((town) => town.machiazaId)).toEqual(['d']);
    } finally {
      reader.close();
    }
  });
});
