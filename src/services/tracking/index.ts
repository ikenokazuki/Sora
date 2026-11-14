import type {
  CarrierCode,
  TrackingContext,
  TrackingRequest,
  TrackingResult,
  TrackingVerification,
} from './types.js';
import { cleanTrackingNumber } from './normalization.js';
import { getCarrierAdapter } from './registry.js';
import { detectCandidates, type RankedCandidate } from './detector.js';
import { getFromCache, setToCache } from '../../cache.js';
import { errorMessage } from '../../errors.js';
import { trackingPageUrl } from './page.js';

export const TRACKING_CACHE_TTL = 5 * 60 * 1000; // 5分
export const TRACKING_DELIVERED_CACHE_TTL = 24 * 60 * 60 * 1000; // 配達完了は24時間
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
  context?: TrackingContext,
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
    signal?: AbortSignal;
    noCache?: boolean;
    candidatesOverride?: RankedCandidate[];
    /** ブラウザの枠を数える利用者（carrier の照会に渡す） */
    tenantId?: string;
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
    const res = await winnerCandidate.adapter.track(num, { signal: hints?.signal, tenantId: hints?.tenantId });
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
        const res = await cand.adapter.track(num, { signal: hints?.signal, tenantId: hints?.tenantId });
        const verification = cand.adapter.verify(res, num);
        return {
          candidate: cand,
          result: { ...res, verification },
          verification,
        };
      } catch (err) {
        const errorResult: TrackingResult = {
          carrier: cand.carrier,
          carrierName: cand.adapter.name,
          trackingNumber: num,
          status: 'error',
          statusText: errorMessage(err) || '照会エラー',
          events: [],
          trackingUrl: cand.adapter.trackingUrl(num),
          error: errorMessage(err) || String(err),
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
  // 照会に失敗した会社があれば、「見つからなかった」とは言えない（その会社には荷物があるかもしれない）。error はキャッシュしない。
  // 「該当なし」と答えた会社だけなら not_found。例外も、会社のアダプターが error を返したものも失敗として数える
  const failed = allAttemptedResults.filter((a) => a.result.status === 'error');
  if (failed.length > 0) {
    const first = failed[0];
    const failedNames = failed.map((f) => f.candidate.adapter.name).join(', ');
    return {
      carrier: first.candidate.carrier,
      carrierName: first.candidate.adapter.name,
      trackingNumber: num,
      status: 'error',
      statusText: `照会できなかった配送会社があるため、荷物の有無は確認できませんでした (照会できなかった会社: ${failedNames})`,
      events: [],
      trackingUrl: first.candidate.adapter.trackingUrl(num),
      error: failed.map((f) => `${f.candidate.adapter.name}: ${f.result.error || f.result.statusText}`).join('; '),
      verification: {
        level: 'none',
        reasons: [`Carrier lookup failed (${failedNames}); no carrier returned strong verified shipment evidence`],
      },
      resolvedCarrier: {
        code: first.candidate.carrier,
        name: first.candidate.adapter.name,
        confidence: 'weak',
        verification: 'none',
        method: 'unverified_fallback',
      },
    };
  }

  const primaryCandidate = candidates[0];
  const attemptedNames = targetCandidates.map((c) => c.adapter.name).join(', ');
  // 公式ページの URL だけを返した会社（unknown。資格情報なし、ブラウザで読めなかった UPS・FedEx・DHL など）は、実際には確かめていない。not_found のままにするが、名前を挙げる
  const unchecked = allAttemptedResults.filter((a) => a.result.status === 'unknown').map((a) => a.candidate.adapter.name);
  const uncheckedNote = unchecked.length > 0 ? `、確認できなかった会社: ${unchecked.join(', ')}` : '';
  return {
    carrier: primaryCandidate.carrier,
    carrierName: primaryCandidate.adapter.name,
    trackingNumber: num,
    status: 'not_found',
    statusText: `該当するお荷物情報が見つかりませんでした (照会対象: ${attemptedNames}${uncheckedNote})`,
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
 * 追跡結果のキャッシュキー。自動判別の結果は、判別に渡すヒント（優先キャリア）で変わる。
 * キャリアを明示した照会はヒントを使わないので、キーに入れない。
 */
export function trackingCacheKey(req: Pick<TrackingRequest, 'carrier' | 'preferredCarriers'>, num: string): string {
  if (req.carrier && req.carrier !== 'auto') return `tracking:v3:${req.carrier}:${num}`;
  const preferred = [...new Set(req.preferredCarriers ?? [])].sort();
  // v4: 自動判別で失敗した会社があるとき、v3 は not_found をキャッシュしていた
  if (preferred.length === 0) return `tracking:v4:auto:${num}`;
  return `tracking:v4:auto:${num}:${preferred.join(',')}`;
}

/**
 * 統合エントリーポイント（キャッシュ付き）
 */
export async function trackPackage(req: TrackingRequest, context: { tenantId?: string } = {}): Promise<TrackingResult> {
  const num = cleanTrackingNumber(req.trackingNumber);
  if (!num) {
    throw new Error('追跡番号を入力してください');
  }

  const isAuto = !req.carrier || req.carrier === 'auto';
  const cacheKey = trackingCacheKey(req, num);

  if (!req.noCache) {
    const cached = getFromCache<TrackingResult>(cacheKey);
    if (cached) {
      return withPageUrl(cached);
    }
  }

  let result: TrackingResult;
  if (isAuto) {
    result = await trackPackageAuto(num, {
      preferredCarriers: req.preferredCarriers,
      noCache: req.noCache,
      tenantId: context.tenantId,
    });
  } else {
    result = await trackByCarrier(req.carrier as CarrierCode, num, {
      noCache: req.noCache,
      tenantId: context.tenantId,
    });
  }

  result.fetchedAt = new Date().toISOString();

  // キャッシュ保存
  if (!req.noCache && result.status !== 'error') {
    const ttl = result.status === 'delivered' ? TRACKING_DELIVERED_CACHE_TTL : TRACKING_CACHE_TTL;
    setToCache(cacheKey, result, ttl);
  }

  return withPageUrl(result);
}

/** Sora の表示ページの URL を足す（設定したときだけ）。キャッシュには入れないので、設定を変えると次の応答から変わる。 */
function withPageUrl(result: TrackingResult): TrackingResult {
  const pageUrl = result.carrier === 'unknown' ? undefined : trackingPageUrl(result.carrier, result.trackingNumber);
  return pageUrl ? { ...result, pageUrl } : result;
}
