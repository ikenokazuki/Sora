/**
 * 取得したページの HTML の変換専用の入口。親プロセス（Sora 本体。html_convert.ts）が起動し、標準入力に、頼み方の JSON の 1 行と HTML を渡す。
 * 標準出力には、1 行の JSON を返す（done か error。html_convert_protocol.ts）。終了コードは、結果にかかわらず 0（頼み方の誤りも error の行）。
 * アプリ本体（MCP・ブラウザ・DB など）は読み込まない。本番は `bun build` で 1 つにまとめた html-convert.js として同梱する（Containerfile）。
 * 親が上限（時間・メモリ・出力量）を超えたら SIGKILL で止めるので、ここに時間やメモリの制御は要らない。
 */
import { lowerOomPriority } from './child_oom.js';
import { extractMainContentWithRs } from './extractor/rs_trafilatura.js';
import { CHILD_COUNTER_MAX, CHILD_COUNTER_NAME, decodeConvertRequest } from './html_convert_protocol.js';
import { conversionHooks, convertHtmlToMarkdown } from './html_parser.js';
import { getSecurityMetrics } from './security/metrics.js';

/**
 * 子の中の本文の抽出（rs-trafilatura）が読む環境。uid を借りずに、この子と同じ uid のまま動かす（この子は、すでに本体と別の uid に落ちている。
 * 子の中に、uid を借りる仕組みを、親と別に持たない: 親が貸している uid と重なりうる）。水準は standard として読まれる（子は SORA_ISOLATION を受け取らない）
 */
const RS_IN_CHILD_ENV = { SORA_RS_TRAFILATURA_UID: 'off' };

/** 本文の抽出（rs-trafilatura）のために、この変換の間に数えたカウンターの増え（名前の形が合うものだけ。親の /metrics に足す） */
function countersSince(before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(getSecurityMetrics())) {
    const added = value - (before[name] ?? 0);
    if (added > 0 && CHILD_COUNTER_NAME.test(name)) out[name] = Math.min(added, CHILD_COUNTER_MAX);
  }
  return out;
}

/**
 * 頼み方を読み、（頼まれたら本文の抽出もして）変換し、結果の行（改行つき）を write に流す。例外は error の行にする（投げない）。
 * 親が先に死んで書けなくなっても、投げない。gc は、変換の重い段階の前に呼ぶ（本番の子は Bun.gc(true)。メモリの最大を下げる）
 */
export async function runConvertChild(bytes: Uint8Array, write: (line: string) => void | Promise<void>, options: { gc?: () => void } = {}): Promise<void> {
  try {
    try {
      const { request, html } = decodeConvertRequest(bytes);
      const before = getSecurityMetrics();
      const rsUnavailable: Array<'content' | 'images'> = [];
      const rsMain = request.mainContent
        ? await extractMainContentWithRs(html, request.url, request.mainContent.bin, {
            removeSelectors: request.mainContent.removeSelectors,
            includeMedia: request.mainContent.includeMedia,
            onUnavailable: (missed) => void rsUnavailable.push(missed),
            env: RS_IN_CHILD_ENV,
          })
        : undefined;
      conversionHooks.beforeHeavyStage = options.gc;
      let result: ReturnType<typeof convertHtmlToMarkdown>;
      try {
        result = convertHtmlToMarkdown(
          html,
          request.url,
          request.maxChars,
          request.isRendered,
          request.onlyMainContent,
          request.selectors,
          request.removeSelectors,
          request.stripLinks,
          request.keepDataImages ?? false,
          rsMain,
        );
      } finally {
        conversionHooks.beforeHeavyStage = undefined;
      }
      // 親が使わない大きな欄は返さない（links は型のうえで必須なので、空の配列にする）
      const { want } = request;
      const trimmed = {
        ...result,
        links: want.links ? result.links : [],
        images: want.images ? result.images : undefined,
        jsonLd: want.jsonLd ? result.jsonLd : undefined,
        tables: want.tables ? result.tables : undefined,
        html: want.html ? result.html : undefined,
      };
      await write(`${JSON.stringify({ t: 'done', result: trimmed, rsUnavailable, counters: countersSince(before) })}\n`);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      await write(`${JSON.stringify({ t: 'error', name, message })}\n`);
    }
  } catch {
    // 書き込みの失敗（親が先に死んだ）。もう読む人がいない
  }
}

if (import.meta.main) {
  lowerOomPriority();
  // 標準出力は結果の行だけにするので、console は標準エラー（親が末尾だけ記録する）へ流す
  const toStderr = (...args: unknown[]): void => void process.stderr.write(`${args.map(String).join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
  const write = async (line: string): Promise<void> => void (await Bun.write(Bun.stdout, line));
  await runConvertChild(new Uint8Array(await Bun.stdin.arrayBuffer()), write, { gc: () => Bun.gc(true) });
  // process.exit() は呼ばない（pdf_child_main.ts と同じ理由）。取り残されて終われないときの保険は、unref したタイマー
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 1000).unref();
}
