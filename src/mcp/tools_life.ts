import { z } from 'zod';
import { fetchFlightStatus, fetchWeatherForecast, searchTransitRoute, trackPackage } from '../scraper.js';
import { TRANSIT_ROUTE_INPUT_SHAPE } from '../types.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🗾 Category 4: Japanese Daily Life Services (モジュール: 'life') */
export function registerLifeTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 14: search_route (電車・鉄道 乗換案内) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_route',
    'life',
    '【公式直結・推測運賃厳禁】日本国内の電車・新幹線・地下鉄等の駅間最適ルート・所要時間・乗換回数・IC/きっぷ運賃は、推測で不正確な案内をせず必ずYahoo!路線情報直結の本ツールで探索してください。経由駅指定（最大3駅）や日時指定に対応。返却: { routes: [{ index, totalTime, transfers, fare, sections, summary }] }',
    TRANSIT_ROUTE_INPUT_SHAPE,
    async (opts) => {
      try {
        const result = await searchTransitRoute(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Transit route error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['乗換案内', '電車', 'ルート', '経路', '交通', '時刻表'] },
  );

  // Tool 15: get_weather (日本の天気予報 - 気象庁公式オープンデータ直結) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_weather',
    'life',
    '【公式直結・推測厳禁】日本国内各地の天気予報・予想気温・降水確率・概況は、一般的な推測を行わず必ず気象庁公式オープンデータ直結の本ツールを実行してください。全国 1,805 市区町村名（例: "天童市", "軽井沢", "石垣島"）または都道府県名・地点IDに対応。今日から最大7日先（計8日分）の週間予報を取得可能。返却: { source, title, forecasts: [{ date, telop, temperature, chanceOfRain }] }',
    {
      city: z.string().min(1).describe('市区町村名または都道府県名（例: "天童市", "軽井沢", "箱根", "浦安", "東京", "大阪", "福岡", "那覇"）、もしくは6桁の地点ID（例: "130010"）'),
      days: z.number().int().min(1).max(8).optional().describe('取得する予報日数 (1〜8日, デフォルト: 7)').meta({ default: 7 }),
    },
    async ({ city, days }) => {
      try {
        const result = await fetchWeatherForecast({ city, days });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Weather forecast error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['天気予報', '気象', '気温', '降水確率', '週間天気', '天気'] },
  );

  // Tool: get_flight_status (フライト航空運行情報) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_flight_status',
    'life',
    '【公式運航情報直結】主要空港（羽田、成田、伊丹、関西、中部、新千歳、福岡、那覇等）の国内線・国際線フライトリアルタイム運航状況・欠航・遅延ステータスおよび理由詳細は、推測せず必ず本ツールで確認してください。返却: { airportName, summary, flights: [{ flightNumber, airline, scheduledTime, status }] }',
    {
      airport: z.string().optional().describe('対象空港名またはコード (例: "羽田", "成田", "伊丹", "関空", "中部", "新千歳", "福岡", "那覇", "HND", "NRT", "ITM", "KIX", "NGO", デフォルト: "羽田")').meta({ default: '羽田' }),
      type: z.enum(['departure', 'arrival']).optional().describe('発着区分: "departure"(出発) または "arrival"(到着) (デフォルト: "departure")').meta({ default: 'departure' }),
      category: z.enum(['domestic', 'international']).optional().describe('路線区分: "domestic"(国内線) または "international"(国際線) (デフォルト: "domestic")').meta({ default: 'domestic' }),
      flightNumber: z.string().optional().describe('特定の便名で絞り込む場合 (例: "ANA2421", "JAL505")'),
      keyword: z.string().optional().describe('目的地・出発地・航空会社名などのキーワード絞り込み (例: "那覇", "全日本空輸")'),
    },
    async (opts) => {
      try {
        const result = await fetchFlightStatus(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Flight status error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['フライト', '航空', '飛行機', '空港', '欠航', '遅延', '羽田', '成田', 'JAL', 'ANA'] },
  );

  // Tool: track_package (主要運送会社・UPS・FedEx・DHL Express 荷物追跡)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'track_package',
    'life',
    '【公式直結・荷物追跡】日本の主要運送会社（ヤマト運輸・佐川急便・日本郵便 国内+国際EMS/UPU S10・西濃運輸・福山通運）および国際配送（UPS・FedEx・DHL Express）の荷物追跡情報・配送ステータス（配達中、配達完了、引受、持ち戻り等）および詳細履歴を取得します。運送会社コード（yamato, sagawa, japanpost, seino, fukutsu, ups, fedex, dhl）を指定可能。未指定または "auto" の場合は伝票番号から候補会社をローカル自動判別・検証照会します。返却: { carrier, carrierName, trackingNumber, status, statusText, events: [{ date, status, location }], trackingUrl }',
    {
      trackingNumber: z.string().min(1).describe('荷物の追跡番号・送り状番号・お問い合わせ番号（ハイフン有無問わず、全角半角対応）'),
      carrier: z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl', 'auto']).optional()
        .describe('運送会社コード: "yamato"(ヤマト運輸), "sagawa"(佐川急便), "japanpost"(日本郵便 国内+国際), "seino"(西濃運輸), "fukutsu"(福山通運), "ups"(UPS), "fedex"(FedEx), "dhl"(DHL Express)。省略または "auto" で自動判別'),
      preferredCarriers: z.array(z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl'])).optional()
        .describe('優先的に検証する運送会社候補のヒント配列'),
      originCountry: z.string().optional().describe('差出元の国コード（ISO 2文字）'),
      destinationCountry: z.string().optional().describe('お届け先の国コード（ISO 2文字）'),
      noCache: z.boolean().optional().describe('キャッシュをバイパスして最新情報を強制再取得するか').meta({ default: false }),
    },
    async ({ trackingNumber, carrier, preferredCarriers, originCountry, destinationCountry, noCache }) => {
      try {
        const result = await trackPackage({
          trackingNumber,
          carrier: carrier ?? 'auto',
          preferredCarriers,
          originCountry,
          destinationCountry,
          noCache: noCache ?? false,
        });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Package tracking error: ${errorMessage(err) || err}` }],
        };
      }
    },
    {
      defaultEnabled: deferredDefault,
      keywords: [
        '荷物追跡',
        '荷物',
        '配送',
        '配達',
        '追跡',
        '配送状況',
        '宅配便',
        '宅急便',
        'ヤマト',
        'クロネコヤマト',
        '佐川',
        '佐川急便',
        '日本郵便',
        '郵便',
        'ゆうパック',
        '西濃運輸',
        '福山通運',
        'UPS',
        'FedEx',
        'フェデックス',
        'DHL',
        'DHL Express',
        'EMS',
        '国際郵便',
        'UPU',
        '伝票番号',
        '送り状',
        'tracking',
        'package',
      ],
    },
  );

}
