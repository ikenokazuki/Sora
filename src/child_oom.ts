import { writeFileSync } from 'node:fs';

/**
 * 子プロセスの側で呼ぶ。OOM スコアを最大にする: コンテナのメモリが尽きて、カーネルが何かを殺すとき、本体より先に、この子を選ばせる（書けなくても続ける）。
 * PDF の解析（pdf_child_main.ts）と HTML の変換（html_convert_child_main.ts）の子が使う
 */
export function lowerOomPriority(path = '/proc/self/oom_score_adj'): boolean {
  try {
    writeFileSync(path, '1000');
    return true;
  } catch {
    return false;
  }
}
