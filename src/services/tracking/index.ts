import type {
  CarrierCode,
  TrackingRequest,
  TrackingResult,
  TrackingVerification,
} from './types.js';
import { cleanTrackingNumber } from './normalization.js';
import {
  ALL_CARRIER_ADAPTERS,
  getCarrierAdapter,
  getCarrierName,
  getCarrierTrackingUrl,
} from './registry.js';
import { detectCandidates, type RankedCandidate } from './detector.js';
import { getFromCache, setToCache } from '../../cache.js';

export const TRACKING_CACHE_TTL = 300; // 5分
export const TRACKING_DELIVERED_CACHE_TTL = 86400; // 配達完了は24時間
const MAX_CONCURRENT_PER_WAVE = 2;
const MAX_TOTAL_VERIFICATION_ATTEMPTS = 4;

export * from './types.js';
export * from './normalization.js';
export * from './postal.js';
export * from './verification.js';
export * from './registry.js';
export * from './detector.js';

/**
 * 指定キャリアによる直接照会（明示指定時）
 * 他社への投機的リクエストは一切行わない。
 */
export async function trackByCarrier(
  carrier: CarrierCode,
  trackingNumber: string,
  context?: { signal?: AbortSignal; noCache?: boolean },
): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  const adapter = getCarrierAdapter(carrier);
  if (!adapter) {
    throw new Error(`Unsupported carrier: ${carrier}`);
  }

  const result = await adapter.track(num, context);
  const verification = adapter.verify(result, num);
  return {
    ...result,
    verification,
    resolvedCarrier: {
      code: carrier,
      name: adapter.name,
      confidence: 'exclusive',
      verification: verification.level,
      method: 'explicit',
    },
  };
}

/**
 * 自動判別・バウンド検証追跡 (Ranked Local Detection + Bounded Wave Verification)
 * 
 * 原則: Detect locally. Verify narrowly. Never guess.
 * 最速応答は勝者ではない。確実な配送エビデンス（verification.level === 'strong'）を満たす社のみ採用。
 */
export async function trackPackageAuto(
  trackingNumber: string,
  hints?: {
    preferredCarriers?: CarrierCode[];
    originCountry?: string;
    destinationCountry?: string;
    signal?: AbortSignal;
    noCache?: boolean;
    verbose?: boolean;
    candidatesOverride?: RankedCandidate[];
  },
): Promise<TrackingResult> {
  const num = cleanTrackingNumber(trackingNumber);
  if (!num) {
    throw new Error('追跡番号を入力してください');
  }

  const candidates: RankedCandidate[] = hints?.candidatesOverride || detectCandidates(num, hints);
  if (candidates.length === 0) {
    return {
      carrier: 'unknown',
      carrierName: '不明',
      trackingNumber: num,
      status: 'not_found',
      statusText: '該当する配送会社を特定できませんでした',
      events: [],
      trackingUrl: `https://www.google.com/search?q=${encodeURIComponent(num)}`,
      verification: { level: 'none', reasons: ['No carrier candidate matched tracking number format'] },
    };
  }

  // Exclusive な候補（UPS 1Z 等）は単体実行
  if (candidates[0].strength === 'exclusive') {
    const winnerCandidate = candidates[0];
    const res = await winnerCandidate.adapter.track(num, { signal: hints?.signal });
    const verification = winnerCandidate.adapter.verify(res, num);
    return {
      ...res,
      verification,
      resolvedCarrier: {
        code: winnerCandidate.carrier,
        name: winnerCandidate.adapter.name,
        confidence: 'exclusive',
        verification: verification.level,
        method: 'format_rule',
      },
    };
  }

  // Bounded Verification（Wave 制）: 上位最大 4 候補を 2 件ずつ実行
  const targetCandidates = candidates.slice(0, MAX_TOTAL_VERIFICATION_ATTEMPTS);
  const strongResults: Array<{ candidate: RankedCandidate; result: TrackingResult; verification: TrackingVerification }> = [];
  const allAttemptedResults: Array<{ candidate: RankedCandidate; result: TrackingResult; verification: TrackingVerification }> = [];

  for (let i = 0; i < targetCandidates.length; i += MAX_CONCURRENT_PER_WAVE) {
    const waveCandidates = targetCandidates.slice(i, i + MAX_CONCURRENT_PER_WAVE);

    // Wave 内を並行実行
    const wavePromises = waveCandidates.map(async (cand) => {
      try {
        const res = await cand.adapter.track(num, { signal: hints?.signal });
        const verification = cand.adapter.verify(res, num);
        return {
          candidate: cand,
          result: { ...res, verification },
          verification,
        };
      } catch (err: any) {
        const errorResult: TrackingResult = {
          carrier: cand.carrier,
          carrierName: cand.adapter.name,
          trackingNumber: num,
          status: 'error',
          statusText: err?.message || '照会エラー',
          events: [],
          trackingUrl: cand.adapter.trackingUrl(num),
          error: err?.message || String(err),
        };
        const verification = cand.adapter.verify(errorResult, num);
        return {
          candidate: cand,
          result: { ...errorResult, verification },
          verification,
        };
      }
    });

    const waveResults = await Promise.all(wavePromises);
    for (const wr of waveResults) {
      allAttemptedResults.push(wr);
      if (wr.verification.level === 'strong') {
        strongResults.push(wr);
      }
    }

    // 少なくとも1つの strong が得られた場合、後続 Wave は実行しない（早期終了）
    if (strongResults.length > 0) {
      break;
    }
  }

  // 1. Multiple Strong Conflict（同一追跡番号で複数社が配送実績を主張した場合）
  if (strongResults.length > 1) {
    const carrierNames = strongResults.map((s) => s.candidate.adapter.name).join(', ');
    const primary = strongResults[0];
    return {
      carrier: 'unknown',
      carrierName: '複数候補（競合）',
      trackingNumber: num,
      status: 'unknown',
      statusText: `複数の配送会社（${carrierNames}）で該当する荷物情報が確認されました。配送会社を明示して照会してください。`,
      events: primary.result.events,
      trackingUrl: primary.result.trackingUrl,
      verification: {
        level: 'weak',
        reasons: [`Multiple carriers returned strong verified results: ${carrierNames}`],
      },
      resolvedCarrier: {
        code: 'unknown',
        name: '複数候補（競合）',
        confidence: 'weak',
        verification: 'weak',
        method: 'ambiguous_conflict',
      },
    };
  }

  // 2. 単一の Strong Winner
  if (strongResults.length === 1) {
    const winner = strongResults[0];
    return {
      ...winner.result,
      resolvedCarrier: {
        code: winner.candidate.carrier,
        name: winner.candidate.adapter.name,
        confidence: 'strong',
        verification: 'strong',
        method: 'network_verified',
      },
    };
  }

  // 3. 検証成功キャリアなし（URL-only は auto winner になれない）
  const primaryCandidate = candidates[0];
  const attemptedNames = targetCandidates.map((c) => c.adapter.name).join(', ');
  return {
    carrier: primaryCandidate.carrier,
    carrierName: primaryCandidate.adapter.name,
    trackingNumber: num,
    status: 'not_found',
    statusText: `該当するお荷物情報が見つかりませんでした (照会対象: ${attemptedNames})`,
    events: [],
    trackingUrl: primaryCandidate.adapter.trackingUrl(num),
    verification: {
      level: 'none',
      reasons: ['No carrier returned strong verified shipment evidence'],
    },
    resolvedCarrier: {
      code: primaryCandidate.carrier,
      name: primaryCandidate.adapter.name,
      confidence: 'weak',
      verification: 'none',
      method: 'unverified_fallback',
    },
  };
}

/**
 * 統合エントリーポイント（キャッシュ付き）
 */
export async function trackPackage(req: TrackingRequest): Promise<TrackingResult> {
  const num = cleanTrackingNumber(req.trackingNumber);
  if (!num) {
    throw new Error('追跡番号を入力してください');
  }

  const isAuto = !req.carrier || req.carrier === 'auto';
  const carrierKey = isAuto ? 'auto' : req.carrier;
  const cacheKey = `tracking:v2:${carrierKey}:${num}`;

  if (!req.noCache) {
    const cached = getFromCache<TrackingResult>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  let result: TrackingResult;
  if (isAuto) {
    result = await trackPackageAuto(num, {
      preferredCarriers: req.preferredCarriers,
      originCountry: req.originCountry,
      destinationCountry: req.destinationCountry,
      noCache: req.noCache,
      verbose: req.verbose,
    });
  } else {
    result = await trackByCarrier(req.carrier as CarrierCode, num, {
      noCache: req.noCache,
    });
  }

  result.fetchedAt = new Date().toISOString();

  // キャッシュ保存
  if (!req.noCache && result.status !== 'error') {
    const ttl = result.status === 'delivered' ? TRACKING_DELIVERED_CACHE_TTL : TRACKING_CACHE_TTL;
    setToCache(cacheKey, result, ttl);
  }

  return result;
}
