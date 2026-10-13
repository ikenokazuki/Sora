import { Database, type Statement } from 'bun:sqlite';

/** 町字の代表点。逆ジオコーディングで、近い町字を探すための索引の 1 行。 */
export interface GeoPoint {
  /** 6 桁の全国地方公共団体コード。 */
  lgCode: string;
  machiazaId: string;
  lon: number;
  lat: number;
  /** 住居表示の町か。 */
  rsdt: boolean;
}

export interface NearTown extends GeoPoint {
  distanceMeters: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const RAD = Math.PI / 180;

/** 2 点間の距離（メートル、球面の haversine）。 */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 日本の範囲（沖ノ鳥島・南鳥島・与那国島を含む）。 */
const inJapan = (lon: number, lat: number): boolean => Number.isFinite(lon) && Number.isFinite(lat) && lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154;

/** 1 度あたりの格子の数。0.01 度（緯度でおよそ 1.1km）四方の格子。 */
const CELLS_PER_DEGREE = 100;

/** 町字の点の索引（SQLite）を作る。範囲外・数値でない座標は入れない。入れた件数を返す。 */
export function buildGeoIndex(path: string, points: Iterable<GeoPoint>): number {
  const db = new Database(path, { create: true });
  try {
    db.run('CREATE TABLE town_pt (lg_code TEXT NOT NULL, machiaza_id TEXT NOT NULL, lon REAL NOT NULL, lat REAL NOT NULL, rsdt INTEGER NOT NULL, ix INTEGER NOT NULL, iy INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO town_pt (lg_code, machiaza_id, lon, lat, rsdt, ix, iy) VALUES (?,?,?,?,?,?,?)');
    let count = 0;
    db.transaction(() => {
      for (const point of points) {
        if (!inJapan(point.lon, point.lat)) continue;
        insert.run(point.lgCode, point.machiazaId, point.lon, point.lat, point.rsdt ? 1 : 0, Math.floor(point.lon * CELLS_PER_DEGREE), Math.floor(point.lat * CELLS_PER_DEGREE));
        count += 1;
      }
    })();
    db.run('CREATE INDEX town_pt_cell ON town_pt (iy, ix)');
    return count;
  } finally {
    db.close();
  }
}

interface Row {
  lg_code: string;
  machiaza_id: string;
  lon: number;
  lat: number;
  rsdt: number;
}

export class GeoIndexReader {
  private readonly db: Database;
  private readonly cells: Statement<Row, [number, number, number, number]>;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
    this.cells = this.db.prepare<Row, [number, number, number, number]>(
      'SELECT lg_code, machiaza_id, lon, lat, rsdt FROM town_pt WHERE iy BETWEEN ? AND ? AND ix BETWEEN ? AND ?',
    );
  }

  /**
   * 近い順に最大 limit 件（maxMeters 以内）。点を含む格子から外へ広げながら探し、
   * これから調べる外側の格子がどれも、いま見つけた limit 番目より遠いと分かった時点で止める。
   */
  nearest(lat: number, lon: number, limit: number, maxMeters: number): NearTown[] {
    const iy0 = Math.floor(lat * CELLS_PER_DEGREE);
    const ix0 = Math.floor(lon * CELLS_PER_DEGREE);
    // 格子の狭い方の辺（経度方向）の長さ。外側の格子までの距離の下限を見積もる。
    const cellMeters = (111_320 / CELLS_PER_DEGREE) * Math.max(0.2, Math.cos(lat * RAD));
    for (let ring = 0; ; ring++) {
      const found = this.cells
        .all(iy0 - ring, iy0 + ring, ix0 - ring, ix0 + ring)
        .map((row): NearTown => ({
          lgCode: row.lg_code, machiazaId: row.machiaza_id, lon: row.lon, lat: row.lat, rsdt: row.rsdt === 1,
          distanceMeters: distanceMeters({ lat, lon }, { lat: row.lat, lon: row.lon }),
        }))
        .filter((town) => town.distanceMeters <= maxMeters)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      const outerMeters = ring * cellMeters;
      if ((found.length >= limit && (found[limit - 1] as NearTown).distanceMeters <= outerMeters) || outerMeters > maxMeters) {
        return found.slice(0, limit);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
