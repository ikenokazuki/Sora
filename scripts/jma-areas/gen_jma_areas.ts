/**
 * src/jma_areas.ts（気象庁の予報区・気象台・市町村の表）を作る。
 *
 * 作り直しの手順（リポジトリの直下から。気象庁への要求は約 60 回なので、1 秒ずつあける）:
 *   mkdir -p /tmp/jma/forecasts
 *   curl -sS -A 'Sora/2.0' -o /tmp/jma/area.json https://www.jma.go.jp/bosai/common/const/area.json
 *   for o in $(bun -e 'console.log(Object.keys((await Bun.file("/tmp/jma/area.json").json()).offices).join(" "))'); do
 *     curl -sS -A 'Sora/2.0' -o /tmp/jma/forecasts/$o.json https://www.jma.go.jp/bosai/forecast/data/forecast/$o.json; sleep 1
 *   done
 *   bun scripts/jma-areas/assign_points.ts /tmp/jma/area.json /tmp/jma/forecasts /tmp/jma/point_assign.json
 *   bun scripts/jma-areas/gen_jma_areas.ts /tmp/jma/area.json <取得日 YYYY-MM-DD> /tmp/jma/point_assign.json > src/jma_areas.ts
 *
 * 予報の JSON が無い気象台（十勝 014030・奄美 460040 は 404）は飛ばし、その予報区は予報を出す気象台を forecastOffice に入れる。
 * 気温の地点の決め方は assign_points.ts の先頭に書いた。作り直したら bun test src/city_map.test.ts で city_map.ts との食い違いを確かめる。
 */
const [file, fetchedOn, pointFile] = process.argv.slice(2);
if (!pointFile) throw new Error('使い方: bun scripts/jma-areas/gen_jma_areas.ts <area.json> <取得日 YYYY-MM-DD> <point_assign.json> > src/jma_areas.ts');
const a = JSON.parse(await Bun.file(file).text());
const { point, forecastOffice } = JSON.parse(await Bun.file(pointFile).text()) as { point: Record<string, string>; forecastOffice: Record<string, string> };
const q = (s: string) => JSON.stringify(s);
const byCode = (o: Record<string, any>) => Object.keys(o).sort();

const class10 = byCode(a.class10s).map((c) => `  ${q(c)}: { "name": ${q(a.class10s[c].name)}, "office": ${q(a.class10s[c].parent)}${forecastOffice[c] ? `, "forecastOffice": ${q(forecastOffice[c])}` : ''}, "point": ${q(point[c])} },`);
if (byCode(a.class10s).some((c) => !point[c])) throw new Error('class10 without point');
const offices = byCode(a.offices).map((c) => `  ${q(c)}: ${q(a.offices[c].name)},`);
const towns = new Map<string, string[]>();
for (const c of byCode(a.class20s)) {
  const v = a.class20s[c];
  const c10 = a.class15s[v.parent].parent;
  if (!a.class10s[c10]) throw new Error(`class10 not found for ${c}`);
  towns.set(v.name, [...(towns.get(v.name) ?? []), `{ "code": ${q(c)}, "class10": ${q(c10)} }`]);
}
const class20 = [...towns].map(([name, list]) => `  ${q(name)}: [${list.join(', ')}],`);
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
// 都道府県名の確かめ: 気象台が 1 つの県は、その気象台（XX0000）の名前と同じ
for (const [i, p] of PREFS.entries()) {
  const office = a.offices[`${String(i + 1).padStart(2, '0')}0000`];
  if (office && office.name !== p) throw new Error(`prefecture mismatch ${i + 1}: ${p} / ${office.name}`);
}
const strip = (s: string) => s.replace(/,$/, '');
const last = (lines: string[]) => [...lines.slice(0, -1), strip(lines[lines.length - 1])];
console.log(`// 気象庁（JMA）公式エリア定義 (https://www.jma.go.jp/bosai/common/const/area.json、${fetchedOn} 取得) から生成した表。作り直しは scripts/jma-areas/gen_jma_areas.ts
// 予報区（class10）${class10.length} 件・気象台（offices）${offices.length} 件・市町村（class20）${Object.keys(a.class20s).length} 件（名前は ${towns.size} 種類）
// 予報区の point（気温の地点）と forecastOffice は、各気象台の予報 (https://www.jma.go.jp/bosai/forecast/data/forecast/{気象台}.json、${fetchedOn} 取得) の
// timeSeries[0]（予報区）と timeSeries[2]（地点）から。地点は名前で予報区に当てた（同じ都道府県の市町村の名前。決まらない地点だけ並びの位置）

/**
 * 予報区（class10）: 番号 → 名前、警報を発表する気象台（offices）の番号、短期予報の気温の地点の名前。
 * forecastOffice は予報の JSON が別の気象台のものに入っている予報区（十勝・奄美）だけ
 */
export const JMA_CLASS10: Record<string, { name: string; office: string; forecastOffice?: string; point: string }> = {
${last(class10).join('\n')}
};

/** 気象台（offices）: 番号 → 担当する地域の名前 */
export const JMA_OFFICES: Record<string, string> = {
${last(offices).join('\n')}
};

/** 市町村（class20）: 名前 → 候補（7 桁の番号と予報区の番号）。同じ名前の市町村が別の都道府県にあると候補が複数になる */
export const JMA_CLASS20: Record<string, Array<{ code: string; class10: string }>> = {
${last(class20).join('\n')}
};

/** 都道府県名（都道府県コード 01〜47 の順） */
export const PREFECTURE_NAMES = [
  ${PREFS.map(q).join(', ').replace(/"/g, "'")},
];`);
