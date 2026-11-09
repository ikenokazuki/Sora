import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { app } from '../index.js';
import { generateOpenApiDocument } from '../types.js';
import { fetchFlightStatus, fetchRoadTraffic, resolveAirport, resolvePrefecture, resolveRoadCode, TrafficInputError } from './traffic.js';

const realFetch = globalThis.fetch;
let requested: string[] = [];

/** 送り先を記録して、決めたページを返す。 */
function stubPage(html: string) {
  requested = [];
  globalThis.fetch = (async (input: string | URL) => {
    requested.push(String(input));
    return new Response(html);
  }) as unknown as typeof fetch;
}

beforeEach(() => clearCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  clearCache();
});

// Yahoo の運航情報の JSON。名前の向きは Yahoo の綴りのまま逆で、到着の一覧では depatureName が自分の空港、arrivalName が相手の空港
const flightPage = (section: string, items: object[]) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { updateTimeText: '11月6日 12時00分 時点', diainfoAirportParam: { [section]: { diainfo: items } } } },
  })}</script></body></html>`;
const flight = (n: string, depatureName: string, arrivalName: string, displayStatus = '定刻') =>
  ({ diaTime: '10:00', changeTime: '', letterCode: 'JL', flightNumber: n, airlineName: '日本航空', depatureName, arrivalName, displayStatus, message: '' });

describe('get_flight_status の行き先・出発地', () => {
  test('到着の一覧は arrivalName（相手の空港）を出発地として返し、keyword も出発地に当たる', async () => {
    stubPage(flightPage('internationalArrival', [flight('11', '羽田', 'ロサンゼルス'), flight('22', '羽田', 'パリ')]));
    const all = await fetchFlightStatus({ airport: '羽田', type: 'arrival', category: 'international', noCache: true });
    expect(all.flights.map((f) => f.destinationOrOrigin)).toEqual(['ロサンゼルス', 'パリ']);

    const hit = await fetchFlightStatus({ airport: '羽田', type: 'arrival', category: 'international', keyword: 'パリ', noCache: true });
    expect(hit.flights.map((f) => f.flightNumber)).toEqual(['JL22']);
    // 自分の空港の名前では絞れない（全便に当たらない）
    const own = await fetchFlightStatus({ airport: '羽田', type: 'arrival', category: 'international', keyword: '羽田', noCache: true });
    expect(own.flights).toEqual([]);
  });

  test('出発の一覧は depatureName（相手の空港）を行き先として返す', async () => {
    stubPage(flightPage('domesticDepature', [flight('33', '那覇', '羽田')]));
    const res = await fetchFlightStatus({ airport: '羽田', type: 'departure', noCache: true });
    expect(res.flights[0].destinationOrOrigin).toBe('那覇');
  });
});

describe('get_flight_status の要約', () => {
  test('便が 1 件も読めなかったら、順調とは言わない（一覧が空でも、一覧が見つからなくても）', async () => {
    for (const html of [flightPage('domesticDepature', []), '<html><body></body></html>', '<html><body><script id="__NEXT_DATA__">{broken</script></body></html>']) {
      stubPage(html);
      const res = await fetchFlightStatus({ airport: '羽田', noCache: true });
      expect(res.count).toBe(0);
      expect(res.hasDelaysOrCancellations).toBe(false);
      expect(res.summary).toContain('読み取れませんでした');
      expect(res.summary).not.toContain('順調');
      expect(res.summary).not.toContain('対象便数');
    }
  });

  test('便が 1 件も読めなかった結果はキャッシュしない（次の呼び出しで取り直す）。読めた結果は今まで通りキャッシュする', async () => {
    stubPage(flightPage('domesticDepature', []));
    await fetchFlightStatus({ airport: '羽田' });
    await fetchFlightStatus({ airport: '羽田' });
    expect(requested.length).toBe(2);

    clearCache();
    stubPage(flightPage('domesticDepature', [flight('33', '那覇', '羽田')]));
    await fetchFlightStatus({ airport: '羽田' });
    await fetchFlightStatus({ airport: '羽田' });
    expect(requested.length).toBe(1);
    // 絞り込みで 0 件になった結果は、ページは読めているのでキャッシュする
    await fetchFlightStatus({ airport: '羽田', keyword: 'パリ' });
    await fetchFlightStatus({ airport: '羽田', keyword: 'パリ' });
    expect(requested.length).toBe(2);
  });

  test('絞り込みで 0 件になったら、順調とは言わず条件に合う便が無いと返す', async () => {
    stubPage(flightPage('domesticDepature', [flight('33', '那覇', '羽田')]));
    for (const opts of [{ flightNumber: 'NH999' }, { keyword: 'パリ' }]) {
      const res = await fetchFlightStatus({ airport: '羽田', ...opts, noCache: true });
      expect(res.count).toBe(0);
      expect(res.summary).toContain('条件に合う便はありません');
      expect(res.summary).not.toContain('順調');
    }
  });

  test('便が読めて欠航・遅延が無ければ、今まで通り順調と返す。あれば件数を返す', async () => {
    stubPage(flightPage('domesticDepature', [flight('33', '那覇', '羽田')]));
    const ok = await fetchFlightStatus({ airport: '羽田', noCache: true });
    expect(ok.count).toBe(1);
    expect(ok.summary).toContain('順調');

    stubPage(flightPage('domesticDepature', [flight('33', '那覇', '羽田', '欠航'), flight('44', '福岡', '羽田', '遅れ')]));
    const bad = await fetchFlightStatus({ airport: '羽田', noCache: true });
    expect(bad.summary).toContain('欠航: 1便, 遅延: 1便');
    expect(bad.summary).not.toContain('順調');
  });
});

describe('get_flight_status の空港', () => {
  test('表に無い空港はエラーにして、対応する 5 空港を挙げる（羽田にしない・外へ出ない）', async () => {
    stubPage(flightPage('domesticDepature', []));
    for (const airport of ['新千歳', '福岡', '那覇', 'CTS', 'FUK', 'OKA', '札幌']) {
      const err = await fetchFlightStatus({ airport }).catch((e) => e);
      expect(err).toBeInstanceOf(TrafficInputError);
      expect(err.message).toContain(airport);
      for (const name of ['羽田', '成田', '伊丹', '関西', '中部']) expect(err.message).toContain(name);
    }
    expect(requested).toEqual([]);
    expect(() => resolveAirport('福岡')).toThrow(TrafficInputError);
  });

  test('省いた・空の入力は既定の羽田、表にある名前はそのまま解決する', async () => {
    for (const airport of [undefined, '', '   ']) {
      stubPage(flightPage('domesticDepature', []));
      const res = await fetchFlightStatus({ airport, noCache: true });
      expect(res.airportCode).toBe('HND');
      expect(requested[0]).toContain('/diainfo/flight/2/');
    }
    expect(resolveAirport('KIX').code).toBe('KIX');
    expect(resolveAirport('セントレア').code).toBe('NGO');
    expect(resolveAirport('成田空港').code).toBe('NRT');
  });

  test('表の別名・コード・空港名、それを含む入力は解決する', () => {
    const table: Record<string, string[]> = {
      HND: [
        '羽田', '羽田空港', '東京国際空港', 'hnd', 'tokyo', '東京', '東京国際空港(羽田空港)', '羽田空港国際線ターミナル', 'HND airport', ' Tokyo ',
        'haneda', 'Haneda Airport', 'Tokyo Haneda', 'Tokyo International Airport', 'Ｈｎｄ', 'ＨＮＤ', 'ＴＯＫＹＯ',
      ],
      NRT: [
        '成田', '成田空港', '成田国際空港', 'nrt', '成田空港 第2ターミナル', 'NRT/成田',
        'narita', 'Narita Airport', 'Narita International Airport', 'tokyo narita', 'Tokyo-Narita', 'ＮＲＴ',
      ],
      ITM: [
        '伊丹', '伊丹空港', '大阪国際空港', 'itm', '大阪国際空港(伊丹空港)',
        'itami', 'Osaka Itami', 'Osaka International Airport', 'Itami Airport',
      ],
      KIX: [
        '関西', '関西空港', '関西国際空港', '関空', 'kix', 'Kix',
        'kansai', 'Kansai Airport', 'Kansai International Airport', 'ｋｉｘ',
      ],
      NGO: [
        '中部', '中部空港', 'セントレア', '中部国際空港', 'ngo', '中部国際空港(セントレア)',
        'centrair', 'chubu', 'Chubu Centrair International Airport', 'ｾﾝﾄﾚｱ',
      ],
    };
    for (const [code, inputs] of Object.entries(table)) {
      for (const input of inputs) expect(resolveAirport(input).code, input).toBe(code);
    }
  });

  test('短い入力・部分の文字・英単語の中の綴り・東京を含む別の語はエラー（別の空港にしない）', () => {
    const inputs = [
      'o', 'h', 'hn', 'ng', 'ab', '羽', '成', '田', '部', '空', '空港', '国際空港', '国際', '大阪', '千歳',
      'mango', 'bingo', 'prefix', 'hndx', 'itamix', 'kansaix', 'narita2x', 'airport', 'international airport', 'osaka', 'tokyo station', '東京駅',
    ];
    for (const input of inputs) {
      expect(() => resolveAirport(input), input).toThrow(TrafficInputError);
    }
  });

  test('複数の空港を指定した入力は、1 つだけ指定するよう伝えるエラーにする', () => {
    for (const input of ['羽田と成田', 'HND to NRT', '羽田から関空', 'Tokyo Haneda Narita', 'Narita to Kansai']) {
      let err: unknown;
      try { resolveAirport(input); } catch (e) { err = e; }
      expect(err, input).toBeInstanceOf(TrafficInputError);
      const message = (err as Error).message;
      expect(message, input).toContain('1 つだけ');
      expect(message, input).not.toContain('対応していません');
      for (const name of ['羽田', '成田', '伊丹', '関西', '中部']) expect(message, input).toContain(name);
    }
  });
});

// Yahoo の都道府県ページ（道路名・方向・状況。2 行目からは方向と状況だけ）
const prefPage = `<html><head><title>愛知県</title></head><body><p>10月10日 18時00分 現在</p>
  <table><tr><td>東名高速</td><td>上り</td><td>通行止め</td></tr></table>
  <table>
    <tr><td>東名高速</td><td>上り</td><td>通行止め</td></tr><tr><td>下り</td><td>規制情報はありません</td></tr>
    <tr><td>中央道</td><td>上り</td><td>渋滞 3km</td></tr><tr><td>下り</td><td>規制情報はありません</td></tr>
  </table></body></html>`;

describe('search_road_traffic', () => {
  test('pref と road の両方を指定したら、その都道府県のページを道路名で絞る', async () => {
    stubPage(prefPage);
    const res = await fetchRoadTraffic({ pref: '愛知県', road: '東名', noCache: true });
    expect(requested).toEqual(['https://roadway.yahoo.co.jp/traffic/pref/23/list']);
    expect(res.pref).toBe('愛知県');
    expect(res.road).toBe('東名');
    expect(res.items.map((i) => i.roadName)).toEqual(['東名高速', '東名高速']);
    expect(res.hasIssues).toBe(true);
  });

  test('道路コード表の別名でも、都道府県のページの短い名前に当たる', async () => {
    stubPage(prefPage);
    const res = await fetchRoadTraffic({ pref: '愛知県', road: '中央自動車道', noCache: true });
    expect(res.items.map((i) => i.roadName)).toEqual(['中央道', '中央道']);
  });

  test('road だけなら、道路ごとのページを読む（今まで通り）', async () => {
    stubPage('<html><head><title>東名高速の交通情報</title></head><body><table><tr><td>東京IC → 横浜町田IC</td><td>渋滞 5km</td></tr></table></body></html>');
    const res = await fetchRoadTraffic({ road: '東名高速', noCache: true });
    expect(requested).toEqual(['https://roadway.yahoo.co.jp/traffic/road/1031008/list']);
    expect(res.items.length).toBe(1);
  });

  test('道路名で絞って 0 件なら、順調とは言わず見つからなかったと返す', async () => {
    for (const opts of [{ pref: '大阪府', road: '阪神高速' }, { road: '首都高' }]) {
      stubPage(prefPage);
      const res = await fetchRoadTraffic({ ...opts, noCache: true });
      expect(res.items).toEqual([]);
      expect(res.hasIssues).toBe(false);
      expect(res.summary).toContain('この道路の情報は見つかりませんでした');
      expect(res.summary).not.toContain('順調');
      expect(res.road).toBe(opts.road);
    }
  });

  test('都道府県のページから 1 件も読めなかったときも、順調とは言わない', async () => {
    stubPage('<html><head><title>交通情報</title></head><body></body></html>');
    const res = await fetchRoadTraffic({ pref: 13, noCache: true });
    expect(res.items).toEqual([]);
    expect(res.summary).toContain('見つかりませんでした');
    expect(res.summary).not.toContain('順調');

    stubPage('<html><head><title>東名高速の交通情報</title></head><body></body></html>');
    const byRoad = await fetchRoadTraffic({ road: '東名高速', noCache: true });
    expect(byRoad.summary).toContain('見つかりませんでした');
    expect(byRoad.summary).not.toContain('順調');
  });

  test('読めた結果で規制が無ければ、今まで通り順調と返す', async () => {
    stubPage('<html><body><table></table><table><tr><td>東名高速</td><td>上り</td><td>規制情報はありません</td></tr></table></body></html>');
    const res = await fetchRoadTraffic({ pref: '愛知県', road: '東名', noCache: true });
    expect(res.hasIssues).toBe(false);
    expect(res.summary).toContain('順調');
  });

  test('空でない pref が解決できなければ、東京都にせずエラーにする。省いたら東京都のまま', async () => {
    stubPage(prefPage);
    for (const pref of ['ほげ', 'mars', 99, 0]) {
      await expect(fetchRoadTraffic({ pref, noCache: true })).rejects.toThrow(TrafficInputError);
    }
    expect(requested).toEqual([]);
    for (const pref of [undefined, '', '  ']) {
      const res = await fetchRoadTraffic({ pref, noCache: true });
      expect(res.pref).toBe('東京都');
    }
    expect(requested.every((u) => u.endsWith('/traffic/pref/13/list'))).toBe(true);
  });
});

describe('表の引き方', () => {
  test('Object の既定のプロパティの名前（constructor・__proto__ など）は、都道府県・道路・空港として当たらない', async () => {
    stubPage(prefPage);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolvePrefecture(name)).toBeNull();
      expect(resolveRoadCode(name)).toBeNull();
      expect(() => resolveAirport(name)).toThrow(TrafficInputError);
      await expect(fetchRoadTraffic({ pref: name, noCache: true })).rejects.toThrow(TrafficInputError);
    }
    expect(requested).toEqual([]);
  });

  test('都道府県コードは数字だけを受ける（"13abc" を 13 にしない）', () => {
    expect(resolvePrefecture('13abc')).toBeNull();
    expect(resolvePrefecture('1.5')).toBeNull();
    expect(resolvePrefecture('13')?.code).toBe(13);
    expect(resolvePrefecture(' 13 ')?.code).toBe(13);
    expect(resolvePrefecture(13)?.code).toBe(13);
  });
});

describe('get_flight_status の OpenAPI', () => {
  test('空港の引数はどの書き方（本文・クエリ・パス）でも、対応が 5 空港だけと書く', () => {
    const paths = (generateOpenApiDocument() as any).paths;
    const notes = ['羽田・成田・伊丹・関西・中部の 5 空港だけ', '「東京」「tokyo」は羽田', '成田は名前で指定'];
    const descriptions = [
      paths['/traffic/flight'].post.requestBody.content['application/json'].schema.properties.airport.description,
      ...[paths['/traffic/flight'].get, paths['/traffic/flight/{airport}'].get].map(
        (op) => op.parameters.find((p: { name: string }) => p.name === 'airport').description,
      ),
    ];
    for (const description of descriptions) for (const note of notes) expect(description).toContain(note);
  });

  test('要約と応答の説明は「主要空港」とせず、5 空港と書く', () => {
    const paths = (generateOpenApiDocument() as any).paths;
    for (const op of [paths['/traffic/flight'].post, paths['/traffic/flight'].get, paths['/traffic/flight/{airport}'].get]) {
      expect(op.summary).toContain('5 空港');
      expect(op.summary).not.toContain('主要空港');
      expect(op.responses['200'].description).toContain('5 空港');
      expect(op.responses['200'].description).not.toContain('主要空港');
    }
  });
});

describe('REST は入力の誤りを 400 で返す', () => {
  test('不明な pref・空港', async () => {
    stubPage(prefPage);
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const res of [
      await post('/traffic/road', { pref: 'ほげ' }),
      await app.request('/traffic/road?pref=%E3%81%BB%E3%81%92'),
      await app.request('/traffic/road/%E3%81%BB%E3%81%92'),
      await post('/traffic/flight', { airport: '福岡' }),
      await app.request('/traffic/flight?airport=%E7%A6%8F%E5%B2%A1'),
      await app.request('/traffic/flight/%E6%96%B0%E5%8D%83%E6%AD%B3'),
      await post('/traffic/road', { pref: 'constructor' }),
      await post('/traffic/road', { pref: '13abc' }),
      await app.request('/traffic/road/__proto__'),
      await post('/traffic/flight', { airport: 'constructor' }),
      await app.request('/traffic/flight/__proto__'),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT');
    }
    expect(requested).toEqual([]);
  });
});
