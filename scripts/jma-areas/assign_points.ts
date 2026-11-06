/**
 * 気象庁の予報区（class10）ごとに、気温の地点（points）と、予報の JSON を出す別の気象台（forecastOffice）を決める。
 * 出力は gen_jma_areas.ts が読む JSON。src/jma_areas.ts の作り直しの手順は gen_jma_areas.ts の先頭に書いた。
 *
 * 使い方（リポジトリの直下から）: bun scripts/jma-areas/assign_points.ts <area.json> <forecast_area.json> <予報の JSON のフォルダ> <出力の JSON>
 *
 * 地点は、気象庁の予報区とアメダスの地点の対応（forecast_area.json の class10 と amedas）で予報区に当てる。予報区ごとに、
 * 短期予報（timeSeries[2]）と週間予報（[1].timeSeries[1]）の気温の地点の名前を、予報の JSON の並びで入れる（先頭が気温を取る地点）。
 */
import { readdirSync } from 'node:fs';

const [areaFile, forecastAreaFile, dir, outFile] = process.argv.slice(2);
if (!outFile) throw new Error('使い方: bun scripts/jma-areas/assign_points.ts <area.json> <forecast_area.json> <予報の JSON のフォルダ> <出力の JSON>');
const area = JSON.parse(await Bun.file(areaFile).text());
const forecastArea: Record<string, Array<{ class10: string; amedas: string[] }>> = JSON.parse(await Bun.file(forecastAreaFile).text());
const class10Of = new Map(Object.values(forecastArea).flat().flatMap((e) => e.amedas.map((a) => [a, e.class10] as const)));
const points: Record<string, string[]> = {};
const forecastOffice: Record<string, string> = {};
const log: string[] = [];
for (const f of readdirSync(dir).sort()) {
  const office = f.replace('.json', '');
  let j: any;
  try { j = JSON.parse(await Bun.file(`${dir}/${f}`).text()); } catch { log.push(`no forecast JSON: ${office}（${area.offices[office]?.name}）`); continue; }
  for (const a of j[0].timeSeries[0].areas) if (area.class10s[a.area.code].parent !== office) forecastOffice[a.area.code] = office;
  for (const { area: p } of [...(j[0].timeSeries[2]?.areas ?? []), ...(j[1]?.timeSeries?.[1]?.areas ?? [])]) {
    const c = class10Of.get(p.code);
    if (!c) log.push(`point without class10: ${office} ${p.name}（${p.code}）`);
    else if (!(points[c] ??= []).includes(p.name)) points[c].push(p.name);
  }
}
await Bun.write(outFile, JSON.stringify({ points, forecastOffice }, null, 1));
console.log(log.join('\n'));
const names = Object.values(points).flat();
console.log('class10 with points', Object.keys(points).length, '/', Object.keys(area.class10s).length, 'points', names.length, 'forecastOffice', JSON.stringify(forecastOffice));
console.log('duplicate point names', names.filter((n, i) => names.indexOf(n) !== i));
