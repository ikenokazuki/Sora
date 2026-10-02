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

function determineStatus(text: string): TrackingResult['status'] {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (lower.includes('delivered') || text.includes('配達完了') || text.includes('お届け完了')) return 'delivered';
  if (lower.includes('delivery') || lower.includes('with delivery courier') || text.includes('配達中')) return 'in_transit';
  if (lower.includes('transit') || lower.includes('departed') || lower.includes('arrived') || lower.includes('processed') || text.includes('輸送中')) return 'in_transit';
  if (lower.includes('exception') || lower.includes('delay') || lower.includes('held') || lower.includes('clearance') || text.includes('保留')) return 'in_transit';
  if (lower.includes('return') || text.includes('返送')) return 'returned';
  return 'in_transit';
}

export const dhlAdapter: TrackingCarrierAdapter = {
  code: 'dhl',
  name: 'DHL Express',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://www.dhl.com/us-en/home/tracking.html?submit=1&tracking-id=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num || !/^\d+$/.test(num)) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['DHL Express requires numeric tracking number'] };
    }

    const len = num.length;
    // 10桁 (Waybill / AWB) または 11桁
    // 西濃や佐川の10桁と形式衝突するため exclusive 禁止
    if (len === 10 || len === 11) {
      let score = len === 10 ? 60 : 55;
      const reasons = [`Matches DHL Express ${len}-digit format`];
      if (hints?.preferredCarriers?.includes('dhl')) {
        score += 20;
        reasons.push('Boosted by preferredCarriers hint');
      }
      return {
        candidate: true,
        score,
        strength: 'strong',
        reasons,
      };
    }

    return { candidate: false, score: 0, strength: 'weak', reasons: ['Does not match DHL Express formats'] };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'dhl';
    const trackingUrl = dhlAdapter.trackingUrl(num);

    const apiKey = process.env.DHL_EXPRESS_API_KEY || process.env.DHL_API_KEY;

    if (apiKey) {
      try {
        const signal = context?.signal || AbortSignal.timeout(10000);
        const res = await fetch(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(num)}`, {
          headers: {
            'DHL-API-Key': apiKey,
            Accept: 'application/json',
          },
          signal,
        });

        if (res.ok) {
          const data = await res.json();
          const shipment = data?.shipments?.[0];

          if (shipment) {
            const rawEvents = shipment.events || [];
            const currentStatusText = shipment.status?.description || shipment.status?.statusCode || '配送状況確認済';

            const events: TrackingEvent[] = rawEvents.map((evt: any) => ({
              date: evt.timestamp ? new Date(evt.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : undefined,
              status: evt.description || evt.statusCode || '通過',
              location: [evt.location?.address?.addressLocality, evt.location?.address?.countryCode].filter(Boolean).join(', ') || undefined,
            }));

            const status = determineStatus(currentStatusText);
            return {
              carrier,
              carrierName: dhlAdapter.name,
              trackingNumber: num,
              status,
              statusText: currentStatusText,
              events,
              trackingUrl,
              details: {
                serviceType: shipment.service || 'DHL Express',
                deliveryDate: shipment.estimatedTimeOfDelivery,
              },
            };
          }
        }
      } catch (err: any) {
        console.warn('DHL Express API call failed, falling back to direct URL guidance:', err?.message || String(err));
      }
    }

    // API未設定またはフォールバック: 公式Web追跡URLとガイダンスを返却
    try {
      const scraped = await scrapeDhlByBrowser(num, trackingUrl, context?.signal);
      if (scraped === 'blocked') {
        return {
          carrier,
          carrierName: dhlAdapter.name,
          trackingNumber: num,
          status: 'unknown',
          statusText: 'DHL tracking blocked by carrier bot check.',
          events: [],
          trackingUrl,
          details: {
            serviceType: 'DHL Express',
          },
        };
      }
      if (scraped) return scraped;
    } catch (err: any) {
      console.warn('DHL browser tracking failed, falling back to URL guidance:', err?.message || String(err));
    }
    return {
      carrier,
      carrierName: dhlAdapter.name,
      trackingNumber: num,
      status: 'unknown',
      statusText: 'DHL Express API credentials are not configured; verify the shipment on the official DHL tracking page.',
      events: [],
      trackingUrl,
      details: {
        serviceType: 'DHL Express',
      },
    };
  },

  verify(result: TrackingResult, requestedTrackingNumber: string): TrackingVerification {
    return evaluateTrackingVerification(result, requestedTrackingNumber);
  },
};
import {
  extractDatedEvents,
  findStatusHeadline,
  looksLikeChallenge,
  renderTrackingPage,
  scopedBodyText,
  statusFromText,
} from './browser_track.js';

const DHL_POSITIVE = /delivered|in transit|trouble|held|exception|配達完了|配達中/i;
const DHL_NO_RESULT = /no results?|shipment .* not found|not found/i;
const DHL_READY = [
  /DELIVERED/i, /IN TRANSIT/i, /TROUBLE/i, /no result/i, /Track & Trace/i,
];

export type DhlPageParse =
  | { notFound: true }
  | { challenge: true }
  | { status: TrackingResult['status']; statusText: string; events: TrackingEvent[] }
  | undefined;

/** DHL追跡ページの描画結果を分類する（純粋関数）。未観測の否定形は unknown に留める。 */
export function parseDhlTrackPage(html: string, title: string): DhlPageParse {
  const text = scopedBodyText(html);
  if (looksLikeChallenge(title, text)) return { challenge: true };
  const status = statusFromText(text);
  if (status !== 'unknown') {
    return {
      status,
      statusText: findStatusHeadline(text) ?? 'DHL tracking (browser)',
      events: extractDatedEvents(text),
    };
  }
  if (DHL_NO_RESULT.test(text) && !DHL_POSITIVE.test(text)) return { notFound: true };
  return undefined;
}

/** 資格情報なし時のブラウザ取得。不可時は undefined（案内へフォールバック）。 */
export async function scrapeDhlByBrowser(num: string, trackingUrl: string, signal?: AbortSignal): Promise<TrackingResult | 'blocked' | undefined> {
  const page = await renderTrackingPage(trackingUrl, { signal, timeoutMs: 25000, readyMarkers: DHL_READY });
  if (!page) return undefined;
  const parsed = parseDhlTrackPage(page.html, page.title);
  if (!parsed) return undefined;
  if ('challenge' in parsed) return 'blocked';
  if ('notFound' in parsed) {
    return {
      carrier: 'dhl', carrierName: dhlAdapter.name, trackingNumber: num,
      status: 'not_found', statusText: 'DHL: tracking number not found', events: [],
      trackingUrl, details: { serviceType: 'DHL Express', retrieval: 'scrape' },
    };
  }
  return {
    carrier: 'dhl', carrierName: dhlAdapter.name, trackingNumber: num,
    status: parsed.status, statusText: parsed.statusText, events: parsed.events,
    trackingUrl, details: { serviceType: 'DHL Express', retrieval: 'scrape' },
  };
}
