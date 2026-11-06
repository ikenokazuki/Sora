/**
 * 気象庁の予報区（class10）ごとに、短期予報の気温の地点（point）と、予報の JSON を出す別の気象台（forecastOffice）を決める。
 * 出力は gen_jma_areas.ts が読む JSON。src/jma_areas.ts の作り直しの手順は gen_jma_areas.ts の先頭に書いた。
 *
 * 使い方（リポジトリの直下から）: bun scripts/jma-areas/assign_points.ts <area.json> <予報の JSON のフォルダ> <出力の JSON>
 *
 * 地点は名前で予報区に当てる: 同じ都道府県の市町村（名前そのまま・市区町村を足した名前・"名前+市" で始まる区域）の予報区、
 * 無ければ src/city_map.ts の予報区。市の区域が 2 つの予報区にまたがるとき（仙台市の東部・西部など）は、同じ位置の予報区が
 * 候補にあればそれ。名前で決まらない地点だけ、予報区と地点の数が同じ気象台で、同じ位置の予報区に当てる。各予報区は最初の地点。
 * JSON の地点の並びは予報区の並びと同じとは限らない（山形・大分）ので、位置は最後の手段。
 */
import { readdirSync } from 'node:fs';
import { MUNICIPALITY_CITY_MAP as MAP } from '../../src/city_map.js';

const [areaFile, dir, outFile] = process.argv.slice(2);
if (!outFile) throw new Error('使い方: bun scripts/jma-areas/assign_points.ts <area.json> <予報の JSON のフォルダ> <出力の JSON>');
const area = JSON.parse(await Bun.file(areaFile).text());
const towns = Object.entries<any>(area.class20s).map(([code, v]) => ({ code, name: v.name, class10: area.class15s[v.parent].parent }));
const point: Record<string, string> = {};
const forecastOffice: Record<string, string> = {};
const log: string[] = [];
for (const f of readdirSync(dir).sort()) {
  const office = f.replace('.json', '');
  let j: any;
  try { j = JSON.parse(await Bun.file(`${dir}/${f}`).text()); } catch { log.push(`no forecast JSON: ${office}（${area.offices[office]?.name}）`); continue; }
  const ts = j[0].timeSeries;
  const areas: string[] = ts[0].areas.map((a: any) => a.area.code);
  const points: string[] = (ts[2]?.areas ?? []).map((a: any) => a.area.name);
  for (const c of areas) if (area.class10s[c].parent !== office) forecastOffice[c] = office;
  const pref = areas[0].slice(0, 2);
  const owner = points.map((p, k) => {
    const set = new Set<string>(towns.filter((t) => t.code.startsWith(pref) && areas.includes(t.class10)
      && (t.name === p || ['市', '区', '町', '村'].some((s) => t.name === p + s) || t.name.startsWith(`${p}市`))).map((t) => t.class10));
    if (!set.size && areas.includes(MAP[p])) set.add(MAP[p]);
    if (set.size > 1 && set.has(areas[k])) return areas[k];
    return set.size === 1 ? [...set][0] : undefined;
  });
  const unequal = areas.length !== points.length;
  if (unequal) log.push(`lengths differ: ${office} areas ${areas.length} / points ${points.length}`);
  areas.forEach((c, i) => {
    const byName = points.find((_, k) => owner[k] === c);
    if (byName) {
      point[c] = byName;
      if (!unequal && points[i] !== byName) log.push(`index alignment wrong: ${office} ${c}（${area.class10s[c].name}）: index ${points[i]} / name ${byName}`);
    } else if (!unequal && owner[i] === undefined) {
      point[c] = points[i];
      log.push(`by index (name not resolved): ${office} ${c}（${area.class10s[c].name}） <- ${points[i]}`);
    } else log.push(`no point: ${office} ${c}（${area.class10s[c].name}）`);
  });
  points.forEach((p, k) => { if (owner[k] === undefined) log.push(`point not resolved by name: ${office} ${p}`); });
}
await Bun.write(outFile, JSON.stringify({ point, forecastOffice }, null, 1));
console.log(log.join('\n'));
console.log('class10 with point', Object.keys(point).length, '/', Object.keys(area.class10s).length, 'forecastOffice', JSON.stringify(forecastOffice));
const names = Object.values(point);
console.log('duplicate point names', names.filter((n, i) => names.indexOf(n) !== i));
