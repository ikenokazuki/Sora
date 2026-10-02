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
  if (lower.includes('out for delivery') || lower.includes('on fedex vehicle for delivery') || text.includes('配達中')) return 'in_transit';
  if (lower.includes('in transit') || lower.includes('departed') || lower.includes('arrived') || lower.includes('picked up') || lower.includes('left fedex origin') || text.includes('輸送中')) return 'in_transit';
  if (lower.includes('exception') || lower.includes('delay') || lower.includes('held') || lower.includes('clearance') || text.includes('保留')) return 'in_transit';
  if (lower.includes('return') || text.includes('返送')) return 'returned';
  return 'in_transit';
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let tokenFlightPromise: Promise<string | null> | null = null;

async function getFedExAccessToken(clientId: string, clientSecret: string, signal?: AbortSignal): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  if (tokenFlightPromise) {
    return tokenFlightPromise;
  }

  tokenFlightPromise = (async () => {
    try {
      const res = await fetch('https://apis.fedex.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal,
      });

      if (!res.ok) {
        console.warn(`FedEx OAuth token request failed: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json();
      if (data.access_token) {
        cachedToken = data.access_token;
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
        tokenExpiresAt = Date.now() + expiresIn * 1000;
        return cachedToken;
      }
      return null;
    } catch (err: any) {
      console.warn('FedEx OAuth token exception:', err?.message || String(err));
      return null;
    } finally {
      tokenFlightPromise = null;
    }
  })();

  return tokenFlightPromise;
}

export const fedexAdapter: TrackingCarrierAdapter = {
  code: 'fedex',
  name: 'FedEx',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num || !/^\d+$/.test(num)) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['FedEx requires numeric tracking number'] };
    }

    const len = num.length;
    // 12桁: FedEx Express (国内12桁と形式衝突するため exclusive 禁止、score: 60)
    if (len === 12) {
      let score = 60;
      const reasons = ['Matches FedEx Express 12-digit format'];
      if (hints?.preferredCarriers?.includes('fedex')) {
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

    // 15桁 (Ground), 20桁 (Ground96), 22桁 (SmartPost), 34桁 (Door tag / SSCC-18)
    if (len === 15 || len === 20 || len === 22 || len === 34) {
      let score = 85;
      const reasons = [`Matches FedEx ${len}-digit format`];
      if (hints?.preferredCarriers?.includes('fedex')) {
        score += 15;
        reasons.push('Boosted by preferredCarriers hint');
      }
      return {
        candidate: true,
        score,
        strength: 'strong',
        reasons,
      };
    }

    return { candidate: false, score: 0, strength: 'weak', reasons: ['Does not match FedEx formats'] };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'fedex';
    const trackingUrl = fedexAdapter.trackingUrl(num);

    const clientId = process.env.FEDEX_API_KEY || process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_API_SECRET || process.env.FEDEX_CLIENT_SECRET;

    if (clientId && clientSecret) {
      try {
        const signal = context?.signal || AbortSignal.timeout(10000);
        const accessToken = await getFedExAccessToken(clientId, clientSecret, signal);

        if (accessToken) {
          const trackRes = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              includeDetailedScans: true,
              trackingInfo: [
                {
                  trackingNumberInfo: {
                    trackingNumber: num,
                  },
                },
              ],
            }),
            signal,
          });

          if (trackRes.ok) {
            const data = await trackRes.json();
            const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];

            if (trackResult) {
              const scans = trackResult.scanEvents || [];
              const latestStatusDetail = trackResult.latestStatusDetail;
              const currentStatusText = latestStatusDetail?.description || '配送状況確認済';

              const events: TrackingEvent[] = scans.map((scan: any) => ({
                date: scan.date ? new Date(scan.date).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : undefined,
                status: scan.eventDescription || scan.derivedStatus || '通過',
                location: [scan.scanLocation?.city, scan.scanLocation?.stateOrProvinceCode, scan.scanLocation?.countryCode].filter(Boolean).join(', ') || undefined,
              }));

              const status = determineStatus(currentStatusText);
              return {
                carrier,
                carrierName: fedexAdapter.name,
                trackingNumber: num,
                status,
                statusText: currentStatusText,
                events,
                trackingUrl,
                details: {
                  serviceType: trackResult.serviceDetail?.description || 'FedEx Express/Ground',
                  deliveryDate: trackResult.dateAndTimes?.find((d: any) => d.type === 'ACTUAL_DELIVERY' || d.type === 'ESTIMATED_DELIVERY')?.dateTime,
                },
              };
            }
          }
        }
      } catch (err: any) {
        console.warn('FedEx API call failed, falling back to direct URL guidance:', err?.message || String(err));
      }
    }

    // API未設定またはフォールバック: 公式Web追跡URLとガイダンスを返却
    try {
      const scraped = await scrapeFedexByBrowser(num, trackingUrl, context?.signal);
      if (scraped === 'blocked') {
        return {
          carrier,
          carrierName: fedexAdapter.name,
          trackingNumber: num,
          status: 'unknown',
          statusText: 'FedEx tracking blocked by carrier bot check.',
          events: [],
          trackingUrl,
          details: {
            serviceType: 'FedEx Express/Ground',
          },
        };
      }
      if (scraped) return scraped;
    } catch (err: any) {
      console.warn('FedEx browser tracking failed, falling back to URL guidance:', err?.message || String(err));
    }
    return {
      carrier,
      carrierName: fedexAdapter.name,
      trackingNumber: num,
      status: 'unknown',
      statusText: 'FedEx API credentials are not configured; verify the shipment on the official FedEx tracking page.',
      events: [],
      trackingUrl,
      details: {
        serviceType: 'FedEx Express/Ground',
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

const FEDEX_NOT_FOUND = ["your tracking number can't be found", 'not be in our system yet', 'no results found'];
const FEDEX_READY = [
  /can't be found/i, /no-results/i, /Delivered/i, /Proof of Delivery/i,
  /On FedEx vehicle/i, /Shipment information sent/i, /In transit/i, /Exception/i,
];

function fedexContainsAny(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

export type FedexPageParse =
  | { notFound: true }
  | { challenge: true }
  | { status: TrackingResult['status']; statusText: string; events: TrackingEvent[] }
  | undefined;

/** FedEx追跡ページの描画結果を分類する（純粋関数）。 */
export function parseFedexTrackPage(html: string, finalUrl: string, title: string): FedexPageParse {
  const text = scopedBodyText(html);
  if (looksLikeChallenge(title, text)) return { challenge: true };
  if (finalUrl.includes('no-results-found') || fedexContainsAny(text, FEDEX_NOT_FOUND)) return { notFound: true };
  const status = statusFromText(text);
  if (status === 'unknown') return undefined;
  return {
    status,
    statusText: findStatusHeadline(text) ?? 'FedEx tracking (browser)',
    events: extractDatedEvents(text),
  };
}

/** 資格情報なし時のブラウザ取得。不可時は undefined（案内へフォールバック）。 */
export async function scrapeFedexByBrowser(num: string, trackingUrl: string, signal?: AbortSignal): Promise<TrackingResult | 'blocked' | undefined> {
  const page = await renderTrackingPage(trackingUrl, { signal, timeoutMs: 40000, readyMarkers: FEDEX_READY });
  if (!page) return undefined;
  const parsed = parseFedexTrackPage(page.html, page.finalUrl, page.title);
  if (!parsed) return undefined;
  if ('challenge' in parsed) return 'blocked';
  if ('notFound' in parsed) {
    return {
      carrier: 'fedex', carrierName: fedexAdapter.name, trackingNumber: num,
      status: 'not_found', statusText: 'FedEx: tracking number not found', events: [],
      trackingUrl, details: { serviceType: 'FedEx Express/Ground', retrieval: 'scrape' },
    };
  }
  return {
    carrier: 'fedex', carrierName: fedexAdapter.name, trackingNumber: num,
    status: parsed.status, statusText: parsed.statusText, events: parsed.events,
    trackingUrl, details: { serviceType: 'FedEx Express/Ground', retrieval: 'scrape' },
  };
}
