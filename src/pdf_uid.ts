/**
 * PDF の解析の別プロセス（pdf_child.ts）を、Sora 本体（root）とも Chromium とも別の uid に落として動かす（設計 2 の続き。穴 26）。
 * 共通の部品は child_uid.ts（本文の抽出の extractor/rs_uid.ts も使う）。
 *
 * uid: 同時に動く PDF の解析は PDF_CONCURRENCY 件で、1 件に 1 つ、別の uid を渡す（基準 + 番号。既定の基準 65530 なら 65530・65531）。
 * Chromium の uid の範囲（SORA_BROWSER_UID の基準から）とは重ならないようにする。
 */
import { browserUidRange } from './browser_launch_plan.js';
import { ChildDropError, childDropProbe, type ChildDrop, type ChildDropPlanInput, type ChildUidSpec, ChildUidPool, childUidRange, droppedChild, planChildDrop, resetChildDropWarnings, type UidRange, warnChildOnce } from './child_uid.js';
import type { Env } from './config.js';
import { isolationLevel, strictBrowserProcessMax } from './security/limits.js';

export { droppedChild };

/** 同時に動かす PDF の解析の数（全員で共有。pdf.ts の順番の枠）。1 件に 1 つの uid が要るので、uid の数でもある */
export const PDF_CONCURRENCY = 2;
/** 落とし先の uid の基準の既定。Chromium の既定（65532〜）の、すぐ下 */
export const DEFAULT_PDF_UID = 65530;

export class PdfDropError extends ChildDropError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfDropError';
  }
}

export const PDF_UID_SPEC: ChildUidSpec = { setting: 'SORA_PDF_UID', defaultUid: DEFAULT_PDF_UID, child: 'PDF の解析の別プロセス', name: 'PDF の解析', error: (message) => new PdfDropError(message) };

/** PDF の解析が使う uid の範囲（off は null）。ほかの子の uid と重ならないかを調べるのに使う */
export const pdfUidRange = (env?: Env): UidRange | null => childUidRange(PDF_UID_SPEC, PDF_CONCURRENCY, env);

export type PdfDrop = ChildDrop;
export interface PdfDropPlanInput extends Omit<ChildDropPlanInput, 'others'> {
  /** Chromium の uid の範囲（browserUidRange）。重なりを調べる。省略・null は調べない */
  browser?: { first: number; last: number } | null;
}

const chromiumRange = (range: { first: number; last: number } | null | undefined): UidRange | null =>
  range ? { name: 'Chromium', setting: 'SORA_BROWSER_UID', first: range.first, last: range.last } : null;

/** 別の uid に落とすかを決める（child_uid.ts の planChildDrop）。strict の失敗は、起動の確認（browser_startup.ts の verifyStrictPdf）が気づいて止める */
export function planPdfDrop({ browser, ...options }: PdfDropPlanInput): { drop: PdfDrop | null; warnings: string[] } {
  return planChildDrop(PDF_UID_SPEC, { ...options, others: [chromiumRange(browser)] });
}

/** PDF の解析の uid の池。空きが無ければ PdfDropError */
export class PdfUidPool extends ChildUidPool {
  constructor(size: number, reap: (uid: number) => Promise<boolean>, warn: (message: string) => void = () => {}) {
    super(size, reap, warn, 'PDF の解析', () => new PdfDropError('PDF の解析に使える uid が空いていません（前の解析のプロセスが uid に残り、終わらせられません）。Sora を再起動してください'));
  }
}

/** 試験が差し替える口（child_uid.ts の childDropProbe と同じもの） */
export const pdfDropProbe = childDropProbe;
/** 試験用: 1 回だけ出す警告を、もう一度出せるようにする */
export const resetPdfDropWarnings = resetChildDropWarnings;

const warn = (message: string) => warnChildOnce('[Sora/PDF]', message);
const pool = new PdfUidPool(PDF_CONCURRENCY, (uid) => pdfDropProbe.reap(uid), warn);

/**
 * 別プロセスを起動する側（run）に、起動コマンドと環境変数を渡して動かす。落とすときは、uid を 1 つ借りて、起動用バイナリ経由のコマンドを渡し、
 * 終わったら（run が失敗しても）、その uid のプロセスを片づけて返す。落とさないときは、コマンドをそのまま渡す（環境変数・作業ディレクトリは指定しない）。
 * strict で落とせないなら、run を呼ばずに失敗する（root のまま動かさない）。
 */
export async function withPdfUid<T>(
  command: readonly string[],
  run: (launch: { command: string[]; env?: Record<string, string>; cwd?: string }) => Promise<T>,
  /** 設定を読む環境（テスト用。省略すると、プロセスの環境） */
  env: Env = process.env,
): Promise<T> {
  const strict = isolationLevel(env) === 'strict';
  const { drop, warnings } = planPdfDrop({
    env,
    strict,
    currentUid: pdfDropProbe.currentUid(),
    launcherExists: pdfDropProbe.launcherExists(),
    missingCapabilities: pdfDropProbe.missingCapabilities(),
    size: PDF_CONCURRENCY,
    // standard の Chromium は共有の 1 つ（番号 0）、strict は利用者ごと（最大 browserProcessMax 個）
    browser: browserUidRange(env, strict ? strictBrowserProcessMax(env) : 1),
    launcher: pdfDropProbe.launcher(),
  });
  for (const warning of warnings) warn(warning);
  if (!drop) return run({ command: [...command] });
  const lease = await pool.lease(drop.baseUid);
  try {
    return await run(droppedChild(command, drop.launcher, lease.uid, lease.gid));
  } finally {
    await lease.done();
  }
}
