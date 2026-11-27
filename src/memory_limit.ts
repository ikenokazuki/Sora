import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/** cgroup (v2/v1) のメモリ上限と搭載メモリの小さい方。取得できなければ undefined。ブラウザの同時数（browser_engine.ts）と、HTML の変換の子（html_convert.ts）が使う */
export function detectMemoryLimitBytes(): number | undefined {
  let limit = totalmem() || undefined;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(readFileSync(path, 'utf8').trim());
      if (Number.isFinite(n) && n > 0) limit = limit === undefined ? n : Math.min(limit, n);
    } catch {}
  }
  return limit;
}
