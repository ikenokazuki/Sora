/**
 * tenant ごとのブラウザの uid に、プロセスが残っていないことの確認（設計 2。段階 6）。
 * 番号（= uid）を別の tenant に渡す前に、その uid のプロセスを、/proc から探して終わらせる。
 * 起動に失敗した Chromium（puppeteer の後始末は、少しあとに終わる）や、強制終了で残った子孫のプロセスは、
 * 起動した子プロセスの追跡では分からないが、uid で探せば分かる。root で動き、別の uid に落としているとき（CAP_KILL がある）だけ使う。
 */
import { readdirSync, readFileSync } from 'node:fs';

export interface ReapOptions {
  /** /proc の場所（テスト用） */
  procDir?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** この時間までに、いなくならなければ、false（ミリ秒。既定 3000） */
  timeoutMs?: number;
}

/**
 * /proc/<pid>/status の中身が、本当のゾンビ（もう動いていない。親が回収していないだけ）か。
 * 主スレッドだけが終わり、ほかのスレッドが動いているプロセスも、State は Z（ゾンビ）になる（Threads が 2 以上）。それは動いているので、ゾンビとしない。
 * Threads の行が無ければ 1 とみなす。イメージの確認の台本（pdf-uid-check・rs-uid-check）も使う
 */
export function isFinishedZombie(status: string): boolean {
  return /^State:\s*Z/m.test(status) && Number(/^Threads:\s*(\d+)/m.exec(status)?.[1] ?? 1) <= 1;
}

/**
 * /proc/<pid>/status の Uid の行（実・実効・保存・fs の uid）のどれかが uid で、本当のゾンビでないプロセスの pid
 * （主スレッドだけが終わったプロセスも返す。SIGKILL は、スレッドの全部を止める）
 */
export function pidsOfUid(uid: number, procDir = '/proc'): number[] {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`${procDir}/${name}/status`, 'utf8');
      if (isFinishedZombie(status)) continue;
      const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
      if (ids && (Number(ids[1]) === uid || Number(ids[2]) === uid)) found.push(Number(name));
    } catch {
      // 途中で消えたプロセス
    }
  }
  return found;
}

/**
 * uid のプロセスに SIGKILL を送り、いなくなるまで確かめる。いなくなったら true、時間の上限までに残っていれば false。
 * root（0）・自分自身の uid・不正な uid には、何もしない（false。自分や root のプロセスを撃たない）
 */
export async function reapUid(uid: number, options: ReapOptions = {}): Promise<boolean> {
  const own = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!Number.isInteger(uid) || uid <= 0 || uid === own) return false;
  const procDir = options.procDir ?? '/proc';
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 3000);
  for (;;) {
    const pids = pidsOfUid(uid, procDir).filter((pid) => pid !== process.pid && pid > 1);
    if (pids.length === 0) return true;
    for (const pid of pids) {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        // すでに終わった・権限が無い。確かめは続ける
      }
    }
    if (now() >= deadline) return false;
    await sleep(20);
  }
}
