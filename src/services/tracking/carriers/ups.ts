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
  if (lower.includes('out for delivery') || text.includes('配達中')) return 'in_transit';
  if (lower.includes('in transit') || lower.includes('on the way') || lower.includes('departed') || lower.includes('arrived') || text.includes('輸送中')) return 'in_transit';
  if (lower.includes('exception') || lower.includes('delay') || lower.includes('held') || text.includes('保留')) return 'in_transit';
  if (lower.includes('return') || text.includes('返送')) return 'returned';
  return 'in_transit';
}

export const upsAdapter: TrackingCarrierAdapter = {
  code: 'ups',
  name: 'UPS',

  trackingUrl(trackingNumber: string): string {
    const num = cleanTrackingNumber(trackingNumber);
    return `https://www.ups.com/track?loc=ja_JP&tracknum=${encodeURIComponent(num)}`;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    // 1Zで始まる18桁英数字は UPS 独自の形式（唯一の exclusive 対象）
    if (/^1Z[0-9A-Z]{16}$/i.test(num)) {
      return {
        candidate: true,
        score: 100,
        strength: 'exclusive',
        reasons: ['UPS 1Z exclusive tracking format'],
      };
    }

    // 9桁〜12桁の数字またはTで始まる形式等（形式衝突の可能性があるため exclusive 禁止）
    if (/^T\d{10}$/i.test(num) || /^\d{9,12}$/.test(num)) {
      let score = 50;
      const reasons = ['UPS alternate format'];
      if (hints?.preferredCarriers?.includes('ups')) {
        score += 15;
        reasons.push('Boosted by preferredCarriers hint');
      }
      return {
        candidate: true,
        score,
        strength: 'weak',
        reasons,
      };
    }

    return { candidate: false, score: 0, strength: 'weak', reasons: ['Does not match UPS formats'] };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const carrier = 'ups';
    const trackingUrl = upsAdapter.trackingUrl(num);

    const clientId = process.env.UPS_CLIENT_ID;
    const clientSecret = process.env.UPS_CLIENT_SECRET;

    if (clientId && clientSecret) {
      try {
        const signal = context?.signal || AbortSignal.timeout(10000);
        // 1. OAuth トークン取得
        const tokenRes = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          },
          body: 'grant_type=client_credentials',
          signal,
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
            signal,
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

            const status = determineStatus(currentStatus);
            return {
              carrier,
              carrierName: upsAdapter.name,
              trackingNumber: num,
              status,
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
        console.warn('UPS API call failed, falling back to direct URL guidance:', err?.message || String(err));
      }
    }

    // API未設定またはフォールバック: 公式Web追跡URLとガイダンスを返却
    return {
      carrier,
      carrierName: upsAdapter.name,
      trackingNumber: num,
      status: 'unknown',
      statusText: 'UPS API credentials are not configured; verify the shipment on the official UPS tracking page.',
      events: [],
      trackingUrl,
      details: {
        serviceType: 'UPS International',
      },
    };
  },

  verify(result: TrackingResult, requestedTrackingNumber: string): TrackingVerification {
    return evaluateTrackingVerification(result, requestedTrackingNumber);
  },
};
