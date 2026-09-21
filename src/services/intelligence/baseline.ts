import type { ObservationOrigin } from './types.js';

export interface BaselineDeviationOptions {
  minSamples?: number;
  origin?: ObservationOrigin;
}

export interface BaselineDeviation {
  median?: number;
  mad?: number;
  sampleCount: number;
  origin?: ObservationOrigin;
  anomalyZ?: number;
  /** 全 sample が 0 で current が非0。偽の z-score を作らず記述的状態に委ねる。 */
  zeroBaseline?: boolean;
  insufficient?: boolean;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

/** Robust deviation (modified z-score: 0.6745 * (current - median) / MAD)。 */
export function computeBaselineDeviation(
  current: number,
  samples: readonly number[],
  options: BaselineDeviationOptions = {},
): BaselineDeviation {
  const eligible = samples.filter(Number.isFinite);
  // 素関数の床は小さく保つ。本番経路は MetricDefinition.minBaselineSamples (原則14) を渡す。
  const minSamples = options.minSamples ?? 3;
  if (eligible.length < minSamples) {
    return { sampleCount: eligible.length, origin: options.origin, insufficient: true };
  }
  const center = median(eligible);
  const mad = median(eligible.map((sample) => Math.abs(sample - center)));
  if (mad === 0) {
    if (current === center) {
      return { median: center, mad: 0, sampleCount: eligible.length, origin: options.origin, anomalyZ: 0 };
    }
    // MAD=0 で epsilon 除算して最大 z-score を作らない。
    return { median: center, mad: 0, sampleCount: eligible.length, origin: options.origin, zeroBaseline: center === 0 || undefined };
  }
  return {
    median: center,
    mad,
    sampleCount: eligible.length,
    origin: options.origin,
    anomalyZ: (0.6745 * (current - center)) / mad,
  };
}
