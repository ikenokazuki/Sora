/**
 * 本文の抽出（rs-trafilatura。rs_trafilatura.ts）の別プロセスを、Sora 本体（root）とも Chromium とも PDF の解析とも別の uid に落として動かす
 * （設計 2 の続き）。信頼できない HTML を読むので、破られたときに、運用者の秘密と、ほかの利用者に届かないようにする。共通の部品は child_uid.ts。
 *
 * uid: 抽出は、取得のたびに動き、同時に動く数に上限が無い（crawl・search_deep・複数の利用者）。1 件に 1 つ、別の uid を、広い範囲
 * （基準から RS_UID_COUNT 個。既定は 64000〜64255）から渡す。空きが無いとき・strict で落とせないときは、rs-trafilatura を使わない
 * （呼び出し側は、Readability の経路に戻る。root のままでは動かさない）。
 */
import { browserUidRange } from '../browser_launch_plan.js';
import { ChildDropError, childDropProbe, ChildUidPool, type ChildUidLease, childUidRange, type ChildUidSpec, droppedChild, planChildDrop, type UidRange, warnChildOnce } from '../child_uid.js';
import type { Env } from '../config.js';
import { pdfUidRange } from '../pdf_uid.js';
import { isolationLevel, strictBrowserProcessMax } from '../security/limits.js';
import { incrementSecurityCounter } from '../security/metrics.js';

/** 落とし先の uid の基準の既定 */
export const DEFAULT_RS_UID = 64000;
/** 同時に別の uid で動かせる抽出の数。使い切ったら、その抽出は rs-trafilatura を使わない */
export const RS_UID_COUNT = 256;

export const RS_UID_SPEC: ChildUidSpec = { setting: 'SORA_RS_TRAFILATURA_UID', defaultUid: DEFAULT_RS_UID, child: '本文の抽出（rs-trafilatura）の別プロセス', name: '本文の抽出', error: (message) => new ChildDropError(message) };

/** 本文の抽出が使う uid の範囲（off は null） */
export const rsUidRange = (env?: Env): UidRange | null => childUidRange(RS_UID_SPEC, RS_UID_COUNT, env);

const warn = (message: string) => warnChildOnce('[Sora/rs-trafilatura]', message);
const pool = new ChildUidPool(RS_UID_COUNT, (uid) => childDropProbe.reap(uid), warn, '本文の抽出', () => new ChildDropError(`本文の抽出に使える uid が空いていない（同時に ${RS_UID_COUNT} 件が動いている）`));

export interface RsLaunch {
  command: string[];
  /** 落とすときだけ指定する（落とさないときは、呼び出し側のいつもの環境変数） */
  env?: Record<string, string>;
  cwd?: string;
}

function plan(command: readonly string[], env: Env) {
  const strict = isolationLevel(env) === 'strict';
  const browser = browserUidRange(env, strict ? strictBrowserProcessMax(env) : 1);
  return planChildDrop(RS_UID_SPEC, {
    env,
    strict,
    currentUid: childDropProbe.currentUid(),
    launcherExists: childDropProbe.launcherExists(),
    missingCapabilities: childDropProbe.missingCapabilities(),
    size: RS_UID_COUNT,
    others: [browser ? { name: 'Chromium', setting: 'SORA_BROWSER_UID', first: browser.first, last: browser.last } : null, pdfUidRange(env)],
    launcher: childDropProbe.launcher(),
  });
}

/**
 * 抽出の子を起動する側（run）に、起動コマンド（落とすときは起動用バイナリ経由・環境変数・作業ディレクトリ）を渡して動かし、
 * 終わったら（run が失敗しても）、その uid のプロセスを片づけて返す。使えないとき（strict で落とせない・uid が空かないなど）は、
 * run を呼ばずに ChildDropError を投げる（数えて、1 回だけ知らせる）。
 */
export async function withRsUid<T>(command: readonly string[], run: (launch: RsLaunch) => Promise<T>, env: Env = process.env): Promise<T> {
  let lease: ChildUidLease | undefined;
  let launch: RsLaunch = { command: [...command] };
  try {
    const { drop, warnings } = plan(command, env);
    for (const warning of warnings) warn(warning);
    if (drop) {
      lease = await pool.lease(drop.baseUid);
      launch = droppedChild(command, drop.launcher, lease.uid, lease.gid);
    }
  } catch (error) {
    if (error instanceof ChildDropError) {
      incrementSecurityCounter('sora_main_content_rs_uid_unavailable_total');
      warn(`${error.message}。本文の抽出は、rs-trafilatura を使わず、Readability にする`);
    }
    throw error;
  }
  try {
    return await run(launch);
  } finally {
    await lease?.done();
  }
}
