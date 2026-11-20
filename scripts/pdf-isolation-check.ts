/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: PDF の解析が、イメージに同梱の別プロセス（/app/pdf-parse.js。Containerfile の
 * `bun build ./src/pdf_child_main.ts`）で動き、メモリの暴走（Flate で膨らむ PDF）を、その解析のプロセスだけで止めること。
 * コンテナのメモリを 1GB に絞って流す（--memory=1g）。止められなければ、1.6GB に膨らむ PDF が、この確認ごとコンテナを落とす
 * （隔離の前は、そうなった。実測）。止めたあとは、本体（この確認）が無事で、別プロセスが残らず、メモリが戻っていること。
 * 使い方: docker run --rm --memory=1g --memory-swap=1g -e NODE_ENV=test -e SORA_DB_PATH=:memory: \
 *           -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/pdf-isolation-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（穴 26。実装の状態「PDF の解析の隔離」）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { verifyStrictPdf } from '../src/browser_startup.js';
import { parsePdfToMarkdown, PdfParseLimitError, pdfSlots } from '../src/pdf.js';
import { readChildRssMb } from '../src/pdf_child.js';
import { makeBombPdf, makePdf } from '../src/test_fixtures/pdf.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const URL_OF = 'https://x.example/a.pdf';
const BUNDLE_DIR = '/app';
const inBundle = { entryDir: BUNDLE_DIR };

/** 動いている別プロセス（コマンド行に pdf-parse.js を含む）の pid */
function childPids(): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, 'utf8').includes('pdf-parse.js')) pids.push(Number(name));
    } catch {}
  }
  return pids;
}
const rssMb = (): number => Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) / 1024;

// 0. メモリの上限を効かせるための、/proc/<pid>/status の読み取りが、この運用（seccomp・capability）でできる
check(readChildRssMb(process.pid) !== undefined, 'プロセスのメモリ（RSS）を /proc/<pid>/status から読めない（メモリの上限が効かない）');

// 1. イメージに、同梱の入口がある（Containerfile の bun build と COPY）
check(existsSync(`${BUNDLE_DIR}/pdf-parse.js`), `イメージに ${BUNDLE_DIR}/pdf-parse.js が無い（Containerfile の bun build と COPY を確かめる）`);

// 2. 同梱の入口で、普通の PDF を読める。このプロセスの中で解析した結果と同じ
const make = () => makePdf([['Hello from the bundled child'], ['second page']], { title: 'Image Check', author: 'Verify' });
const viaBundle = await parsePdfToMarkdown(make(), URL_OF, 30_000, { child: inBundle });
const inline = await parsePdfToMarkdown(make(), URL_OF, 30_000, { inline: true });
check(viaBundle.content.includes('Hello from the bundled child'), `同梱の入口で、本文を読めない: ${JSON.stringify(viaBundle.content)}`);
check(JSON.stringify(viaBundle) === JSON.stringify(inline), '同梱の入口の結果が、このプロセスの中で解析した結果と違う');

// 3. strict の起動の確認と同じ試し読みが、同梱の入口で通る
const probe = await verifyStrictPdf((bytes, url, max, options) => parsePdfToMarkdown(bytes, url, max, { ...options, child: inBundle }));
check(probe.status === 'ok', `strict の試し読みが通らない: ${JSON.stringify(probe)}`);

// 4. メモリの上限（ここでは 300MB に絞る）を超える PDF（512MB に膨らむ）は、その解析のプロセスだけが止まり、失敗する。この確認は無事
const limited = { entryDir: BUNDLE_DIR, limits: { memoryMb: 300 } };
const error = await parsePdfToMarkdown(makeBombPdf(512), URL_OF, 30_000, { child: limited }).catch((e: unknown) => e);
check(error instanceof PdfParseLimitError && error.reason === 'memory', `メモリの上限で止まらない: ${String(error)}`);

// 5. 2 ページ目が爆弾なら、読めた先頭のページまでを返す
const partial = await parsePdfToMarkdown(makeBombPdf(512, ['first page survives']), URL_OF, 30_000, { child: limited });
check(partial.content.includes('first page survives') && partial.metadata?.pagesRead === 1 && partial.metadata?.totalPages === 2, `先頭のページまでを返さない: ${JSON.stringify(partial.metadata)}`);
check((partial.warnings ?? []).join('\n').includes('メモリの上限'), `警告が付かない: ${JSON.stringify(partial.warnings)}`);

// 6. 監視を外しても（上限を巨大にしても）、コンテナのメモリが尽きたとき、カーネルが選ぶのは別プロセスで、この確認は生き残る。
//    1.6GB に膨らむ PDF を、1GB のコンテナで読む。隔離の前は、この確認ごと強制終了された
const backstop = await parsePdfToMarkdown(makeBombPdf(1600), URL_OF, 30_000, { child: { entryDir: BUNDLE_DIR, limits: { memoryMb: 100_000, hardMs: 60_000 } } }).catch((e: unknown) => e);
check(backstop instanceof PdfParseLimitError && backstop.reason === 'crashed', `カーネルに止められた別プロセスが、勝手に終わったものとして扱われない: ${String(backstop)}`);

// 7. 止めたあと: 別プロセスが残らず、順番は手放され、本体のメモリは小さいまま、次の解析が動く
await Bun.sleep(300);
check(childPids().length === 0, `別プロセスが残っている: ${childPids().join(', ')}`);
check(pdfSlots.activeCount === 0, `解析の順番を手放していない: ${pdfSlots.activeCount}`);
check(rssMb() < 500, `本体のメモリが大きい（${Math.round(rssMb())} MB）`);
const after = await parsePdfToMarkdown(make(), URL_OF, 30_000, { child: inBundle });
check(after.content.includes('Hello from the bundled child'), '止めたあと、次の解析が動かない');

if (failures.length > 0) {
  for (const failure of failures) console.error(`NG: ${failure}`);
  process.exit(1);
}
console.log(`OK: PDF の解析は同梱の別プロセスで動き、メモリの暴走は、その解析のプロセスだけが止まった（本体のメモリ ${Math.round(rssMb())} MB）`);
