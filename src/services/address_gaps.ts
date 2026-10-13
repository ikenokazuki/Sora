import { AddressPendingError, AddressUnavailableError } from './address_errors.js';

export interface UnavailableItem {
  artifact: string;
  message: string;
}

/** 待ち時間までにデータが揃わず、取れている範囲で答えたことを表す共通の項目。 */
export interface Incomplete {
  incomplete?: true;
  pending?: string[];
  unavailable?: UnavailableItem[];
}

/** 待ち時間までに揃わなかったデータと、取得に失敗したデータを集める。 */
export class Gaps {
  private readonly pending = new Set<string>();
  private readonly unavailable = new Map<string, string>();

  add(info: Incomplete): void {
    for (const id of info.pending ?? []) this.pending.add(id);
    for (const item of info.unavailable ?? []) this.unavailable.set(item.artifact, item.message);
  }

  /** データの取得に絡む例外なら記録して続行し、それ以外は投げ直す。 */
  absorb(error: unknown): void {
    if (error instanceof AddressPendingError) this.pending.add(error.pending);
    else if (error instanceof AddressUnavailableError && error.artifact) this.unavailable.set(error.artifact, error.message);
    else throw error;
  }

  result(): Incomplete {
    if (this.pending.size === 0 && this.unavailable.size === 0) return {};
    const out: Incomplete = { incomplete: true };
    if (this.pending.size > 0) out.pending = [...this.pending];
    if (this.unavailable.size > 0) out.unavailable = [...this.unavailable].map(([artifact, message]) => ({ artifact, message }));
    return out;
  }
}
