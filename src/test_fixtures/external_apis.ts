// テスト用の外部 API の固定応答。USITC・iTunes・気象庁・P2P地震情報・Yahoo! 道路交通情報を、
// ネットワークなしで同じ形の応答で返す。実 API との突き合わせは live-tools.yml（tool-health）で行う。
// 形は各 API の実際の応答に合わせ、中身はテストに必要な最小限にしている。

type Row = { htsno: string; indent: string; description: string; general?: string; special?: string; other?: string };

/** USITC HTS の行（実際の関税率表の記載に沿った抜粋）。検索は HTS 番号の前方一致で返す。 */
const USITC_ROWS: Row[] = [
  { htsno: '0902.10', indent: '0', description: 'Green tea (not fermented) in immediate packings of a content not exceeding 3 kg' },
  { htsno: '0902.10.10', indent: '1', description: 'Flavored', general: '6.4%' },
  { htsno: '0902.10.1015', indent: '2', description: 'Certified organic' },
  { htsno: '0902.10.1050', indent: '2', description: 'Other' },
  { htsno: '0902.10.90', indent: '1', description: 'Other', general: 'Free' },
  { htsno: '0902.10.9015', indent: '2', description: 'Certified organic' },
  { htsno: '0902.10.9050', indent: '2', description: 'Other' },
  { htsno: '2106.90', indent: '0', description: 'Other' },
  { htsno: '2106.90.99', indent: '1', description: 'Other', general: '6.4%' },
  { htsno: '2106.90.9998', indent: '2', description: 'Other' },
  { htsno: '3304.99', indent: '0', description: 'Other' },
  { htsno: '3304.99.10', indent: '1', description: 'Petroleum jelly put up for retail sale', general: 'Free' },
  { htsno: '3304.99.1000', indent: '2', description: 'Petroleum jelly put up for retail sale' },
  { htsno: '3304.99.50', indent: '1', description: 'Other', general: 'Free' },
  { htsno: '3304.99.5000', indent: '2', description: 'Other' },
  { htsno: '3926.90', indent: '0', description: 'Other articles of plastics' },
  { htsno: '3926.90.99', indent: '1', description: 'Other', general: '5.3%' },
  { htsno: '3926.90.9985', indent: '2', description: 'Other' },
  { htsno: '6506.10', indent: '0', description: 'Safety headgear' },
  { htsno: '6506.10.30', indent: '1', description: 'Of reinforced or laminated plastics', general: 'Free' },
  { htsno: '6506.10.3030', indent: '2', description: 'Motorcycle helmets' },
  { htsno: '6506.10.3045', indent: '2', description: 'Athletic, recreational and sporting headgear' },
  { htsno: '6506.10.60', indent: '1', description: 'Other', general: 'Free' },
  { htsno: '6506.10.6060', indent: '2', description: 'Other' },
  { htsno: '6912.00', indent: '0', description: 'Ceramic tableware, kitchenware, other household articles and toilet articles, other than of porcelain or china' },
  { htsno: '6912.00.44', indent: '1', description: 'Mugs and other steins', general: '10%' },
  { htsno: '6912.00.4400', indent: '2', description: 'Mugs and other steins' },
  { htsno: '6912.00.48', indent: '1', description: 'Other', general: '9.8%' },
  { htsno: '6912.00.4810', indent: '2', description: 'Suitable for food or drink contact' },
  { htsno: '8504.40', indent: '0', description: 'Static converters' },
  { htsno: '8504.40.95', indent: '1', description: 'Other', general: 'Free' },
  { htsno: '8504.40.9580', indent: '2', description: 'Other' },
  { htsno: '8506.10', indent: '0', description: 'Manganese dioxide' },
  { htsno: '8506.10.00', indent: '1', description: 'Manganese dioxide', general: '2.7%' },
  { htsno: '8506.10.0010', indent: '2', description: 'Alkaline: Button cells' },
  { htsno: '8506.10.0090', indent: '2', description: 'Other' },
  { htsno: '9403.60', indent: '0', description: 'Other wooden furniture' },
  { htsno: '9403.60.80', indent: '1', description: 'Other', general: 'Free' },
  { htsno: '9403.60.8081', indent: '2', description: 'Other' },
  // 9503 項は6桁の細分が無く、8桁の 9503.00.00 が最上位の行になる
  { htsno: '9503.00.00', indent: '0', description: 'Tricycles, scooters, pedal cars and similar wheeled toys; dolls\' carriages; dolls; other toys; reduced-scale ("scale") models and similar recreational models, working or not; puzzles of all kinds; parts and accessories thereof', general: 'Free' },
  { htsno: '9503.00.0071', indent: '2', description: 'Other: Labeled or determined by importer as intended for use by persons under 3 years of age' },
  { htsno: '9503.00.0073', indent: '2', description: 'Other: Labeled or determined by importer as intended for use by persons 3 to 12 years of age' },
  { htsno: '9503.00.0090', indent: '2', description: 'Other' },
];

const digits = (s: string) => s.replace(/\D/g, '');

function usitcSearch(keyword: string): Row[] {
  const key = digits(keyword);
  return key ? USITC_ROWS.filter((r) => digits(r.htsno).startsWith(key)) : [];
}

/** iTunes Search API の検索結果。term ごとに、曲（song）とアーティスト（musicArtist）を返す。 */
const ITUNES_TRACKS: Array<{ trackName: string; artistName: string; collectionName: string; trackId: number }> = [
  { trackName: 'アイドル', artistName: 'YOASOBI', collectionName: 'アイドル - Single', trackId: 1680000001 },
  { trackName: '夜に駆ける', artistName: 'YOASOBI', collectionName: 'THE BOOK', trackId: 1680000002 },
  { trackName: 'Subtitle', artistName: 'Official髭男dism', collectionName: 'Subtitle - Single', trackId: 1680000003 },
  { trackName: 'Pretender', artistName: 'Official髭男dism', collectionName: 'Traveler', trackId: 1680000004 },
];

function itunesSearch(url: URL): unknown {
  const term = (url.searchParams.get('term') || '').toLowerCase();
  const entity = url.searchParams.get('entity') || 'song';
  const attribute = url.searchParams.get('attribute');
  const limit = Number(url.searchParams.get('limit') || 20);
  if (entity === 'musicArtist') {
    const names = [...new Set(ITUNES_TRACKS.map((t) => t.artistName))].filter((n) => n.toLowerCase().includes(term));
    const results = names.map((artistName, i) => ({
      wrapperType: 'artist', artistType: 'Artist', artistName, artistId: 9000 + i,
      artistLinkUrl: `https://music.apple.com/jp/artist/${9000 + i}`, primaryGenreName: 'J-Pop',
    }));
    return { resultCount: results.length, results: results.slice(0, limit) };
  }
  const matches = ITUNES_TRACKS.filter((t) => {
    if (attribute === 'songTerm') return t.trackName.toLowerCase().includes(term);
    if (attribute === 'artistTerm') return t.artistName.toLowerCase().includes(term);
    return t.trackName.toLowerCase().includes(term) || t.artistName.toLowerCase().includes(term);
  });
  const results = matches.map((t) => ({
    wrapperType: 'track', kind: 'song', trackId: t.trackId, trackName: t.trackName, artistName: t.artistName,
    collectionName: t.collectionName, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${t.trackId}/100x100bb.jpg`,
    previewUrl: `https://audio-ssl.itunes.apple.com/${t.trackId}.m4a`, releaseDate: '2023-04-12T12:00:00Z',
    primaryGenreName: 'J-Pop', trackTimeMillis: 213000, trackNumber: 1, trackViewUrl: `https://music.apple.com/jp/album/${t.trackId}`,
  }));
  return { resultCount: results.length, results: results.slice(0, limit) };
}

/** 気象庁の府県予報区（府県予報の office と、その中の一次細分区域）。 */
const JMA_OFFICES: Record<string, { office: string; areas: Array<{ code: string; name: string }> }> = {
  '130000': { office: '気象庁', areas: [{ code: '130010', name: '東京地方' }, { code: '130020', name: '伊豆諸島北部' }] },
  '190000': { office: '甲府地方気象台', areas: [{ code: '190010', name: '中・西部' }, { code: '190020', name: '東部・富士五湖' }] },
  '270000': { office: '大阪管区気象台', areas: [{ code: '270000', name: '大阪府' }] },
};

const jstDate = (offsetDays: number): string => {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return `${d.toISOString().slice(0, 10)}T00:00:00+09:00`;
};

/** 気象庁 forecast/{office}.json（短期予報3日分と週間予報7日分）。日付は実行日から作る。 */
function jmaForecast(officeCode: string): unknown {
  const info = JMA_OFFICES[officeCode] ?? { office: '気象庁', areas: [{ code: `${officeCode.slice(0, 2)}0010`, name: '地方' }] };
  const reportDatetime = jstDate(0).replace('T00:00:00', 'T05:00:00');
  const shortDays = [0, 1, 2].map(jstDate);
  const weekDays = [0, 1, 2, 3, 4, 5, 6].map(jstDate);
  return [
    {
      publishingOffice: info.office,
      reportDatetime,
      timeSeries: [
        {
          timeDefines: shortDays,
          areas: info.areas.map((area) => ({
            area,
            weatherCodes: ['100', '200', '300'],
            weathers: ['晴れ', 'くもり　時々　晴れ', '雨'],
            winds: ['北の風', '南の風', '北東の風'],
          })),
        },
        { timeDefines: shortDays, areas: info.areas.map((area) => ({ area, pops: ['0', '10', '20', '30'] })) },
        { timeDefines: shortDays, areas: [{ area: { code: `${officeCode.slice(0, 2)}000`, name: '代表地点' }, temps: ['18', '27', '19', '26', '20', '25'] }] },
      ],
    },
    {
      publishingOffice: info.office,
      reportDatetime,
      timeSeries: [
        {
          timeDefines: weekDays,
          areas: [{
            area: { code: officeCode, name: info.areas[0].name },
            weatherCodes: ['100', '200', '300', '101', '201', '100', '200'],
            pops: ['', '20', '50', '30', '40', '10', '20'],
            reliabilities: ['', '', 'A', 'B', 'B', 'C', 'C'],
          }],
        },
        {
          timeDefines: weekDays,
          areas: [{ area: { code: `${officeCode.slice(0, 2)}000`, name: '代表地点' }, tempsMin: ['', '18', '19', '17', '16', '18', '19'], tempsMax: ['', '27', '26', '25', '28', '27', '26'] }],
        },
      ],
    },
  ];
}

function jmaOverview(officeCode: string): unknown {
  const info = JMA_OFFICES[officeCode];
  return {
    publishingOffice: info?.office ?? '気象庁',
    reportDatetime: jstDate(0).replace('T00:00:00', 'T04:39:00'),
    targetArea: info?.areas[0].name ?? '地方',
    headlineText: '',
    text: '高気圧に覆われておおむね晴れています。',
  };
}

/** 気象庁 warning/{office}.json（一次細分区域に注意報を1つ）。 */
function jmaWarning(officeCode: string): unknown {
  const info = JMA_OFFICES[officeCode] ?? { office: '気象庁', areas: [{ code: `${officeCode.slice(0, 2)}0010`, name: '地方' }] };
  return {
    reportDatetime: jstDate(0).replace('T00:00:00', 'T05:00:00'),
    publishingOffice: info.office,
    areaTypes: [{ areas: info.areas.map((a) => ({ code: a.code, name: a.name, warnings: [{ code: '14', status: '発表' }] })) }],
  };
}

/** P2P地震情報 history（code 551 の地震情報）。 */
function p2pHistory(): unknown {
  return [
    {
      id: 'fixture-quake-1', code: 551, time: '2026/09/30 18:30:00.000',
      earthquake: {
        time: '2026/09/30 18:25:00', maxScale: 30, domesticTsunami: 'None',
        hypocenter: { name: '千葉県北西部', magnitude: 4.5, depth: 70, latitude: 35.6, longitude: 140.1 },
      },
      points: [{ pref: '東京都', addr: '東京千代田区大手町', scale: 30 }],
    },
    {
      id: 'fixture-quake-2', code: 551, time: '2026/09/29 09:10:00.000',
      earthquake: {
        time: '2026/09/29 09:05:00', maxScale: 20, domesticTsunami: 'None',
        hypocenter: { name: '茨城県南部', magnitude: 3.8, depth: 50, latitude: 36.0, longitude: 140.0 },
      },
      points: [{ pref: '茨城県', addr: '土浦市', scale: 20 }],
    },
  ];
}

/** Yahoo! 道路交通情報の一覧ページ（道路別・都道府県別）。 */
function roadwayHtml(url: URL): string {
  const updated = '<p>10月10日 18時00分 現在</p>';
  const road = url.pathname.match(/^\/traffic\/road\/([^/]+)\/list/);
  if (road) {
    return `<html><head><title>東名高速の交通情報 - Yahoo!道路交通情報</title></head><body>${updated}
      <table><tr><th>区間</th><th>状況</th><th>原因</th></tr><tr><td>東京IC → 横浜町田IC</td><td>渋滞 5km</td><td>交通集中</td></tr></table>
      <table><tr><th>区間</th><th>状況</th></tr><tr><td>厚木IC → 横浜町田IC</td><td>規制情報はありません</td></tr></table></body></html>`;
  }
  return `<html><head><title>都道府県の交通情報 - Yahoo!道路交通情報</title></head><body>${updated}
    <table><tr><td>首都高速都心環状線</td><td>内回り</td><td>工事規制</td></tr></table>
    <table>
      <tr><td>東名高速道路</td><td>上り</td><td>渋滞 5km</td></tr>
      <tr><td>下り</td><td>規制情報はありません</td></tr>
      <tr><td>首都高速都心環状線</td><td>内回り</td><td>工事規制</td></tr>
    </table></body></html>`;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 対応するホストなら固定応答を返す。対応しなければ undefined（本物の fetch に回す）。 */
export function externalApiFixtureResponse(url: URL): Response | undefined {
  if (url.hostname === 'hts.usitc.gov' && url.pathname === '/reststop/search') return json(usitcSearch(url.searchParams.get('keyword') || ''));
  if (url.hostname === 'itunes.apple.com' && url.pathname === '/search') return json(itunesSearch(url));
  if (url.hostname === 'www.jma.go.jp') {
    const m = url.pathname.match(/^\/bosai\/(forecast\/data\/forecast|forecast\/data\/overview_forecast|warning\/data\/warning)\/(\d{6})\.json$/);
    if (m?.[1] === 'forecast/data/forecast') return json(jmaForecast(m[2]));
    if (m?.[1] === 'forecast/data/overview_forecast') return json(jmaOverview(m[2]));
    if (m?.[1] === 'warning/data/warning') return json(jmaWarning(m[2]));
  }
  if (url.hostname === 'api.p2pquake.net' && url.pathname === '/v2/history') return json(p2pHistory());
  if (url.hostname === 'roadway.yahoo.co.jp') return new Response(roadwayHtml(url), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  return undefined;
}

/** globalThis.fetch を差し替え、対応する外部 API だけ固定応答にする。戻り値で元に戻す。 */
export function installExternalApiFixtures(): () => void {
  const original = globalThis.fetch;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL | undefined;
    try { url = new URL(raw); } catch { url = undefined; }
    const fixture = url ? externalApiFixtureResponse(url) : undefined;
    return fixture ?? original(input as never, init);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}
