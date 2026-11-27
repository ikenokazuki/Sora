/**
 * 本文の抽出（rs-trafilatura。rs_trafilatura.ts）の別プロセスを、Sora 本体（root）とも Chromium とも PDF の解析とも別の uid に落として動かす
 * （設計 2 の続き）。信頼できない HTML を読むので、破られたときに、運用者の秘密と、ほかの利用者に届かないようにする。共通の部品は child_uid.ts。
 *
 * uid: 抽出は、取得のたびに動き、同時に動く数に上限が無い（crawl・search_deep・複数の利用者）。1 件に 1 つ、別の uid を、広い範囲
 * （基準から RS_UID_COUNT 個。既定は 64000〜64255）から渡す。空きが無いとき・strict で落とせないとき・起動用バイナリが起動を断ったときは、
 * rs-trafilatura を使わない（呼び出し側は、Readability の経路に戻り、取得の結果の warnings に書く。root のままでは動かさない）。
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

/** ページの変換の別プロセス（html_convert.ts）も、同じ設定・同じ範囲を使う。断る・知らせる文だけを、変換の言葉にする */
const CONVERT_UID_SPEC: ChildUidSpec = { ...RS_UID_SPEC, child: 'ページの変換の別プロセス', name: 'ページの変換' };

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

/** 重なってはいけない、ほかの uid の範囲。Chromium は、standard は共有の 1 つ、strict は利用者ごとのプロセスの数ぶん */
function otherUidRanges(env: Env, strict: boolean): Array<UidRange | null> {
  const browser = browserUidRange(env, strict ? strictBrowserProcessMax(env) : 1);
  return [browser ? { name: 'Chromium', setting: 'SORA_BROWSER_UID', first: browser.first, last: browser.last } : null, pdfUidRange(env)];
}

function plan(env: Env, spec: ChildUidSpec = RS_UID_SPEC) {
  const strict = isolationLevel(env) === 'strict';
  return planChildDrop(spec, {
    env,
    strict,
    currentUid: childDropProbe.currentUid(),
    launcherExists: childDropProbe.launcherExists(),
    missingCapabilities: childDropProbe.missingCapabilities(),
    size: RS_UID_COUNT,
    others: otherUidRanges(env, strict),
    launcher: childDropProbe.launcher(),
  });
}

/**
 * strict の起動の検査: 設定の値だけで、本文の抽出が使えないと分かるもの（off・ほかの uid との重なり・uid の最大超え）。起動できても毎回
 * Readability になるので、起動を断る。root・起動用バイナリ・capability は見ない（Chromium と PDF の起動の確認が見る）。
 */
export function strictRsUidConfigProblem(env: Env): string | undefined {
  try {
    planChildDrop(RS_UID_SPEC, { env, strict: true, currentUid: 0, launcherExists: true, size: RS_UID_COUNT, others: otherUidRanges(env, true) });
    return undefined;
  } catch (error) {
    if (error instanceof ChildDropError) return error.message;
    throw error;
  }
}

/** 使えないことを数えて、同じ理由は 1 回だけ、運用者に知らせる */
function reportUnavailable(error: ChildDropError): ChildDropError {
  incrementSecurityCounter('sora_main_content_rs_uid_unavailable_total');
  warn(`${error.message}。このとき rs-trafilatura の結果は使えない（本文は Readability になる。画像を戻す 2 回目なら、画像が戻らない）`);
  return error;
}

/** 起動用バイナリが、落とせない・落とした uid で実行できないときに、返す終了コード（native/chromium-launcher/main.rs） */
export const LAUNCHER_REFUSED_EXIT_CODE = 126;

/** 起動用バイナリが起動を断ったとき。使えないものとして数えて知らせ、投げる例外を返す */
export const rsLaunchRefused = (): ChildDropError =>
  reportUnavailable(new ChildDropError(`起動用バイナリが、本文の抽出を起動できなかった（終了コード ${LAUNCHER_REFUSED_EXIT_CODE}。別の uid に落とせないか、落とした uid で SORA_RS_TRAFILATURA_PATH のコマンドを実行できない。コマンドと、その親のディレクトリを、誰でも実行できるようにする）`));

/**
 * 抽出の子を起動する側（run）に、起動コマンド（落とすときは起動用バイナリ経由・環境変数・作業ディレクトリ）を渡して動かし、
 * 終わったら（run が失敗しても）、その uid のプロセスを片づけて返す。使えないとき（strict で落とせない・uid が空かないなど）は、
 * run を呼ばずに ChildDropError を投げる（数えて、1 回だけ知らせる）。
 */
export async function withRsUid<T>(command: readonly string[], run: (launch: RsLaunch) => Promise<T>, env: Env = process.env): Promise<T> {
  let lease: ChildUidLease | undefined;
  let launch: RsLaunch = { command: [...command] };
  try {
    const { drop, warnings } = plan(env);
    for (const warning of warnings) warn(warning);
    if (drop) {
      lease = await pool.lease(drop.baseUid);
      launch = droppedChild(command, drop.launcher, lease.uid, lease.gid);
    }
  } catch (error) {
    throw error instanceof ChildDropError ? reportUnavailable(error) : error;
  }
  try {
    return await run(launch);
  } finally {
    await lease?.done();
  }
}

/**
 * HTML の変換の別プロセス（html_convert.ts）を、本文の抽出と同じ uid の範囲（SORA_RS_TRAFILATURA_UID の基準から RS_UID_COUNT 個）から、
 * 1 件に 1 つ借りた uid に落として動かす（どちらも信頼できない HTML を読む子なので、同じ範囲を分けて使い、新しい設定を足さない。
 * 同時に 2 つの子が同じ uid を持つことはない）。終わったら（run が失敗しても）、その uid のプロセス（子の中で動かした本文の抽出も）を片づける。
 * 使えないとき（strict で落とせない・uid が空かないなど）は、run を呼ばずに ChildDropError を投げる（扱いは呼び出し側。本文の抽出のカウンターは数えない）。
 */
export async function withExtractionUid<T>(command: readonly string[], run: (launch: RsLaunch) => Promise<T>, env: Env = process.env): Promise<T> {
  const { drop, warnings } = plan(env, CONVERT_UID_SPEC);
  for (const warning of warnings) warn(warning);
  if (!drop) return run({ command: [...command] });
  const lease = await pool.lease(drop.baseUid);
  try {
    return await run(droppedChild(command, drop.launcher, lease.uid, lease.gid));
  } finally {
    await lease.done();
  }
}
