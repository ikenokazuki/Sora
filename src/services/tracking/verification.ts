import type { TrackingResult, TrackingVerification } from './types.js';
import { cleanTrackingNumber } from './normalization.js';

/**
 * 追跡結果に対する検証レベルを判定
 * 
 * strong:
 *   - 要求番号と結果番号が一致
 *   - 実際の配送イベント履歴(events.length > 0)が存在、または配送詳細(details)が存在
 *   - not_found / error / unknown ではない
 * 
 * weak:
 *   - ステータスはあるがイベントや詳細がなく、公式URLだけが存在する状態
 * 
 * none:
 *   - not_found または error
 *   - 番号不一致
 *   - URL-only fallback (credentialなし時等)
 */
export function evaluateTrackingVerification(
  result: TrackingResult,
  requestedTrackingNumber: string,
): TrackingVerification {
  const reqNum = cleanTrackingNumber(requestedTrackingNumber);
  const resNum = cleanTrackingNumber(result.trackingNumber);

  const reasons: string[] = [];

  // 1. 番号一致チェック
  if (reqNum && resNum && reqNum !== resNum) {
    reasons.push(`Tracking number mismatch (requested: ${reqNum}, returned: ${resNum})`);
    return { level: 'none', reasons };
  }

  // 2. not_found または error は none
  if (result.status === 'not_found' || result.status === 'error') {
    reasons.push(`Status indicates failure or not found (${result.status})`);
    return { level: 'none', reasons };
  }

  // 3. events または details による shipment-specific evidence の検証
  const hasEvents = Array.isArray(result.events) && result.events.length > 0;
  const hasDetails = Boolean(
    result.details &&
      (result.details.origin ||
        result.details.destination ||
        result.details.deliveryDate ||
        result.details.serviceType),
  );

  if (hasEvents || hasDetails) {
    // 確実な配送実績が存在
    if (result.status === 'delivered' || result.status === 'in_transit' || result.status === 'returned') {
      reasons.push(`Active shipment with ${result.events?.length || 0} events and verified status '${result.status}'`);
      return { level: 'strong', reasons };
    }

    if (result.status === 'registered') {
      // registered はイベントが実在していれば strong、イベントなしなら weak
      if (hasEvents) {
        reasons.push(`Registered shipment confirmed with timeline events`);
        return { level: 'strong', reasons };
      }
      reasons.push(`Registered status without event records`);
      return { level: 'weak', reasons };
    }
  }

  // URL-only fallback や unknown
  if (result.status === 'unknown') {
    reasons.push(`Unknown status or URL-only fallback without shipment events`);
    return { level: 'none', reasons };
  }

  reasons.push(`Status is '${result.status}' but lacks concrete event evidence`);
  return { level: 'weak', reasons };
}
