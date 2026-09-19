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

export const fukutsuAdapter: TrackingCarrierAdapter = {
  code: 'fukutsu',
  name: '福山通運',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    const is11 = /^\d{11}$/.test(num);
    const is12 = /^\d{12}$/.test(num);

    if (!is11 && !is12) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['Fukutsu requires 11 or 12 digit numeric code'] };
    }

    let score = is11 ? 70 : 65;
    const strength = is11 ? 'strong' : 'weak';
    const reasons = [is11 ? 'Matches Fukutsu 11-digit format' : 'Matches Fukutsu 12-digit format'];

    if (hints?.preferredCarriers?.includes('fukutsu')) {
      score += 15;
      reasons.push('Boosted by preferredCarriers hint');
    }

    return { candidate: true, score, strength, reasons };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'fukutsu';
    const trackingUrl = fukutsuAdapter.trackingUrl(num);

    try {
      const signal = context?.signal || AbortSignal.timeout(10000);
      const res = await fetch(`https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${encodeURIComponent(num)}`, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
        signal,
      });

      if (!res.ok) {
        return {
          carrier,
          carrierName: fukutsuAdapter.name,
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
          carrierName: fukutsuAdapter.name,
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
          carrierName: fukutsuAdapter.name,
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
        carrierName: fukutsuAdapter.name,
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
        carrierName: fukutsuAdapter.name,
        trackingNumber: num,
        status: 'error',
        statusText: '福山通運への照会に失敗しました',
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
