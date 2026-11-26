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
};

/** ブラウザの処理が、時間の上限を超えた。文に「タイムアウト」を含める（REST で 408 に分類される） */
export class BrowserDeadlineError extends Error {
  constructor(ms: number, note = '') {
    super(`ブラウザの処理がタイムアウトしました（${Math.round(ms / 1000)} 秒）${note}`);
    this.name = 'BrowserDeadlineError';
  }
}

/**
 * work を ms まで待つ。超えたら close を呼び（返りは待たない）、signal を中止して、BrowserDeadlineError で失敗する。
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
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserDeadlineError(ms, note);
      controller.abort(error);
      void (async () => close())().catch(() => {});
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
