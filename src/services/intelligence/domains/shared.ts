import type { CoverageReport } from '../../country_intel/types.js';
import type { IntelligenceSignal } from '../types.js';

export interface DomainViewInput {
  regionId: string;
  signals: readonly IntelligenceSignal[];
  coverage: CoverageReport;
}

export interface DomainViewBase {
  regionId: string;
  coverage: CoverageReport;
}

/** 指定 key 群の signal だけを薄く並べ替える。未知 key は無理に分類しない。 */
export function pick(signals: readonly IntelligenceSignal[], keys: readonly string[]): IntelligenceSignal[] {
  const wanted = new Set(keys);
  return signals.filter((signal) => wanted.has(signal.key));
}
