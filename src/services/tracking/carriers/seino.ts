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

export const seinoAdapter: TrackingCarrierAdapter = {
  code: 'seino',
  name: '西濃運輸',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    const is10 = /^\d{10}$/.test(num);
    if (!is10) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['Seino requires 10-digit numeric code'] };
    }

    let score = 75;
    const reasons = ['Matches standard Seino 10-digit format'];

    if (hints?.preferredCarriers?.includes('seino')) {
      score += 15;
      reasons.push('Boosted by preferredCarriers hint');
    }

    return { candidate: true, score, strength: 'strong', reasons };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'seino';
    const trackingUrl = seinoAdapter.trackingUrl(num);

    try {
      const res = await fetch(`https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=${encodeURIComponent(num)}`, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
        signal: context?.signal || AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return {
          carrier,
          carrierName: seinoAdapter.name,
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
          carrierName: seinoAdapter.name,
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
          carrierName: seinoAdapter.name,
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
        carrierName: seinoAdapter.name,
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
        carrierName: seinoAdapter.name,
        trackingNumber: num,
        status: 'error',
        statusText: '西濃運輸への照会に失敗しました',
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
