import * as cheerio from 'cheerio';
import {
  type CarrierCode,
  type TrackingStatus,
  type TrackingEvent,
  type TrackingResult,
  type TrackingRequest,
} from '../types.js';
import { getFromCache, setToCache } from '../cache.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TRACKING_CACHE_TTL = 5 * 60 * 1000; // 5分

/**
 * 伝票番号の正規化（全角英数の半角化、空白・ハイフンの除去、大文字統一）
 */
export function cleanTrackingNumber(raw: string): string {
  if (!raw) return '';
  // 全角英数を半角に変換
  const normalized = raw.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  // 空白・改行・ハイフン・全角ハイフン・ダッシュ等を除去
  return normalized.replace(/[\s\-_ー−‐―]/g, '').trim().toUpperCase();
}

/**
 * キャリアごとの公式追跡WebリンクURLの生成
 */
export function getCarrierTrackingUrl(carrier: CarrierCode, trackingNumber: string): string {
  const num = cleanTrackingNumber(trackingNumber);
  switch (carrier) {
    case 'yamato':
      return `https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=${encodeURIComponent(num)}`;
    case 'sagawa':
      return `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(num)}`;
    case 'japanpost':
      return `https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=${encodeURIComponent(num)}`;
    case 'seino':
      return `https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=${encodeURIComponent(num)}`;
    case 'fukutsu':
      return `https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${encodeURIComponent(num)}`;
    case 'ups':
      return `https://www.ups.com/track?loc=ja_JP&tracknum=${encodeURIComponent(num)}`;
  }
}

/**
 * 日本語キャリア名称
 */
export function getCarrierName(carrier: CarrierCode): string {
  switch (carrier) {
    case 'yamato':
      return 'ヤマト運輸';
    case 'sagawa':
      return '佐川急便';
    case 'japanpost':
      return '日本郵便';
    case 'seino':
      return '西濃運輸';
    case 'fukutsu':
      return '福山通運';
    case 'ups':
      return 'UPS';
  }
}

/**
 * 状態テキストから統一ステータスコードを判定
 */
export function determineStatus(text: string): TrackingStatus {
  const t = text.replace(/\s+/g, '');
  if (!t) return 'unknown';

  if (
    /配達完了|お届け完了|お届け先にお届け済み|受取完了|受取済|配達済|配達終了|引渡完了|配達済み/i.test(t)
  ) {
    return 'delivered';
  }
  if (
    /配達中|持出中|輸送中|作業中|運行中|発送|出発|通過|中継|持戻|保管中|調査中|配達指定|転送中|依頼受付|営業所受取/i.test(t)
  ) {
    return 'in_transit';
  }
  if (
    /受付|引受|集荷|荷物受付|集荷完了|荷物預かり/i.test(t)
  ) {
    return 'registered';
  }
  if (
    /返送|返品|差出人に返送/i.test(t)
  ) {
    return 'returned';
  }
  if (
    /誤り|見当りません|見当たりません|見つかりません|該当なし|未登録|該当する荷物はありません/i.test(t)
  ) {
    return 'not_found';
  }
  return 'unknown';
}

/**
 * 追跡番号の形式から候補となる運送会社を推定
 */
export function detectCandidates(rawNumber: string): CarrierCode[] {
  const num = cleanTrackingNumber(rawNumber);
  if (!num) return ['yamato', 'sagawa', 'japanpost'];

  // UPS: 1Z で始まる18桁英数字
  if (/^1Z[0-9A-Z]{16}$/i.test(num)) {
    return ['ups'];
  }

  // 日本郵便 国際（EMS等）: アルファベット2文字 + 数字9桁 + 国コード2文字
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(num)) {
    return ['japanpost'];
  }

  // 10桁数字: 西濃運輸、佐川急便
  if (/^\d{10}$/.test(num)) {
    return ['seino', 'sagawa'];
  }

  // 11桁数字: 日本郵便（レターパック等）、福山通運、ヤマト運輸（クロネコゆうパケット等）
  if (/^\d{11}$/.test(num)) {
    return ['japanpost', 'fukutsu', 'yamato'];
  }

  // 12桁数字: 日本の主要宅配便（ヤマト、佐川、ゆうパック、福山通運）
  if (/^\d{12}$/.test(num)) {
    return ['yamato', 'sagawa', 'japanpost', 'fukutsu'];
  }

  // 13桁数字: 日本郵便
  if (/^\d{13}$/.test(num)) {
    return ['japanpost'];
  }

  // その他: 主要3社＋UPS
  return ['yamato', 'sagawa', 'japanpost', 'ups'];
}

// ==========================================
// 1. ヤマト運輸 (Yamato Transport)
// ==========================================
export async function trackYamato(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'yamato';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  try {
    const res = await fetch('https://toi.kuronekoyamato.co.jp/cgi-bin/tneko', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DEFAULT_USER_AGENT,
      },
      body: new URLSearchParams({ number00: '1', number01: num }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'error',
        statusText: `ヤマト運輸サーバーエラー (${res.status})`,
        events: [],
        trackingUrl,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const stateTitle = $('.tracking-invoice-block-state-title').text().trim();
    const stateSummary = $('.tracking-invoice-block-state-summary').text().trim();

    // 番号誤り・未登録
    if (
      stateTitle.includes('伝票番号誤り') ||
      stateSummary.includes('誤り') ||
      stateSummary.includes('確認できません')
    ) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: stateTitle || stateSummary || '伝票番号に誤りがあるか未登録です',
        events: [],
        trackingUrl,
      };
    }

    const events: TrackingEvent[] = [];
    $('.tracking-invoice-block-detail li').each((_, el) => {
      const item = $(el).find('.item').text().trim();
      const date = $(el).find('.date').text().trim();
      const name = $(el).find('.name').text().trim();
      if (item || date) {
        events.push({
          status: item,
          date,
          location: name || undefined,
        });
      }
    });

    if (events.length === 0 && !stateTitle) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当する荷物情報が見つかりませんでした',
        events: [],
        trackingUrl,
      };
    }

    const currentStatusText = stateTitle || (events.length > 0 ? events[events.length - 1].status : '荷物情報取得');
    const status = determineStatus(currentStatusText);

    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status,
      statusText: currentStatusText,
      events,
      trackingUrl,
      details: {
        serviceType: '宅急便',
      },
    };
  } catch (err: any) {
    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status: 'error',
      statusText: 'ヤマト運輸への照会に失敗しました',
      events: [],
      trackingUrl,
      error: err.message,
    };
  }
}

// ==========================================
// 2. 佐川急便 (Sagawa Express)
// ==========================================
export async function trackSagawa(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'sagawa';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  try {
    const res = await fetch(`https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(num)}`, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'error',
        statusText: `佐川急便サーバーエラー (${res.status})`,
        events: [],
        trackingUrl,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const stateSpan = $('.table_okurijo_index .state').text().trim();
    if (stateSpan.includes('該当なし') || html.includes('該当なし')) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当するお荷物が見つかりません',
        events: [],
        trackingUrl,
      };
    }

    const events: TrackingEvent[] = [];
    const detailTable = $('.table_okurijo_detail2').last();

    detailTable.find('tr').each((idx, tr) => {
      // 1行目はヘッダー行の場合があるためスキップ判定
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const statusText = tds.eq(0).text().trim().replace(/^⇒\s*/, '');
        const dateText = tds.eq(1).text().trim();
        const officeText = tds.length >= 3 ? tds.eq(2).text().trim() : '';

        if (statusText || dateText) {
          events.push({
            status: statusText,
            date: dateText,
            location: officeText || undefined,
          });
        }
      }
    });

    if (events.length === 0 && !stateSpan) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当する荷物情報が見つかりませんでした',
        events: [],
        trackingUrl,
      };
    }

    const currentStatusText = stateSpan || (events.length > 0 ? events[events.length - 1].status : '荷物情報取得');
    const status = determineStatus(currentStatusText);

    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status,
      statusText: currentStatusText,
      events,
      trackingUrl,
      details: {
        serviceType: '飛脚宅配便',
      },
    };
  } catch (err: any) {
    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status: 'error',
      statusText: '佐川急便への照会に失敗しました',
      events: [],
      trackingUrl,
      error: err.message,
    };
  }
}

// ==========================================
// 3. 日本郵便 (Japan Post)
// ==========================================
export async function trackJapanPost(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'japanpost';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  try {
    const res = await fetch(
      `https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=${encodeURIComponent(num)}`,
      {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!res.ok) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'error',
        statusText: `日本郵便サーバーエラー (${res.status})`,
        events: [],
        trackingUrl,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // 未登録・見つかりませんチェック
    const resultTable = $('table[summary="照会結果"]').text();
    if (resultTable.includes('見つかりません') || html.includes('お問い合わせ番号が見つかりません')) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: 'お問い合わせ番号が見つかりません',
        events: [],
        trackingUrl,
      };
    }

    const events: TrackingEvent[] = [];
    const historyTable = $('table[summary="履歴情報"]');

    historyTable.find('tr').each((idx, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const date = tds.eq(0).text().trim();
        const status = tds.eq(1).text().trim();
        const detail = tds.length >= 3 ? tds.eq(2).text().trim() : '';
        const office = tds.length >= 4 ? tds.eq(3).text().trim() : '';
        const pref = tds.length >= 5 ? tds.eq(4).text().trim() : '';

        if (status || date) {
          const loc = [pref, office].filter(Boolean).join(' ');
          events.push({
            date: date || undefined,
            status,
            location: loc || undefined,
            description: detail || undefined,
          });
        }
      }
    });

    if (events.length === 0) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当するお荷物履歴が見つかりませんでした',
        events: [],
        trackingUrl,
      };
    }

    const latestEvent = events[events.length - 1];
    const currentStatusText = latestEvent.status;
    const status = determineStatus(currentStatusText);

    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status,
      statusText: currentStatusText,
      events,
      trackingUrl,
      details: {
        serviceType: 'ゆうパック/ゆうパケット/EMS/国際郵便',
      },
    };
  } catch (err: any) {
    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status: 'error',
      statusText: '日本郵便への照会に失敗しました',
      events: [],
      trackingUrl,
      error: err.message,
    };
  }
}

// ==========================================
// 4. 西濃運輸 (Seino Transportation)
// ==========================================
export async function trackSeino(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'seino';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  try {
    const res = await fetch(`https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=${encodeURIComponent(num)}`, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'error',
        statusText: `西濃運輸サーバーエラー (${res.status})`,
        events: [],
        trackingUrl,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    // Shift_JIS をデコード
    const arrayBuffer = await res.arrayBuffer();
    const decoder = new TextDecoder('shift-jis');
    const html = decoder.decode(new Uint8Array(arrayBuffer));
    const $ = cheerio.load(html);

    const col4Text = $('td.col4').first().text().trim();
    if (col4Text.includes('見当りません') || col4Text.includes('見当たりません') || col4Text.includes('入力されたお問合せ番号')) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: col4Text || '入力されたお問合せ番号が見当りません',
        events: [],
        trackingUrl,
      };
    }

    const events: TrackingEvent[] = [];
    const dateText = $('td.col2').first().text().trim();
    const officeText = $('td.col5').first().text().trim() || $('td.col6').first().text().trim();

    if (col4Text) {
      events.push({
        status: col4Text,
        date: dateText || undefined,
        location: officeText || undefined,
      });
    }

    if (events.length === 0) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当するお荷物情報が見つかりませんでした',
        events: [],
        trackingUrl,
      };
    }

    const currentStatusText = col4Text || '配達中';
    const status = determineStatus(currentStatusText);

    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status,
      statusText: currentStatusText,
      events,
      trackingUrl,
      details: {
        serviceType: 'カンガルー便',
      },
    };
  } catch (err: any) {
    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status: 'error',
      statusText: '西濃運輸への照会に失敗しました',
      events: [],
      trackingUrl,
      error: err.message,
    };
  }
}

// ==========================================
// 5. 福山通運 (Fukuyama Transporting)
// ==========================================
export async function trackFukutsu(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'fukutsu';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  try {
    const res = await fetch(`https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${encodeURIComponent(num)}`, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'error',
        statusText: `福山通運サーバーエラー (${res.status})`,
        events: [],
        trackingUrl,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    // Shift_JIS をデコード
    const arrayBuffer = await res.arrayBuffer();
    const decoder = new TextDecoder('shift-jis');
    const html = decoder.decode(new Uint8Array(arrayBuffer));
    const $ = cheerio.load(html);

    const errMsg = $('.errormessage').text().trim() || $('.errmsg').text().trim();
    if (errMsg.includes('正しく入力') || errMsg.includes('見つかりません')) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: errMsg || 'お問い合わせ番号が見つかりません',
        events: [],
        trackingUrl,
      };
    }

    const events: TrackingEvent[] = [];
    const contentRow = $('tr.address_content').first();
    const tds = contentRow.find('td');

    if (tds.length >= 4) {
      const sendDate = tds.eq(1).text().trim();
      const updateDate = tds.eq(2).text().trim();
      const statusText = tds.eq(3).text().trim();
      const note = tds.length >= 5 ? tds.eq(4).text().trim() : '';

      if (statusText && statusText !== '&nbsp;') {
        events.push({
          status: statusText,
          date: updateDate || sendDate || undefined,
          description: note || undefined,
        });
      }
    }

    if (events.length === 0) {
      return {
        carrier,
        carrierName: getCarrierName(carrier),
        trackingNumber: num,
        status: 'not_found',
        statusText: '該当するお荷物情報が見つかりませんでした',
        events: [],
        trackingUrl,
      };
    }

    const latest = events[events.length - 1];
    const currentStatusText = latest.status;
    const status = determineStatus(currentStatusText);

    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status,
      statusText: currentStatusText,
      events,
      trackingUrl,
      details: {
        serviceType: 'フクツー便',
      },
    };
  } catch (err: any) {
    return {
      carrier,
      carrierName: getCarrierName(carrier),
      trackingNumber: num,
      status: 'error',
      statusText: '福山通運への照会に失敗しました',
      events: [],
      trackingUrl,
      error: err.message,
    };
  }
}

// ==========================================
// 6. UPS
// ==========================================
export async function trackUps(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const carrier: CarrierCode = 'ups';
  const trackingUrl = getCarrierTrackingUrl(carrier, num);

  // UPS OAuth 認証情報が設定されている場合は公式 API を利用
  const clientId = process.env.UPS_CLIENT_ID;
  const clientSecret = process.env.UPS_CLIENT_SECRET;

  if (clientId && clientSecret) {
    try {
      // 1. OAuth トークン取得
      const tokenRes = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10000),
      });

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // 2. 追跡 API リクエスト
        const trackRes = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(num)}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            transId: `sora-${Date.now()}`,
            transactionSrc: 'sora',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (trackRes.ok) {
          const data = await trackRes.json();
          const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0];
          const activity = pkg?.activity || [];
          const currentStatus = pkg?.currentStatus?.description || '配送状況確認済';

          const events: TrackingEvent[] = activity.map((act: any) => ({
            date: `${act.date || ''} ${act.time || ''}`.trim() || undefined,
            status: act.status?.description || act.status?.type || '通過',
            location: [act.location?.address?.city, act.location?.address?.country].filter(Boolean).join(', ') || undefined,
          }));

          return {
            carrier,
            carrierName: getCarrierName(carrier),
            trackingNumber: num,
            status: determineStatus(currentStatus),
            statusText: currentStatus,
            events,
            trackingUrl,
            details: {
              serviceType: pkg?.service?.description || 'UPS Standard/Express',
              deliveryDate: pkg?.deliveryDate?.[0]?.date,
            },
          };
        }
      }
    } catch (err: any) {
      console.warn('UPS API call failed, falling back to direct URL guidance:', err.message);
    }
  }

  // API未設定またはフォールバック: 公式Web追跡URLとガイダンスを返却
  return {
    carrier,
    carrierName: getCarrierName(carrier),
    trackingNumber: num,
    status: 'registered',
    statusText: 'UPS公式追跡ページにて詳細配送状況をご確認いただけます',
    events: [
      {
        status: '追跡URL生成完了',
        description: 'UPS公式Webリンクよりリアルタイムな詳細追跡情報をご確認ください',
      },
    ],
    trackingUrl,
    details: {
      serviceType: 'UPS International',
    },
  };
}

// ==========================================
// キャリア単体追跡ルーター
// ==========================================
export async function trackByCarrier(carrier: CarrierCode, trackingNumber: string): Promise<TrackingResult> {
  switch (carrier) {
    case 'yamato':
      return trackYamato(trackingNumber);
    case 'sagawa':
      return trackSagawa(trackingNumber);
    case 'japanpost':
      return trackJapanPost(trackingNumber);
    case 'seino':
      return trackSeino(trackingNumber);
    case 'fukutsu':
      return trackFukutsu(trackingNumber);
    case 'ups':
      return trackUps(trackingNumber);
  }
}

// ==========================================
// 自動判別投機的並行追跡 (Auto-Detection)
// ==========================================
export async function trackPackageAuto(trackingNumber: string): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const candidates = detectCandidates(num);

  // 候補が1社の場合は単体実行
  if (candidates.length === 1) {
    return trackByCarrier(candidates[0], num);
  }

  // 複数候補に並行問い合わせ (Promise.allSettled)
  const queries = candidates.map((c) => trackByCarrier(c, num));
  const settled = await Promise.allSettled(queries);

  // 有効な追跡結果（not_found / error 以外）を優先的に採択
  const validResults: TrackingResult[] = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && res.value.status !== 'not_found' && res.value.status !== 'error') {
      validResults.push(res.value);
    }
  }

  if (validResults.length > 0) {
    // 複数ヒットした場合は、完了(delivered)や配達中(in_transit)など進捗の進んだものを優先
    validResults.sort((a, b) => {
      const priority: Record<TrackingStatus, number> = {
        delivered: 5,
        in_transit: 4,
        registered: 3,
        returned: 2,
        unknown: 1,
        not_found: 0,
        error: -1,
      };
      return (priority[b.status] || 0) - (priority[a.status] || 0);
    });
    return validResults[0];
  }

  // いずれもヒットしなかった場合、第1候補の結果をベースに未検出レスポンスを返却
  const primaryCarrier = candidates[0];
  return {
    carrier: primaryCarrier,
    carrierName: getCarrierName(primaryCarrier),
    trackingNumber: num,
    status: 'not_found',
    statusText: `該当するお荷物情報が見つかりませんでした (検索候補: ${candidates.map(getCarrierName).join(', ')})`,
    events: [],
    trackingUrl: getCarrierTrackingUrl(primaryCarrier, num),
  };
}

// ==========================================
// 統合エントリーポイント（キャッシュ付き）
// ==========================================
export async function trackPackage(req: TrackingRequest): Promise<TrackingResult> {
  const num = cleanTrackingNumber(req.trackingNumber);
  if (!num) {
    throw new Error('追跡番号を入力してください');
  }

  const carrier = req.carrier && req.carrier !== 'auto' ? (req.carrier as CarrierCode) : 'auto';
  const cacheKey = `tracking:${carrier}:${num}`;

  if (!req.noCache) {
    const cached = getFromCache<TrackingResult>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  let result: TrackingResult;
  if (carrier === 'auto') {
    result = await trackPackageAuto(num);
  } else {
    result = await trackByCarrier(carrier, num);
  }

  result.fetchedAt = new Date().toISOString();

  // not_found や error でなければキャッシュに保存
  if (result.status !== 'error') {
    setToCache(cacheKey, result, TRACKING_CACHE_TTL);
  }

  return result;
}
