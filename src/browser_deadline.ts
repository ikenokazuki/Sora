/**
 * ブラウザの枠を持つ処理の、全体の時間の上限。
 *
 * ページの JavaScript が回り続けると、ページを読む呼び出し（evaluate・content・title・入力・撮影）は返らず、puppeteer の通信の時間切れ（1 回 180 秒）まで待つ。
 * 呼び出しが続けば、その回数だけ伸びて、枠を握り続ける。上限を超えたら、返りを待たずに失敗にして、ページの入った文脈（context）ごと閉じる。
 * context.close() は、回り続ける renderer も終わらせ、数十ミリ秒で返る。page.close() は、撮影が残っていると返らないので使わない（Chromium 148 で実測）
 */
export const browserDeadlineSettings = {
  /** 取得の時間の上限（scrape の timeoutMs・browser_action の全体の時間）に足す猶予（ミリ秒）。ページを開いたあとの、本文や画像を取り出す分。試験は短くする */
  graceMs: 15_000,
  /** 打ち切ったあと、閉じ終わるのを待つ時間の上限（ミリ秒）。閉じる呼び出しが返らなくても、失敗は返す。試験は短くする */
  closeWaitMs: 5000,
};

/** ブラウザの処理が、時間の上限を超えた。文に「タイムアウト」を含める（REST で 408 に分類される） */
export class BrowserDeadlineError extends Error {
  constructor(ms: number, note = '') {
    super(`ブラウザの処理がタイムアウトしました（${Math.round(ms / 1000)} 秒）${note}`);
    this.name = 'BrowserDeadlineError';
  }
}

/**
 * work を ms まで待つ。超えたら、signal を中止して close を呼び、閉じ終わるのを待ってから（closeWaitMs まで）、BrowserDeadlineError で失敗する。
 * 呼び出し元がブラウザの枠を返すのは失敗のあとなので、ページが閉じる前に枠が空かない。
 * work の残りは、閉じたあとの呼び出しの失敗で終わる（結果は捨てる）ので、DB への書き込みなどの前には signal を確かめる
 */
export async function runWithBrowserDeadline<T>(
  ms: number,
  close: () => Promise<unknown>,
  work: (signal: AbortSignal) => Promise<T>,
  note = '',
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserDeadlineError(ms, note);
      controller.abort(error);
      // 先に失敗を決めてから閉じる（閉じた拍子の work の失敗が、時間切れの失敗より先に返らないように）
      reject(error);
      closing = (async () => close())().then(() => {}, () => {});
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } catch (error) {
    if (closing) await settleWithin(closing, browserDeadlineSettings.closeWaitMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** promise が終わるか、ms たつまで待つ */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}
