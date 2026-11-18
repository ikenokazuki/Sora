/**
 * tenant ごとのブラウザのプロセスに渡す、番号（uid の池の位置）の割り当て（設計 2。段階 6）。
 * 番号は 0 以上 max 未満で、プロセスごとに別。uid は「基準の uid + 番号」になるので、同時に動くプロセスどうしが、同じ uid を持たない。
 * 番号を手放すのは、そのプロセスが完全に終わってから（終わる前に別の tenant に渡すと、2 つの tenant のプロセスが同じ uid で並ぶ）。
 */
export class BrowserSlots {
  private readonly entries = new Map<string, { index: number; lastUse: number }>();

  /** max: 番号の数の上限（呼ぶたびに読む。水準の切り替えで変わりうる）。now: 時刻（テスト用） */
  constructor(
    private readonly max: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** key の番号。無ければ undefined */
  indexOf(key: string): number | undefined {
    return this.entries.get(key)?.index;
  }

  /** key に番号を渡す（すでにあれば、その番号と、使った時刻の更新）。空きが無ければ undefined。渡すのは、使っていない最小の、max 未満の番号 */
  allocate(key: string): number | undefined {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUse = this.now();
      return existing.index;
    }
    const used = new Set([...this.entries.values()].map((entry) => entry.index));
    const limit = this.max();
    for (let index = 0; index < limit; index++) {
      if (used.has(index)) continue;
      this.entries.set(key, { index, lastUse: this.now() });
      return index;
    }
    return undefined;
  }

  /** key を使った時刻を、いまにする */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUse = this.now();
  }

  /** key の番号を手放す（無ければ何もしない） */
  release(key: string): void {
    this.entries.delete(key);
  }

  /** 閉じる候補: 最も長く使われていない順の key */
  candidates(): string[] {
    return [...this.entries.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse).map(([key]) => key);
  }
}
