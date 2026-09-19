import type {
  CarrierCode,
  TrackingDetectionHints,
  TrackingCarrierAdapter,
  CarrierDetectionSignal,
} from './types.js';
import { cleanTrackingNumber } from './normalization.js';
import { ALL_CARRIER_ADAPTERS } from './registry.js';

export interface RankedCandidate {
  carrier: CarrierCode;
  adapter: TrackingCarrierAdapter;
  score: number;
  strength: 'exclusive' | 'strong' | 'weak';
  reasons: string[];
}

/**
 * 追跡番号を全登録キャリアアダプタでローカル評価し、スコア順にランク付けした候補一覧を返す。
 * ネットワーク呼び出しは一切行わない。
 */
export function detectCandidates(
  trackingNumber: string,
  hints?: TrackingDetectionHints,
): RankedCandidate[] {
  const clean = cleanTrackingNumber(trackingNumber);
  if (!clean) {
    return [];
  }

  const candidates: RankedCandidate[] = [];

  for (const adapter of ALL_CARRIER_ADAPTERS) {
    const signal: CarrierDetectionSignal = adapter.detect(clean, hints);
    if (signal.candidate) {
      // exclusive 判定が出た場合、他社候補を一切受け付けず単一候補として即時確定
      if (signal.strength === 'exclusive') {
        return [
          {
            carrier: adapter.code,
            adapter,
            score: signal.score,
            strength: 'exclusive',
            reasons: signal.reasons,
          },
        ];
      }

      candidates.push({
        carrier: adapter.code,
        adapter,
        score: signal.score,
        strength: signal.strength,
        reasons: signal.reasons,
      });
    }
  }

  // スコア降順でソート（同点の場合は strong > weak）
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const strengthWeight = (s: string) => (s === 'strong' ? 2 : 1);
    return strengthWeight(b.strength) - strengthWeight(a.strength);
  });

  return candidates;
}

/**
 * キャリアコードのみの配列を返す簡易版
 */
export function detectCandidateCarrierCodes(
  trackingNumber: string,
  hints?: TrackingDetectionHints,
): CarrierCode[] {
  return detectCandidates(trackingNumber, hints).map((c) => c.carrier);
}
