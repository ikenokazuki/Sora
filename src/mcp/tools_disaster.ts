import { z } from 'zod';
import { fetchElevationAndCoordinates, fetchRecentEarthquakes, fetchRoadTraffic, fetchWeatherWarnings } from '../scraper.js';
import { EARTHQUAKE_SCALE_CODES } from '../types.js';
import { errorMessage } from '../errors.js';
import { addressEnabled } from '../services/address_config.js';
import { addressErrorMessage } from '../services/address_errors.js';
import { registerTool, toolJson } from './registry.js';
import { onlyForMode, usageError } from './args.js';

import type { ElevationResult } from '../scraper.js';
import type { ToolRegistrationContext } from './registry.js';

/** 🚨 Category 5: Disaster & Emergency (モジュール: 'disaster') */
export function registerDisasterTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 16: search_road_traffic (リアルタイム道路交通情報 - Yahoo! 道路交通情報のページ) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_road_traffic',
    'disaster',
    '【必須・道路交通情報】日本全国の高速道路・都市高速・主要有料道路のリアルタイム道路交通情報（事故・渋滞・通行止め・車線規制・チェーン規制・工事等）は、推測せず、Yahoo! 道路交通情報のページを読む本ツールで取得してください（応答の source は yahoo-roadway）。返却: { pref, road, updatedAt, hasIssues, summary, items: [{ roadName, direction, status, section, cause }] }',
    {
      pref: z.string().optional().describe('都道府県名またはコード (例: "東京都", "愛知県", "大阪府", "福岡県", "13")。解決できない値はエラー。road と併せるとその都道府県のページを road で絞る'),
      road: z.string().optional().describe('道路名 (例: "東名高速", "中央道", "名神高速", "東北道", "圏央道")。該当する道路の情報が無ければ、その旨を返す'),
    },
    async (opts) => {
      try {
        const result = await fetchRoadTraffic(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Road traffic error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['道路交通情報', '通行止め', '渋滞', '高速道路', '規制', 'JARTIC', 'Yahoo'] },
  );

  // Tool: get_disaster_info (気象警報・注意報と地震。include で選ぶ) - CORE (defaultEnabled: true)
  // include の種類ごとの節。種類を足すときは、ここに 1 項目足す（args はその種類だけの引数、defaults はその既定値、
  // check は足りない引数の検査）。節の中身は、統合前のツールの応答のまま
  const EARTHQUAKE_LIMIT_DEFAULT = 5;
  const MIN_INTENSITY_DEFAULT = 10;
  type DisasterArgs = { city?: string; areaCode?: string; limit?: number; minIntensity?: number };
  type DisasterSection = {
    label: string;
    usage: string;
    args: Array<keyof DisasterArgs>;
    defaults?: Partial<DisasterArgs>;
    check?: (args: DisasterArgs) => string | undefined;
    build: (args: DisasterArgs) => Promise<unknown>;
  };
  const DISASTER_SECTIONS: Record<string, DisasterSection> = {
    warnings: {
      label: 'Disaster warnings',
      usage: '気象警報・注意報。city か areaCode で地域を指定',
      args: ['city', 'areaCode'],
      check: ({ city, areaCode }) => (city || areaCode ? undefined : 'include の warnings には city か areaCode が必要です。'),
      build: ({ city, areaCode }) => fetchWeatherWarnings({ city, areaCode }),
    },
    earthquake: {
      label: 'Earthquake search',
      usage: '最近の地震。limit・minIntensity で絞る',
      args: ['limit', 'minIntensity'],
      defaults: { limit: EARTHQUAKE_LIMIT_DEFAULT, minIntensity: MIN_INTENSITY_DEFAULT },
      build: ({ limit, minIntensity }) => fetchRecentEarthquakes({ limit, minIntensity }),
    },
  };
  const DISASTER_KINDS = Object.keys(DISASTER_SECTIONS);
  const DISASTER_USAGE = `使い方: include で返す情報を選ぶ（${DISASTER_KINDS.map((kind) => `${kind}: ${DISASTER_SECTIONS[kind].usage}`).join('。')}）。既定は city か areaCode があれば ["warnings"]、無ければ ["earthquake"]。両方は ["warnings","earthquake"]。`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_disaster_info',
    'disaster',
    '【気象庁公式・防災速報直結】特別警報・危険警報・警報・注意報（大雨・土砂災害・暴風・大雪・波浪等。河川の氾濫は含まない）と最新の地震（震源・マグニチュード・最大震度・津波）は推測せず本ツールで取得。includeで選ぶ（既定はcity/areaCodeがあればwarnings、無ければearthquake）。返却: { include, warnings: { areaName, warnings }, earthquake: { count, earthquakes } }',
    {
      city: z.string().optional().describe('市区町村名 (例: "新宿区", "札幌", "札幌市中央区")。都道府県名 (例: "静岡県", "石川") は県全体で、気象台が複数ある北海道・鹿児島・沖縄は気象台を挙げたエラー。予報区の名前も可 (例: "富士五湖")。複数の市町村に当たる名前は都道府県名や市・町を付ける (例: "北海道森町", "川崎市")。知らない地名はエラー。warnings のときだけ'),
      areaCode: z.string().optional().describe('気象庁エリアコード。7桁は市町村 (例: "1310400")、6桁は予報区または気象台 (例: "130010", "130000")、2桁は都道府県 (例: "27")。北海道・鹿児島・沖縄は気象台が複数あり6桁で指定。区域に分かれた市は応答の7桁をカンマでつないだもの (例: "1410011,1410012") も可。warnings のときだけ'),
      limit: z.number().int().min(1).max(20).optional().describe(`地震の取得件数 (1〜20, デフォルト: ${EARTHQUAKE_LIMIT_DEFAULT})。earthquake のときだけ`).meta({ default: EARTHQUAKE_LIMIT_DEFAULT }),
      // Gemini の関数宣言は enum を文字列にしか許さず、数の enum が 1 つあるとツール一覧ごと 400 になる。
      // MCP には範囲だけを出し、震度コードかどうかは refine で確かめる（REST の OpenAPI には enum を残す）
      minIntensity: z.number().int().min(10).max(70)
        .refine((v) => (EARTHQUAKE_SCALE_CODES as readonly number[]).includes(v), { message: `震度コードは ${EARTHQUAKE_SCALE_CODES.join('・')} のどれかです` })
        .optional()
        .describe(`最小震度コード (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強, 55=震度6弱, 60=震度6強, 70=震度7, デフォルト: ${MIN_INTENSITY_DEFAULT})。earthquake のときだけ`)
        .meta({ default: MIN_INTENSITY_DEFAULT }),
      include: z.array(z.string()).optional().describe(`返す情報 (${DISASTER_KINDS.join('・')})。既定は city か areaCode があれば ["warnings"]、無ければ ["earthquake"]。両方は ["warnings","earthquake"]`),
    },
    async (args) => {
      // 空の配列は省略と同じ（args.ts の given と同じ読み方）
      const requested = args.include?.length ? args.include : (args.city || args.areaCode ? ['warnings'] : ['earthquake']);
      // 値は JSON の形で引用する（"" も見えるように）
      const unsupported = requested.filter((kind) => !DISASTER_KINDS.includes(kind));
      if (unsupported.length > 0) return usageError(`include に使えない値があります: ${unsupported.map((v) => JSON.stringify(v)).join(', ')}。${DISASTER_USAGE}`);
      const kinds = DISASTER_KINDS.filter((kind) => requested.includes(kind));
      // 頼んだ種類は足りない引数を、頼まなかった種類はその種類だけの引数を断る（既定値と同じ値は断らない）
      for (const kind of DISASTER_KINDS) {
        const section = DISASTER_SECTIONS[kind];
        if (kinds.includes(kind)) {
          const missing = section.check?.(args);
          if (missing) return usageError(`${missing}${DISASTER_USAGE}`);
        } else {
          const invalid = onlyForMode(`include: ${JSON.stringify(kinds)}`, [`include に ${kind} を含むとき`], args, section.args, DISASTER_USAGE, section.defaults);
          if (invalid) return usageError(invalid);
        }
      }
      const answer: Record<string, unknown> = { include: kinds };
      for (const kind of kinds) {
        try {
          answer[kind] = await DISASTER_SECTIONS[kind].build(args);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${DISASTER_SECTIONS[kind].label} error: ${errorMessage(err) || err}` }] };
        }
      }
      return { content: [{ type: 'text', text: toolJson(answer) }] };
    },
    { defaultEnabled: true, keywords: ['気象警報', '警報', '注意報', '特別警報', '危険警報', '防災', '気象庁', '大雨', '土砂災害', '暴風', '大雪', '波浪', '雷', '台風', '地震情報', '地震', '震度', '震源地', 'マグニチュード', '津波', 'P2P地震情報', 'search_disaster_warnings', 'search_earthquake'] },
  );

  // Tool: get_place_info (地点の情報。include で選ぶ。いまは標高だけ) - DEFERRED
  // include の種類ごとの節。種類を足すときは、ここに 1 行足す。どの節も、地点（location）と自分の節を返す
  type PlaceWhere = { address?: string; lat?: number; lon?: number; noCache?: boolean };
  type PlaceSection = { label: string; build: (where: PlaceWhere) => Promise<{ location: Record<string, unknown>; section: Record<string, unknown> }> };
  const PLACE_SECTIONS: Record<string, PlaceSection> = {
    // 旧 get_elevation の応答を、欄の名前と値のまま、地点と標高に分ける（キャッシュの印は標高の節に）
    elevation: { label: 'Elevation', build: async (where) => {
      const { elevationMeters, dataAccuracy, formatted, source, cached, cachedAt, ageSeconds, ...location } =
        await fetchElevationAndCoordinates(where) as ElevationResult & { cached?: boolean; cachedAt?: string; ageSeconds?: number };
      return { location, section: { elevationMeters, dataAccuracy, formatted, source, cached, cachedAt, ageSeconds } };
    } },
  };
  const PLACE_KINDS = Object.keys(PLACE_SECTIONS);
  const PLACE_INCLUDE_DEFAULT = ['elevation'];
  const PLACE_USAGE = `使い方: 地点は address（住所・地名）か、lat と lon（座標）のどちらか一方。include で返す情報を選ぶ（使える値: ${PLACE_KINDS.join('・')}。既定 ${JSON.stringify(PLACE_INCLUDE_DEFAULT)}）。`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_place_info',
    'disaster',
    '【地点情報・標高・座標取得必須】座標や標高を推測せず、本ツールで取得してください。地点は住所・地名（address）か座標（lat/lon）のどちらか一方。住所・地名は座標化し（番地まである住所は国土地理院の住所検索、施設名・駅名・地名はNominatim。該当が無ければもう一方で補完）、未キャッシュのNominatim問い合わせは全ツール共有で1.1秒間隔となり、待機する場合があります。includeで返す情報を選びます（elevation: 国土地理院の海抜標高（m）。既定）。location.needsVerificationがtrueならlocation.matchedTitleが意図した場所か確認してください。回答・公開時はlocation.geocodingAttributionを出典として表示すること。返却: { location: { lat, lon, matchedTitle, geocodingSource, geocodingAttribution, needsVerification }, elevation: { elevationMeters, dataAccuracy, formatted }, include }',
    {
      address: z.string().optional().describe('住所・地名文字列 (例: "東京都千代田区永田町1-7-1", "富士山頂")。lat/lonとは排他'),
      lat: z.number().min(-90).max(90).optional().describe('緯度 (lon とペア。address の代わりに直接指定, 例: 35.681236)'),
      lon: z.number().min(-180).max(180).optional().describe('経度 (lat とペア。例: 139.767125)'),
      noCache: z.boolean().optional().describe('座標解決・標高のキャッシュを使わず再取得する。1.1秒間隔は維持').meta({ default: false }),
      include: z.array(z.string()).optional().describe(`返す情報 (${PLACE_KINDS.join('・')}。既定 ${JSON.stringify(PLACE_INCLUDE_DEFAULT)})。elevation: 国土地理院の海抜標高`).meta({ default: PLACE_INCLUDE_DEFAULT }),
    },
    async ({ address, lat, lon, noCache, include }) => {
      if ((lat === undefined) !== (lon === undefined)) return usageError(`lat と lon は組で指定してください。${PLACE_USAGE}`);
      const hasAddress = Boolean(address?.trim());
      if (hasAddress && lat !== undefined) return usageError(`address と lat・lon は、どちらか一方だけを指定してください。${PLACE_USAGE}`);
      if (!hasAddress && lat === undefined) return usageError(`address または (lat, lon) のいずれかを指定してください。${PLACE_USAGE}`);
      // 空の配列は省略と同じ（args.ts の given と同じ読み方）
      const requested = include?.length ? include : PLACE_INCLUDE_DEFAULT;
      const unsupported = requested.filter((kind) => !PLACE_KINDS.includes(kind));
      if (unsupported.length > 0) return usageError(`include に使えない値があります: ${unsupported.map((v) => JSON.stringify(v)).join(', ')}。${PLACE_USAGE}`);
      // サービスには旧 get_elevation の引数だけを渡す
      const where: PlaceWhere = hasAddress ? { address } : { lat, lon };
      if (noCache !== undefined) where.noCache = noCache;
      const kinds = PLACE_KINDS.filter((kind) => requested.includes(kind));
      const answer: Record<string, unknown> = {};
      for (const kind of kinds) {
        try {
          const { location, section } = await PLACE_SECTIONS[kind].build(where);
          answer.location ??= location;
          answer[kind] = section;
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${PLACE_SECTIONS[kind].label} error: ${errorMessage(err) || err}` }] };
        }
      }
      return { content: [{ type: 'text', text: toolJson({ ...answer, include: kinds }) }] };
    },
    { defaultEnabled: deferredDefault, keywords: ['標高', '海抜', 'ジオコーディング', '国土地理院', '住所検索', '座標', '津波リスク', '水害', '地点情報', 'get_elevation'] },
  );

  // Tool: search_poi (OpenPOI 全国施設POI検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_poi',
    'disaster',
    '【OpenPOI直結・全国337万件】施設名・住所キーワードと位置範囲から施設を検索し、緯度経度付きで返します。複数語はORのため、場所はqueryに混ぜずcenterへ分離してください。centerはNominatimで座標化します（該当なしは国土地理院の住所検索で補完）。未キャッシュの解決は全ツール共有で1.1秒間隔となり、待機する場合があります。centerResolved.needsVerificationがtrueならaddressが意図した地域か確認し、異なる場合は地域名を補って再検索してください。候補一覧は返りません。座標既知ならlat/lon。get_place_info / search_routeと組み合わせ可能。回答・公開時は attribution・centerResolved.attribution・各 pois[].attributions（withAddress 指定時は addressAttribution も）を必ず出典として表示すること。返却: { centerResolved, count, pois: [{ name, address, lat, lng, licenses, attributions }], attribution }',
    {
      query: z.string().trim().min(1).max(200).optional().describe('施設・住所キーワード (例: "ラーメン", "世田谷区 カフェ")'),
      lat: z.number().min(-90).max(90).optional().describe('中心緯度 (lon とペア指定)'),
      lon: z.number().min(-180).max(180).optional().describe('中心経度 (lat とペア指定)'),
      radiusMeters: z.number().int().min(1).max(100000).optional().describe('中心からの半径m (デフォルト: 5000、bbox 指定時は無視)').meta({ default: 5000 }),
      center: z.string().trim().max(200).optional().describe('中心地名 (例: "渋谷", "原宿")。番地まである住所は国土地理院、それ以外はNominatimで座標化する。lat/lonとは排他'),
      bbox: z.string().optional().describe('矩形範囲 "minLng,minLat,maxLng,maxLat" (center/radius より優先)'),
      limit: z.number().int().min(1).max(50).optional().default(10).describe('最大件数 (1-50, デフォルト: 10)'),
      noCache: z.boolean().optional().describe('地名解決のキャッシュを使わず再取得する。1.1秒間隔は維持').meta({ default: false }),
      withAddress: z.boolean().optional().describe('各施設の住所を正規化して郵便番号を付け、施設の座標と突き合わせて addressInfo として返す。住所データが揃う前に調べた施設は addressIncomplete: true（足りないデータは addressPending / addressUnavailable）で、数秒後の再実行で完全になる。解釈できない住所は addressInfo なしで印も付かない').meta({ default: false }),
    },
    async (opts) => {
      try {
        const { searchOpenPoi } = await import('../services/poi.js');
        // 空の center（lat・lon と排他）は指定なし。サービスは center があれば座標化する
        const result = await searchOpenPoi({ ...opts, center: opts.center || undefined });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `POI search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['POI', '施設検索', '施設', '住所検索', '避難所', '病院', '地図', '座標', '周辺施設', 'poi', 'places', '営業許可'] },
  );

  if (addressEnabled()) {
    // Tool: lookup_address (住所の正規化・緯度経度から住所・郵便番号から住所候補。入力で選ぶ) - DEFERRED
    const ADDRESS_USAGE = '使い方: 住所の正規化は address（zipcode・lat と lon・compareAddress で突き合わせ、level で階層）。緯度経度から住所は address なしで lat と lon（maxDistanceMeters で範囲）。郵便番号から住所候補は zipcode だけ。';
    // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
    const WITH_ADDRESS = 'address を指定したとき';
    const WITH_POINT = 'address なしで lat・lon を指定したとき';
    const ZIPCODE_ONLY = 'zipcode だけを指定したとき';
    // 既定値（説明・既定値の比較）。補うのはサービス（normalizeAddressTool・reverseGeocode）
    const LEVEL_DEFAULT = 8;
    const MAX_DISTANCE_DEFAULT = 300;
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'lookup_address',
      'disaster',
      '【住所正規化・逆ジオコーディング・郵便番号】日本の住所を引く（一次データ: デジタル庁ABR・日本郵便。使われた市区町村のみオンデマンド取得）。入力で選ぶ。address: 番地・号（level 8）まで照合・正規化し、緯度経度・結合キー・郵便番号を付与。zipcode・lat/lon・compareAddress で突き合わせ（名寄せ）。numberSource は番地・号の照合の根拠: rsdt（住居表示）・chiban（地番）は番地・号を照合、mlit は国土交通省の街区データで街区符号まで（号は未照合で other に残る。確認済みの番地ではない）、null は整形のみ。座標の精度は point.level（8 番地・号 / 7 街区 / 3 町字）で判断（chiban で ABR に座標が無いとき pointSource: mlit）。lat と lon だけ: 緯度経度から最寄りの番地・号または町字の住所を逆引き（代表点による最寄り判定。ABR の点が範囲内に無いときは国土交通省の街区の点で numberSource: mlit、point.level 7、番地の特定ではなく街区の近似）。zipcode だけ: 郵便番号から住所候補（大口事業所の個別郵便番号にも対応）。返却: mode（normalize / reverse / postal）と、normalize は { normalized, addr, other, level, numberSource, keys, point: { lat, lon, level }, pointSource?, postalCodes, checks?: { zipcode?, coordinates?, compare? }, dataset, attribution }、reverse は { found, address, normalized, level, numberSource, distanceMeters, keys, postalCodes, alternatives, dataset, attribution }、postal は { zipcode, count, candidates: [{ kind, prefecture, city, town, detail?, office?, lgCode, lat?, lon?, locationLevel? }], dataset, attribution }',
      {
        address: z.string().trim().max(300).optional().describe('正規化する住所 (例: "東京都千代田区永田町1-7-1")。先頭の〒郵便番号は postalCode として分離。応答の postalCodes が、この住所の郵便番号'),
        zipcode: z.string().trim().optional().describe('郵便番号 (例: "100-0014", "〒100-0014")。zipcode だけなら住所候補を引く。address と一緒なら突き合わせ（市区町村の無い住所は、この番号の市区町村を補って解決する。checks.zipcode に match/partial/mismatch を返す）'),
        lat: z.number().min(-90).max(90).optional().describe('緯度 (lon とペア)。address なしなら、この座標の住所を逆引きする。address と一緒なら突き合わせ（checks.coordinates を返す）'),
        lon: z.number().min(-180).max(180).optional().describe('経度 (lat とペア)'),
        level: z.number().int().min(1).max(8).optional().describe(`正規化する最大の階層 (1〜8、既定 ${LEVEL_DEFAULT})。8は番地・号まで。address のときだけ`).meta({ default: LEVEL_DEFAULT }),
        compareAddress: z.string().trim().max(300).optional().describe('名寄せの相手の住所。checks.compare に一致階層と違いを返す。address のときだけ'),
        maxDistanceMeters: z.number().int().min(1).max(2000).optional().describe(`番地・号の点を探す範囲m (既定 ${MAX_DISTANCE_DEFAULT}、最大 2000)。address なしで lat・lon のときだけ`).meta({ default: MAX_DISTANCE_DEFAULT }),
      },
      async (args) => {
        const { address, zipcode, lat, lon, level, compareAddress, maxDistanceMeters } = args;
        // どの入力でも、lat と lon は組（address と一緒でも、サービスまで進めない）
        if ((lat === undefined) !== (lon === undefined)) return usageError(`lat と lon は組で指定してください。${ADDRESS_USAGE}`);
        // 空の address・zipcode は、指定しなかったのと同じ
        const mode = address ? WITH_ADDRESS : lat !== undefined ? WITH_POINT : zipcode ? ZIPCODE_ONLY : undefined;
        if (!mode) return usageError(`address・zipcode・lat と lon のどれかを指定してください。${ADDRESS_USAGE}`);
        const invalid = onlyForMode(mode, [WITH_ADDRESS, ZIPCODE_ONLY], args, ['zipcode'], ADDRESS_USAGE)
          ?? onlyForMode(mode, [WITH_ADDRESS], args, ['level', 'compareAddress'], ADDRESS_USAGE, { level: LEVEL_DEFAULT })
          ?? onlyForMode(mode, [WITH_POINT], args, ['maxDistanceMeters'], ADDRESS_USAGE, { maxDistanceMeters: MAX_DISTANCE_DEFAULT });
        if (invalid) return usageError(invalid);
        // 応答とエラーの文は、統合前の 3 ツールのまま（REST の 3 ルートと同じ応答）。mode を足す
        const label = mode === WITH_ADDRESS ? 'Address normalize' : mode === WITH_POINT ? 'Reverse geocode' : 'Postal code';
        try {
          const tools = await import('../services/address_tools.js');
          const answer = mode === WITH_ADDRESS
            ? { mode: 'normalize', ...await tools.normalizeAddressTool({ address: address!, level, zipcode, lat, lon, compareAddress }) }
            : mode === WITH_POINT
              ? { mode: 'reverse', ...await tools.reverseGeocodeTool({ lat: lat!, lon: lon!, maxDistanceMeters }) }
              : { mode: 'postal', ...await tools.searchPostalCode({ zipcode }) };
          return { content: [{ type: 'text', text: toolJson(answer) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${label} error: ${addressErrorMessage(err)}` }] };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['住所正規化', '住所検索', '番地', '号', '地番', '名寄せ', '突き合わせ', '住居表示', 'ABR', 'normalize', '郵便番号', 'zipcode', '郵便', '住所候補', '事業所郵便番号', '郵便番号検索', 'postal', '逆ジオコーディング', '座標から住所', '緯度経度から住所', '逆引き', '現在地住所', 'search_postal_code', 'normalize_address', 'reverse_geocode'] },
    );
  }
}
