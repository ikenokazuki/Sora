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

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function determineStatus(text: string): TrackingResult['status'] {
  const t = text.replace(/\s+/g, '');
  if (!t) return 'unknown';

  if (/配達完了|お届け完了|お届け先にお届け済み|受取完了|受取済|配達済|配達終了|引渡完了|配達済み/i.test(t)) {
    return 'delivered';
  }
  if (/配達中|持出中|輸送中|作業中|運行中|発送|出発|通過|中継|持戻|保管中|調査中|配達指定|転送中|依頼受付|営業所受取/i.test(t)) {
    return 'in_transit';
  }
  if (/受付|引受|集荷|荷物受付|集荷完了|荷物預かり/i.test(t)) {
    return 'registered';
  }
  if (/返送|返品|差出人に返送/i.test(t)) {
    return 'returned';
  }
  if (/誤り|見当りません|見当たりません|見つかりません|該当なし|未登録|該当する荷物はありません/i.test(t)) {
    return 'not_found';
  }
  return 'unknown';
}

export const yamatoAdapter: TrackingCarrierAdapter = {
  code: 'yamato',
  name: 'ヤマト運輸',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    const is12 = /^\d{12}$/.test(num);
    const is11 = /^\d{11}$/.test(num);

    if (!is12 && !is11) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['Yamato requires 11 or 12 digit numeric code'] };
    }

    let score = is12 ? 75 : 65;
    const strength = is12 ? 'strong' : 'weak';
    const reasons = [is12 ? 'Matches standard Yamato 12-digit format' : 'Matches Yamato 11-digit format'];

    if (hints?.preferredCarriers?.includes('yamato')) {
      score += 15;
      reasons.push('Boosted by preferredCarriers hint');
    }

    return { candidate: true, score, strength, reasons };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'yamato';
    const trackingUrl = yamatoAdapter.trackingUrl(num);

    try {
      const res = await fetch('https://toi.kuronekoyamato.co.jp/cgi-bin/tneko', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': DEFAULT_USER_AGENT,
        },
        body: new URLSearchParams({ number00: '1', number01: num }).toString(),
        signal: context?.signal || AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return {
          carrier,
          carrierName: yamatoAdapter.name,
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

      if (
        stateTitle.includes('伝票番号誤り') ||
        stateSummary.includes('誤り') ||
        stateSummary.includes('確認できません')
      ) {
        return {
          carrier,
          carrierName: yamatoAdapter.name,
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
          carrierName: yamatoAdapter.name,
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
        carrierName: yamatoAdapter.name,
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
        carrierName: yamatoAdapter.name,
        trackingNumber: num,
        status: 'error',
        statusText: 'ヤマト運輸への照会に失敗しました',
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
