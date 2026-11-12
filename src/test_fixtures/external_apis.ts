// テスト用の外部 API の固定応答。USITC・CBP 判例・iTunes・気象庁（予報・警報・地震）・P2P地震情報・Yahoo! 道路交通情報を、
// ネットワークなしで同じ形の応答で返す。実 API との突き合わせは live-tools.yml（tool-health）で行う。
// 形は各 API の実際の応答に合わせ、中身はテストに必要な最小限にしている。
import crossExcerpt from './cross_search_excerpt.json';
import quakeExcerpt from './jma_quake_excerpt.json';
import usitcExcerpt from './usitc_export_excerpt.json';
import { JMA_CLASS10, JMA_CLASS20, JMA_OFFICES as JMA_OFFICE_NAMES } from '../jma_areas.js';

/**
 * USITC HTS 全件の export（/reststop/exportList）の抜粋。実際の関税率表の行（中間行を含む）を、
 * 見出し 0902, 3304, 3305, 6109, 6506, 6911, 6912, 7323, 8504, 8506, 8507, 8544, 8712, 9403, 9405, 9503, 9504 について、2026-10-15 に取得したものから切り出した。
 */
const usitcExport = usitcExcerpt as unknown[];

/**
 * CBP 分類判例の検索（rulings.cbp.gov/api/search）の抜粋。照会語（小文字）ごとの実際の応答。
 * hts_predict の照会語は trade.ts の crossQueriesFor が決める。表に無い語は 0 件を返す。
 */
const crossSearch = crossExcerpt as Record<string, { totalHits: number; rulings: unknown[] }>;

function crossSearchResponse(term: string): unknown {
  return crossSearch[term.toLowerCase()] ?? { totalHits: 0, rulings: [] };
}

/** iTunes Search API の検索結果。term ごとに、曲（song）とアーティスト（musicArtist）を返す。 */
const ITUNES_TRACKS: Array<{ trackName: string; artistName: string; artistId: number; collectionName: string; trackId: number }> = [
  { trackName: 'アイドル', artistName: 'YOASOBI', artistId: 9000, collectionName: 'アイドル - Single', trackId: 1680000001 },
  { trackName: '夜に駆ける', artistName: 'YOASOBI', artistId: 9000, collectionName: 'THE BOOK', trackId: 1680000002 },
  { trackName: 'Subtitle', artistName: 'Official髭男dism', artistId: 9001, collectionName: 'Subtitle - Single', trackId: 1680000003 },
  { trackName: 'Pretender', artistName: 'Official髭男dism', artistId: 9001, collectionName: 'Traveler', trackId: 1680000004 },
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
    wrapperType: 'track', kind: 'song', trackId: t.trackId, trackName: t.trackName, artistName: t.artistName, artistId: t.artistId,
    collectionName: t.collectionName, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${t.trackId}/100x100bb.jpg`,
    previewUrl: `https://audio-ssl.itunes.apple.com/${t.trackId}.m4a`, releaseDate: '2023-04-12T12:00:00Z',
    primaryGenreName: 'J-Pop', trackTimeMillis: 213000, trackNumber: 1, trackViewUrl: `https://music.apple.com/jp/album/${t.trackId}`,
  }));
  return { resultCount: results.length, results: results.slice(0, limit) };
}

/**
 * 気象庁の府県予報区（府県予報の office と、その中の一次細分区域）。points は短期予報の気温の地点で、
 * 実際の JSON と同じく一次細分区域と同じ順に並ぶ（省くと地点は 1 つ）。
 */
const JMA_OFFICES: Record<string, { office: string; areas: Array<{ code: string; name: string }>; points?: Array<{ code: string; name: string }> }> = {
  '130000': { office: '気象庁', areas: [{ code: '130010', name: '東京地方' }, { code: '130020', name: '伊豆諸島北部' }] },
  '190000': { office: '甲府地方気象台', areas: [{ code: '190010', name: '中・西部' }, { code: '190020', name: '東部・富士五湖' }] },
  '270000': { office: '大阪管区気象台', areas: [{ code: '270000', name: '大阪府' }] },
  '400000': {
    office: '福岡管区気象台',
    areas: [{ code: '400010', name: '福岡地方' }, { code: '400020', name: '北九州地方' }],
    points: [{ code: '82182', name: '福岡' }, { code: '82056', name: '八幡' }],
  },
  '471000': { office: '沖縄気象台', areas: [{ code: '471010', name: '本島中南部' }, { code: '471020', name: '本島北部' }] },
  '016000': { office: '札幌管区気象台', areas: [{ code: '016010', name: '石狩地方' }, { code: '016020', name: '空知地方' }] },
  // 実際の JSON と同じく、地点の並び（山形・酒田・新庄・米沢）が予報区の並び（村山・置賜・庄内・最上）と違う
  '060000': {
    office: '山形地方気象台',
    areas: [{ code: '060010', name: '村山' }, { code: '060020', name: '置賜' }, { code: '060030', name: '庄内' }, { code: '060040', name: '最上' }],
    points: [{ code: '35426', name: '山形' }, { code: '35136', name: '酒田' }, { code: '35172', name: '新庄' }, { code: '35571', name: '米沢' }],
  },
  // 十勝地方（014030）の予報は釧路地方気象台の JSON に入る
  '014100': {
    office: '釧路地方気象台',
    areas: [{ code: '014020', name: '釧路地方' }, { code: '014010', name: '根室地方' }, { code: '014030', name: '十勝地方' }],
    points: [{ code: '19432', name: '釧路' }, { code: '18273', name: '根室' }, { code: '20432', name: '帯広' }],
  },
};

/** 気象庁に無い気象台の番号（例: 北海道の 010000）は、実際と同じく 404 を返す。 */
const isJmaOffice = (code: string) => code in JMA_OFFICE_NAMES;
/** 予報の JSON を自分では出さない気象台（十勝・奄美。予報は別の気象台の JSON に入る） */
const NO_FORECAST = new Set(Object.values(JMA_CLASS10).filter((c) => c.forecastOffice).map((c) => c.office));

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
        {
          timeDefines: shortDays,
          areas: (info.points ?? [{ code: `${officeCode.slice(0, 2)}000`, name: '代表地点' }])
            .map((area, i) => ({ area, temps: ['18', '27', '19', '26', '20', '25'].map((t) => String(Number(t) - i)) })),
        },
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

/**
 * 気象庁 warning/data/r8/{office}.json。実際と同じく報（種類ごとの dataTypeCode）の配列で、どの報にもその気象台の
 * すべての予報区（class10Items）と市町村（class20Items）の欄があり、欄には番号と警報だけがある（名前は無い）。
 * どの欄にも、大雨の報で大雨注意報（レベル２）、雷などの報で雷注意報を置く。
 */
function jmaWarning(officeCode: string): unknown {
  const areas = Object.keys(JMA_CLASS10).filter((c) => JMA_CLASS10[c].office === officeCode);
  const towns = Object.values(JMA_CLASS20).flat().filter((t) => JMA_CLASS10[t.class10]?.office === officeCode);
  const report = (dataTypeCode: string, time: string, kinds: unknown[]) => ({
    reportDatetime: jstDate(0).replace('T00:00:00', time),
    dataTypeCode,
    warning: { class10Items: areas.map((areaCode) => ({ areaCode, kinds })), class20Items: towns.map((t) => ({ areaCode: t.code, kinds })) },
  });
  return [report('VPWW55', 'T05:00:00', [{ code: '10', status: '発表' }]), report('VPWW61', 'T04:00:00', [{ code: '14', status: '継続' }])];
}

/** P2P地震情報 history（code 551 の地震情報）。気象庁の地震情報が使えないときの退避先として答える。 */
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
  if (url.hostname === 'hts.usitc.gov' && url.pathname === '/reststop/exportList') return json(usitcExport);
  if (url.hostname === 'rulings.cbp.gov' && url.pathname === '/api/search') return json(crossSearchResponse(url.searchParams.get('term') || ''));
  if (url.hostname === 'itunes.apple.com' && url.pathname === '/search') return json(itunesSearch(url));
  if (url.hostname === 'www.jma.go.jp') {
    const quake = url.pathname.match(/^\/bosai\/quake\/data\/([^/]+\.json)$/);
    if (quake) {
      // 一覧と各報の JSON は、2026-11-11 に取った実データの抜粋（地震 4 件と遠地地震 1 件）
      if (quake[1] === 'list.json') return json(quakeExcerpt.list);
      const detail = (quakeExcerpt.details as Record<string, unknown>)[quake[1]];
      return detail ? json(detail) : new Response('Not Found', { status: 404 });
    }
    const m = url.pathname.match(/^\/bosai\/(forecast\/data\/forecast|forecast\/data\/overview_forecast|warning\/data\/r8)\/(\d+)\.json$/);
    if (m && (!isJmaOffice(m[2]) || (m[1] !== 'warning/data/r8' && NO_FORECAST.has(m[2])))) return new Response('Not Found', { status: 404 });
    if (m?.[1] === 'forecast/data/forecast') return json(jmaForecast(m[2]));
    if (m?.[1] === 'forecast/data/overview_forecast') return json(jmaOverview(m[2]));
    if (m?.[1] === 'warning/data/r8') return json(jmaWarning(m[2]));
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
  // 判例の写しは CBP の API の応答なので、照会先を API にする（手元の索引の経路は cross_index.test.ts で確かめる）
  const originalSource = process.env.SORA_HTS_CROSS_SOURCE;
  process.env.SORA_HTS_CROSS_SOURCE = 'api';
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
    if (originalSource === undefined) delete process.env.SORA_HTS_CROSS_SOURCE;
    else process.env.SORA_HTS_CROSS_SOURCE = originalSource;
  };
}
