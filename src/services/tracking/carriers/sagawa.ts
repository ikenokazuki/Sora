import * as cheerio from 'cheerio';
import type {
  TrackingCarrierAdapter,
  CarrierDetectionSignal,
  TrackingDetectionHints,
  TrackingResult,
  TrackingVerification,
  TrackingContext,
  TrackingEvent,
} from '../types.js';
import { cleanTrackingNumber } from '../normalization.js';
import { evaluateTrackingVerification } from '../verification.js';
import { determineStatus } from './yamato.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const sagawaAdapter: TrackingCarrierAdapter = {
  code: 'sagawa',
  name: '佐川急便',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    const is12 = /^\d{12}$/.test(num);
    const is10 = /^\d{10}$/.test(num);

    if (!is12 && !is10) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['Sagawa requires 10 or 12 digit numeric code'] };
    }

    let score = is12 ? 75 : 70;
    const strength = 'strong';
    const reasons = [is12 ? 'Matches standard Sagawa 12-digit format' : 'Matches Sagawa 10-digit format'];

    if (hints?.preferredCarriers?.includes('sagawa')) {
      score += 15;
      reasons.push('Boosted by preferredCarriers hint');
    }

    return { candidate: true, score, strength, reasons };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'sagawa';
    const trackingUrl = sagawaAdapter.trackingUrl(num);

    try {
      const res = await fetch(`https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(num)}`, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
        signal: context?.signal || AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return {
          carrier,
          carrierName: sagawaAdapter.name,
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
          carrierName: sagawaAdapter.name,
          trackingNumber: num,
          status: 'not_found',
          statusText: '該当するお荷物が見つかりません',
          events: [],
          trackingUrl,
        };
      }

      const events: TrackingEvent[] = [];
      const detailTable = $('.table_okurijo_detail2').last();

      detailTable.find('tr').each((_, tr) => {
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
          carrierName: sagawaAdapter.name,
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
        carrierName: sagawaAdapter.name,
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
        carrierName: sagawaAdapter.name,
        trackingNumber: num,
        status: 'error',
        statusText: '佐川急便への照会に失敗しました',
        events: [],
        trackingUrl,
        error: err?.message || String(err),
      };
    }
  },

  verify(result: TrackingResult, requestedTrackingNumber: string): TrackingVerification {
    return evaluateTrackingVerification(result, requestedTrackingNumber);
  },
};
