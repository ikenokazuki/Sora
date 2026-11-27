/**
 * イメージの中で動かす確認（scripts/verify-image.sh の 18）: ページの変換が、イメージに同梱の別プロセス（/app/html-convert.js。Containerfile の
 * `bun build ./src/html_convert_child_main.ts`）で、本体（root）と別の uid に落ちて動き、本体の中の変換と同じ結果を返し、
 * メモリの暴走を、その変換のプロセスだけで止めること。子の中の本文の抽出（イメージの rs-trafilatura）も動くこと。
 * コンテナのメモリを 1GB に絞って流す（--memory=1g）。止められなければ、大きいページの変換が、この確認ごとコンテナを落とす。
 * 使い方: docker run --rm --memory=1g --memory-swap=1g -e NODE_ENV=test -e SORA_DB_PATH=:memory: \
 *           -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/convert-isolation-check.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { missingDropCapabilities } from '../src/browser_launch_plan.js';
import { verifyStrictConvert } from '../src/browser_startup.js';
import { readChildRssMb } from '../src/child_runner.js';
import { extractMainContentWithRs } from '../src/extractor/rs_trafilatura.js';
import { DEFAULT_RS_UID, RS_UID_COUNT, withExtractionUid } from '../src/extractor/rs_uid.js';
import { ConvertLimitError, convertPage, convertSlots } from '../src/html_convert.js';
import { convertHtmlToMarkdown } from '../src/html_parser.js';
import { getSecurityMetrics } from '../src/security/metrics.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const URL_OF = 'https://x.example/page';
const BUNDLE_DIR = '/app';
const strictChild = (limits?: { memoryMb?: number; hardMs?: number }) => ({ level: 'strict' as const, entryDir: BUNDLE_DIR, ...(limits ? { limits } : {}) });

/** 動いている変換の別プロセス（コマンド行に html-convert.js を含む）の pid */
function childPids(): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, 'utf8').includes('html-convert.js')) pids.push(Number(name));
    } catch {}
  }
  return pids;
}
const rssMb = (): number => Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) / 1024;

// 0. メモリの上限を効かせるための、/proc/<pid>/status の読み取りが、この運用（seccomp・capability）でできる。この確認は root で動かす
check(readChildRssMb(process.pid) !== undefined, 'プロセスのメモリ（RSS）を /proc/<pid>/status から読めない（メモリの上限が効かない）');
check(process.getuid?.() === 0, `この確認は root（Sora 本体と同じ）で動かす（uid=${process.getuid?.()}）`);

// 1. イメージに、同梱の入口がある（Containerfile の bun build と COPY）
check(existsSync(`${BUNDLE_DIR}/html-convert.js`), `イメージに ${BUNDLE_DIR}/html-convert.js が無い（Containerfile の bun build と COPY を確かめる）`);

// 2. 変換の子は、本文の抽出と同じ uid の範囲から借りた uid に落ちる（同じ経路で、自分の uid を返す台本を動かす）
const canDrop = missingDropCapabilities(readFileSync('/proc/self/status', 'utf8')).length === 0;
check(canDrop, 'uid を落とすのに要る capability が足りない（この確認は、既定と推奨の strict の運用で動かす）');
const childUid = await withExtractionUid([process.execPath, '-e', 'console.log(process.getuid())'], async (launch) => {
  const proc = Bun.spawn(launch.command, { stdout: 'pipe', stderr: 'pipe', ...(launch.env ? { env: launch.env } : {}), ...(launch.cwd ? { cwd: launch.cwd } : {}) });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim());
});
check(childUid >= DEFAULT_RS_UID && childUid < DEFAULT_RS_UID + RS_UID_COUNT, `変換の子の uid が、本文の抽出の範囲（${DEFAULT_RS_UID}〜）に無い: ${childUid}`);

// 3. 同梱の入口で、本体の中の変換と同じ結果になる。子の中の本文の抽出（イメージの rs-trafilatura）も動く（使えなかった警告も、失敗の数えも無い）
const page = `<html><head><title>イメージの確認</title></head><body><main>${'<section><h2>見出し</h2><p>これはイメージの中の確認のための本文です。<a href="/next">次の記事</a>への案内と、ふつうの長さの文章が続きます。</p></section>'.repeat(30)}</main></body></html>`;
const failedBefore = getSecurityMetrics().sora_main_content_rs_failed_total ?? 0;
const viaChild = await convertPage({ html: page, url: URL_OF, maxChars: 30_000 }, { child: strictChild(), mainContent: {} });
const inline = convertHtmlToMarkdown(page, URL_OF, 30_000, false, true, undefined, undefined, undefined, false, await extractMainContentWithRs(page, URL_OF));
check(viaChild.parsed.markdown === inline.markdown, '同梱の入口の結果が、本体の中で変換した結果と違う');
check(viaChild.parsed.markdown.includes('これはイメージの中の確認のための本文です'), `同梱の入口で、本文を変換できない: ${JSON.stringify(viaChild.parsed.markdown.slice(0, 100))}`);
check(viaChild.warnings.length === 0, `子の中で本文の抽出が使えない: ${JSON.stringify(viaChild.warnings)}`);
check((getSecurityMetrics().sora_main_content_rs_failed_total ?? 0) === failedBefore, '子の中の本文の抽出が失敗した');

// 4. strict の起動の確認と同じ試しが、同梱の入口で通る
const probe = await verifyStrictConvert((input, options) => convertPage(input, { ...options, child: { ...options?.child, entryDir: BUNDLE_DIR } }));
check(probe.status === 'ok', `strict の起動の確認と同じ試しが通らない: ${JSON.stringify(probe)}`);

// 5. メモリの上限（ここでは 150MB に絞る）を超えるページ（リンクと画像の多い 100 万字。約 380MB 要る）は、その変換のプロセスだけが止まり、失敗する
let dense = '';
for (let i = 0; dense.length < 1_000_000; i++) dense += `<li><a href="/item/${i}">商品 ${i}</a> <img src="/img/${i}.jpg" alt="写真"></li>`;
const denseHtml = `<html><head><title>t</title></head><body><main><ul>${dense}</ul></main></body></html>`;
const memoryError = await convertPage({ html: denseHtml, url: URL_OF, maxChars: 30_000 }, { child: strictChild({ memoryMb: 150 }) }).catch((e: unknown) => e);
check(memoryError instanceof ConvertLimitError && memoryError.reason === 'memory', `メモリの上限で止まらない: ${String(memoryError)}`);

// 6. 監視を外しても（上限を巨大にしても）、コンテナのメモリが尽きたとき、カーネルが選ぶのは変換の子で、この確認は生き残る。
//    1,000 万字の記事（子は 1GB を超える。500 万字は、子の中の GC のおかげで 1GB に収まり、尽きなかった）を、1GB のコンテナで変換する
let giant = '';
for (let i = 0; giant.length < 10_000_000; i++) giant += `<section><h2>見出し ${i}</h2><p>これは段落 ${i} の本文です。<a href="/a/${i % 300}">関連する記事</a>への案内と、ふつうの長さの文章が続きます。</p></section>`;
const giantHtml = `<html><head><title>t</title></head><body><main>${giant}</main></body></html>`;
const backstop = await convertPage({ html: giantHtml, url: URL_OF, maxChars: 30_000 }, { child: strictChild({ memoryMb: 100_000, hardMs: 120_000 }) }).catch((e: unknown) => e);
check(backstop instanceof ConvertLimitError && backstop.reason === 'crashed', `カーネルに止められた変換の子が、勝手に終わったものとして扱われない: ${backstop instanceof Error ? String(backstop) : '変換が終わった（コンテナのメモリが尽きなかった。ページを大きくする）'}`);

// 7. 止めたあと: 子が残らず、順番は手放され、本体のメモリは小さいまま、次の変換が動く
await Bun.sleep(300);
check(childPids().length === 0, `変換の子が残っている: ${childPids().join(', ')}`);
check(convertSlots.activeCount === 0, `変換の順番を手放していない: ${convertSlots.activeCount}`);
check(rssMb() < 600, `本体のメモリが大きい（${Math.round(rssMb())} MB）`);
const after = await convertPage({ html: page, url: URL_OF, maxChars: 30_000 }, { child: strictChild() });
check(after.parsed.markdown.includes('これはイメージの中の確認のための本文です'), '止めたあと、次の変換が動かない');

if (failures.length > 0) {
  for (const failure of failures) console.error(`NG: ${failure}`);
  process.exit(1);
}
console.log(`OK: ページの変換は同梱の別プロセス（uid ${childUid}）で動き、本体の中の変換と同じ結果で、メモリの暴走は、その変換のプロセスだけが止まった（本体のメモリ ${Math.round(rssMb())} MB）`);
