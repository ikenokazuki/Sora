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
import { parseS10TrackingNumber } from '../postal.js';
import { determineStatus } from './yamato.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const japanPostAdapter: TrackingCarrierAdapter = {
  code: 'japanpost',
  name: '日本郵便',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    // 1. 国際郵便 UPU S10 パース & チェックディジット判定
    const s10 = parseS10TrackingNumber(num);
    if (/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(num)) {
      if (s10.valid) {
        const isJP = s10.issuingCountry === 'JP';
        let score = isJP ? 95 : 85;
        const reasons = [
          isJP
            ? 'Valid UPU S10 parcel identifier issued by Japan Post (JP)'
            : `Valid UPU S10 parcel identifier (${s10.issuingCountry}) routable via Japan Post international network`,
        ];

        if (hints?.preferredCarriers?.includes('japanpost')) {
          score += 15;
          reasons.push('Boosted by preferredCarriers hint');
        }

        return { candidate: true, score, strength: 'strong', reasons };
      } else {
        return {
          candidate: true,
          score: 50,
          strength: 'weak',
          reasons: ['Matches UPU S10 format but invalid check digit checksum'],
        };
      }
    }

    // 2. 国内郵便の数字桁数判定
    const is11 = /^\d{11}$/.test(num);
    const is12 = /^\d{12}$/.test(num);
    const is13 = /^\d{13}$/.test(num);

    if (is11 || is12 || is13) {
      let score = is13 ? 85 : is11 ? 75 : 70;
      const desc = is13
        ? 'Matches Japan Post 13-digit postal format'
        : is11
          ? 'Matches Japan Post 11-digit format (LetterPack / Yu-Packet)'
          : 'Matches Japan Post 12-digit format (Yu-Pack)';
      const reasons = [desc];

      if (hints?.preferredCarriers?.includes('japanpost')) {
        score += 15;
        reasons.push('Boosted by preferredCarriers hint');
      }

      return { candidate: true, score, strength: 'strong', reasons };
    }

    return { candidate: false, score: 0, strength: 'weak', reasons: ['Does not match domestic numeric or UPU S10 format'] };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'japanpost';
    const trackingUrl = japanPostAdapter.trackingUrl(num);
    const s10 = parseS10TrackingNumber(num);

    const postalMeta = s10.valid
      ? {
          network: 'upu' as const,
          international: true,
          issuingCountry: s10.issuingCountry,
          serviceIndicator: s10.serviceIndicator,
        }
      : undefined;

    try {
      const res = await fetch(trackingUrl, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
        signal: context?.signal || AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return {
          carrier,
          carrierName: japanPostAdapter.name,
          trackingNumber: num,
          status: 'error',
          statusText: `日本郵便サーバーエラー (${res.status})`,
          events: [],
          trackingUrl,
          postal: postalMeta,
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      // 未登録・見つかりませんチェック
      const resultTable = $('table[summary="照会結果"]').text();
      if (resultTable.includes('見つかりません') || html.includes('お問い合わせ番号が見つかりません')) {
        // UPU S10 国際郵便の場合、日本郵政側にまだ引受情報が未反映の可能性があるため、指示書 #33 に従い unknown と案内
        if (s10.valid) {
          return {
            carrier,
            carrierName: japanPostAdapter.name,
            trackingNumber: num,
            status: 'unknown',
            statusText: `国際郵便（${s10.issuingCountry}発行）の情報が日本郵便に未反映であるか、番号が未登録です`,
            events: [],
            trackingUrl,
            postal: postalMeta,
          };
        }

        return {
          carrier,
          carrierName: japanPostAdapter.name,
          trackingNumber: num,
          status: 'not_found',
          statusText: 'お問い合わせ番号が見つかりません',
          events: [],
          trackingUrl,
          postal: postalMeta,
        };
      }

      const events: TrackingEvent[] = [];
      const historyTable = $('table[summary="履歴情報"]');

      historyTable.find('tr').each((_, tr) => {
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
        if (s10.valid) {
          return {
            carrier,
            carrierName: japanPostAdapter.name,
            trackingNumber: num,
            status: 'unknown',
            statusText: `国際郵便（${s10.issuingCountry}発行）の履歴がまだ確認できません`,
            events: [],
            trackingUrl,
            postal: postalMeta,
          };
        }

        return {
          carrier,
          carrierName: japanPostAdapter.name,
          trackingNumber: num,
          status: 'not_found',
          statusText: '該当するお荷物履歴が見つかりませんでした',
          events: [],
          trackingUrl,
          postal: postalMeta,
        };
      }

      const latestEvent = events[events.length - 1];
      const currentStatusText = latestEvent.status;
      const status = determineStatus(currentStatusText);

      return {
        carrier,
        carrierName: japanPostAdapter.name,
        trackingNumber: num,
        status,
        statusText: currentStatusText,
        events,
        trackingUrl,
        postal: postalMeta,
        details: {
          serviceType: s10.valid ? `国際郵便 (${s10.serviceIndicator})` : 'ゆうパック/ゆうパケット/レターパック/書留',
        },
      };
    } catch (err: any) {
      return {
        carrier,
        carrierName: japanPostAdapter.name,
        trackingNumber: num,
        status: 'error',
        statusText: '日本郵便への照会に失敗しました',
        events: [],
        trackingUrl,
        postal: postalMeta,
        error: err?.message || String(err),
      };
    }
  },

  verify(result: TrackingResult, requestedTrackingNumber: string): TrackingVerification {
    return evaluateTrackingVerification(result, requestedTrackingNumber);
  },
};

export const japanpostAdapter = japanPostAdapter;
