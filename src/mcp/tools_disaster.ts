import { z } from 'zod';
import { fetchElevationAndCoordinates, fetchRecentEarthquakes, fetchRoadTraffic, fetchWeatherWarnings } from '../scraper.js';
import { EARTHQUAKE_SCALE_CODES } from '../types.js';
import { errorMessage } from '../errors.js';
import { addressEnabled } from '../services/address_config.js';
import { addressErrorMessage } from '../services/address_errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🚨 Category 5: Disaster & Emergency (モジュール: 'disaster') */
export function registerDisasterTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 16: search_road_traffic (リアルタイム道路交通情報 - JARTIC連携) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_road_traffic',
    'disaster',
    '【JARTIC道路交通直結】日本全国の高速道路・都市高速・主要有料道路のリアルタイム道路交通情報（事故・渋滞・通行止め・車線規制・チェーン規制・工事等）は、推測せずJARTIC（日本道路交通情報センター）連携の本ツールで取得してください。返却: { pref, road, updatedAt, hasIssues, summary, items: [{ roadName, direction, status, section, cause }] }',
    {
      pref: z.string().optional().describe('都道府県名またはコード (例: "東京都", "愛知県", "大阪府", "福岡県", "13")'),
      road: z.string().optional().describe('道路名 (例: "東名高速", "首都高", "中央道", "名神高速", "阪神高速", "東北道")'),
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
    { defaultEnabled: deferredDefault, keywords: ['道路交通情報', '通行止め', '渋滞', '高速道路', '規制', 'JARTIC'] },
  );

  // Tool 17: search_disaster_warnings (気象警報・注意報) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_disaster_warnings',
    'disaster',
    '【気象庁公式防災直結】大雨・洪水・暴風・大雪・波浪等の特別警報・気象警報・注意報は、一般Web検索の古い情報に頼らず必ず気象庁公式データ直結の本ツールで市区町村単位でリアルタイム取得してください。返却: { areaName, warnings: [{ name, level, status }] }',
    {
      city: z.string().optional().describe('市区町村名または都道府県名 (例: "東京", "新宿区", "大阪府", "福岡")'),
      areaCode: z.string().optional().describe('気象庁エリアコード (6桁または2桁, 例: "130000", "130010")'),
    },
    async (opts) => {
      try {
        const result = await fetchWeatherWarnings(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Disaster warnings error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['気象警報', '注意報', '特別警報', '防災', '気象庁', '大雨', '台風'] },
  );

  // Tool 18: search_earthquake (リアルタイム地震速報・履歴) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_earthquake',
    'disaster',
    '【公式地震速報直結】最新の地震履歴（発生時刻、震源地、マグニチュード、深さ、最大震度、津波有無、観測地点）は、推測せずP2P地震情報および気象庁公式速報直結の本ツールで取得してください。返却: { earthquakes: [{ time, hypocenter: { name, magnitude }, maxScale, tsunami }] }',
    {
      limit: z.number().int().min(1).max(20).optional().describe('取得件数 (1〜20, デフォルト: 5)').meta({ default: 5 }),
      // Gemini の関数宣言は enum を文字列にしか許さず、数の enum が 1 つあるとツール一覧ごと 400 になる。
      // MCP には範囲だけを出し、震度コードかどうかは refine で確かめる（REST の OpenAPI には enum を残す）
      minIntensity: z.number().int().min(10).max(70)
        .refine((v) => (EARTHQUAKE_SCALE_CODES as readonly number[]).includes(v), { message: `震度コードは ${EARTHQUAKE_SCALE_CODES.join('・')} のどれかです` })
        .optional()
        .describe('最小震度コード (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強, 55=震度6弱, 60=震度6強, 70=震度7, デフォルト: 10)')
        .meta({ default: 10 }),
    },
    async (opts) => {
      try {
        const result = await fetchRecentEarthquakes(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Earthquake search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['地震情報', '震度', '震源地', '津波', '気象庁', '地震'] },
  );

  // Tool: get_elevation (Nominatim 座標解決 & 国土地理院 標高取得) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_elevation',
    'disaster',
    '【標高・座標取得必須】座標や標高を推測せず、本ツールで取得してください。住所・地名をNominatimで座標化し（該当なしの番地住所は国土地理院の住所検索で補完）、国土地理院から海抜標高（m）を取得します。未キャッシュの地名解決は全ツール共有で1.1秒間隔となり、待機する場合があります。needsVerificationがtrueならmatchedTitleが意図した場所か確認してください。座標既知ならlat/lonを指定できます。回答・公開時はgeocodingAttributionを出典として表示すること。返却: { elevationMeters, dataAccuracy, lat, lon, matchedTitle, geocodingSource, geocodingAttribution, needsVerification }',
    {
      address: z.string().optional().describe('住所・地名文字列 (例: "東京都千代田区永田町1-7-1", "富士山頂")'),
      lat: z.number().optional().describe('緯度 (住所未指定時に直接指定, 例: 35.681236)'),
      lon: z.number().optional().describe('経度 (住所未指定時に直接指定, 例: 139.767125)'),
      noCache: z.boolean().optional().describe('座標解決・標高のキャッシュを使わず再取得する。1.1秒間隔は維持').meta({ default: false }),
    },
    async (opts) => {
      try {
        const result = await fetchElevationAndCoordinates(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Elevation error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['標高', '海抜', 'ジオコーディング', '国土地理院', '住所検索', '座標', '津波リスク', '水害'] },
  );

  // Tool: search_poi (OpenPOI 全国施設POI検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_poi',
    'disaster',
    '【OpenPOI直結・全国337万件】施設名・住所キーワードと位置範囲から施設を検索し、緯度経度付きで返します。複数語はORのため、場所はqueryに混ぜずcenterへ分離してください。centerはNominatimで座標化します（該当なしは国土地理院の住所検索で補完）。未キャッシュの解決は全ツール共有で1.1秒間隔となり、待機する場合があります。centerResolved.needsVerificationがtrueならaddressが意図した地域か確認し、異なる場合は地域名を補って再検索してください。候補一覧は返りません。座標既知ならlat/lon。get_elevation / search_routeと組み合わせ可能。回答・公開時は attribution・centerResolved.attribution・各 pois[].attributions（withAddress 指定時は addressAttribution も）を必ず出典として表示すること。返却: { centerResolved, count, pois: [{ name, address, lat, lng, licenses, attributions }], attribution }',
    {
      query: z.string().trim().min(1).max(200).optional().describe('施設・住所キーワード (例: "ラーメン", "世田谷区 カフェ")'),
      lat: z.number().min(-90).max(90).optional().describe('中心緯度 (lon とペア指定)'),
      lon: z.number().min(-180).max(180).optional().describe('中心経度 (lat とペア指定)'),
      radiusMeters: z.number().int().min(1).max(100000).optional().describe('中心からの半径m (デフォルト: 5000)').meta({ default: 5000 }),
      center: z.string().trim().min(1).max(200).optional().describe('中心地名 (例: "渋谷", "原宿")。Nominatimで座標化する。lat/lonとは排他'),
      bbox: z.string().optional().describe('矩形範囲 "minLng,minLat,maxLng,maxLat"'),
      limit: z.number().int().min(1).max(50).optional().default(10).describe('最大件数 (1-50, デフォルト: 10)'),
      noCache: z.boolean().optional().describe('地名解決のキャッシュを使わず再取得する。1.1秒間隔は維持').meta({ default: false }),
      withAddress: z.boolean().optional().describe('各施設の住所を正規化して郵便番号を付け、施設の座標と突き合わせて addressInfo として返す。住所データが揃う前に調べた施設は addressIncomplete: true（足りないデータは addressPending / addressUnavailable）で、数秒後の再実行で完全になる。解釈できない住所は addressInfo なしで印も付かない').meta({ default: false }),
    },
    async (opts) => {
      try {
        const { searchOpenPoi } = await import('../services/poi.js');
        const result = await searchOpenPoi(opts);
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
    // Tool: search_postal_code (郵便番号 ⇄ 住所候補) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_postal_code',
      'disaster',
      '【郵便番号 ⇄ 住所候補】郵便番号から住所候補を特定、または住所から郵便番号を逆引きします（一次データ: 日本郵便・デジタル庁ABR）。zipcode または address のどちらか一方を指定。大口事業所の個別郵便番号対応。使われた市区町村のみオンデマンド取得。返却: { zipcode, count, candidates: [{ kind, prefecture, city, town, detail?, office?, lgCode, lat?, lon?, locationLevel? }] } または { address, normalized, level, postalCodes: [{ zipcode, town, exact, fallback }] }, dataset, attribution }',
      {
        zipcode: z.string().trim().optional().describe('郵便番号 (例: "100-0014", "〒100-0014")。住所候補を引く。address とは排他'),
        address: z.string().trim().max(300).optional().describe('住所 (例: "東京都千代田区永田町1-7-1")。郵便番号を引く。zipcode とは排他'),
      },
      async (opts) => {
        try {
          const { searchPostalCode } = await import('../services/address_tools.js');
          const result = await searchPostalCode(opts);
          return {
            content: [{ type: 'text', text: toolJson(result) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Postal code error: ${addressErrorMessage(err)}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['郵便番号', 'zipcode', '郵便', '住所候補', '事業所郵便番号', '郵便番号検索', 'postal'] },
    );

    // Tool: normalize_address (住所正規化・番地号照合・突き合わせ) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'normalize_address',
      'disaster',
      '【住所正規化・番地号照合・突き合わせ】与えられた住所を番地・号（level 8）まで照合・正規化し、緯度経度・結合キーを付与します（デジタル庁ABR一次データ）。郵便番号・別座標・相手住所との突き合わせ（名寄せ）にも対応。numberSource は番地・号の照合の根拠: rsdt（住居表示）・chiban（地番）は番地・号を照合、mlit は国土交通省の街区データで街区符号まで（号は未照合で other に残る。確認済みの番地ではない）、null は整形のみ。座標の精度は point.level（8 番地・号 / 7 街区 / 3 町字）で判断（chiban で ABR に座標が無いとき pointSource: mlit）。返却: { normalized, addr, other, level, numberSource, keys, point: { lat, lon, level }, pointSource?, postalCodes, checks?: { zipcode?, coordinates?, compare? }, dataset, attribution }',
      {
        address: z.string().trim().min(1).max(300).describe('正規化する住所。先頭の〒郵便番号は postalCode として分離'),
        level: z.number().int().min(1).max(8).optional().describe('正規化する最大の階層 (1〜8、既定 8)。8は番地・号まで').meta({ default: 8 }),
        zipcode: z.string().trim().optional().describe('住所と突き合わせる郵便番号。市区町村の無い住所は、この番号の市区町村を補って解決する。checks.zipcode に match/partial/mismatch を返す'),
        lat: z.number().min(-90).max(90).optional().describe('突き合わせる緯度 (lon とペア)。checks.coordinates を返す'),
        lon: z.number().min(-180).max(180).optional().describe('突き合わせる経度 (lat とペア)'),
        compareAddress: z.string().trim().max(300).optional().describe('名寄せの相手の住所。checks.compare に一致階層と違いを返す'),
      },
      async (opts) => {
        try {
          const { normalizeAddressTool } = await import('../services/address_tools.js');
          const result = await normalizeAddressTool(opts);
          return {
            content: [{ type: 'text', text: toolJson(result) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Address normalize error: ${addressErrorMessage(err)}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['住所正規化', '住所検索', '番地', '号', '地番', '名寄せ', '突き合わせ', '住居表示', 'ABR', 'normalize'] },
    );

    // Tool: reverse_geocode (緯度経度 → 住所逆引き) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'reverse_geocode',
      'disaster',
      '【緯度経度 → 住所逆引き】緯度経度から最寄りの番地・号または町字の住所を特定します（全国町字点索引・ABR住居表示/地番データ）。代表点による最寄り判定。ABR の点が範囲内に無いときは国土交通省の街区の点（numberSource: mlit、point.level 7、番地の特定ではなく街区の近似）。返却: { found, address, normalized, level, numberSource, distanceMeters, keys, postalCodes, alternatives, dataset, attribution }',
      {
        lat: z.number().min(-90).max(90).describe('緯度'),
        lon: z.number().min(-180).max(180).describe('経度'),
        maxDistanceMeters: z.number().int().min(1).max(2000).optional().describe('番地・号の点を探す範囲m (既定 300、最大 2000)').meta({ default: 300 }),
      },
      async (opts) => {
        try {
          const { reverseGeocodeTool } = await import('../services/address_tools.js');
          const result = await reverseGeocodeTool(opts);
          return {
            content: [{ type: 'text', text: toolJson(result) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Reverse geocode error: ${addressErrorMessage(err)}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['逆ジオコーディング', '座標から住所', '緯度経度から住所', '逆引き', 'reverse_geocode', '現在地住所'] },
    );
  }
}
