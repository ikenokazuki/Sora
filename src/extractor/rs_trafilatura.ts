/**
 * rs-trafilatura（https://github.com/Murrough-Foley/rs-trafilatura、MIT OR Apache-2.0）のコマンドで、
 * ページの本文の HTML とページの種類（article・listing・forum など）を得る。
 * --markdown を付けないと、本文の HTML からリンクの href が落ちる（include_links が既定で無効のため）。
 * コマンドは SORA_RS_TRAFILATURA_PATH（イメージでは /usr/local/bin/rs-trafilatura）。未設定・失敗・時間切れのときは
 * undefined を返し、呼び出し側は Readability の経路に戻る。評価は docs/evaluations/main-content/results.md。
 * rs-trafilatura の本文の HTML には img が入らないので、記事以外のページで画像があるときは、画像の後ろに目印を置いた HTML で
 * もう一度取り出し、本文が 1 回目と同じときだけ目印を画像に戻す（rs_images.ts）。
 */
import { existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { envPath } from '../config.js';
import { childEnv } from '../security/child_env.js';
import { incrementSecurityCounter } from '../security/metrics.js';
import { markImagesForRs, restoreRsImages } from './rs_images.js';

export interface RsMainContent {
  pageType?: string;
  contentHtml: string;
}

export interface RsExtractOptions {
  /** 渡す前に消す要素の CSS セレクタ（指定されたときだけ HTML を読み直す） */
  removeSelectors?: string[];
  /** false なら画像を戻さない（2 回目を走らせない） */
  includeMedia?: boolean;
}

/** 1 回の取り出しの上限。rs-trafilatura は 1 ページ数十 ms なので、これを超えるのは異常なページだけ */
const RS_TIMEOUT_MS = 5000;

/** コマンドを 1 回走らせる。本文が空なら undefined。起動の失敗・壊れた出力は例外 */
async function runRs(bin: string, html: string, url: string, pageType?: string): Promise<RsMainContent | undefined> {
  const args = [bin, '--url', url, '--hybrid', '--markdown', ...(pageType ? ['--page-type', pageType] : [])];
  const proc = Bun.spawn(args, { stdin: new TextEncoder().encode(html), stdout: 'pipe', stderr: 'ignore', env: childEnv() });
  const timer = setTimeout(() => proc.kill(), RS_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const out = code === 0 ? JSON.parse(stdout || '{}') : {};
    if (typeof out.content_html !== 'string' || !out.content_html.trim()) return undefined;
    return { contentHtml: out.content_html, ...(typeof out.page_type === 'string' ? { pageType: out.page_type } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

export async function extractMainContentWithRs(
  html: string,
  url: string,
  bin: string | undefined = envPath('SORA_RS_TRAFILATURA_PATH'),
  options: RsExtractOptions = {},
): Promise<RsMainContent | undefined> {
  if (!bin || !html || !existsSync(bin)) return undefined;
  let input = html;
  if (options.removeSelectors && options.removeSelectors.length > 0) {
    // 正しくないセレクタは、今までどおりエラーにする（scrape の失敗として返る）
    const $ = cheerio.load(html);
    $(options.removeSelectors.join(', ')).remove();
    input = $.html();
  }
  let first: RsMainContent | undefined;
  try {
    first = await runRs(bin, input, url);
  } catch {
    try { incrementSecurityCounter('sora_main_content_rs_failed_total'); } catch {}
    return undefined;
  }
  if (!first) {
    try { incrementSecurityCounter('sora_main_content_rs_empty_total'); } catch {}
    return undefined;
  }
  // 記事のページは Readability の本文を使うので、画像を戻さない
  if (options.includeMedia === false || !first.pageType || first.pageType === 'article' || !/<img\b/i.test(input)) return first;
  try {
    const marked = markImagesForRs(input, url);
    if (marked.images.length === 0) return first;
    const second = await runRs(bin, marked.html, url, first.pageType);
    const restored = second ? restoreRsImages(first.contentHtml, second.contentHtml, marked.images) : undefined;
    return restored ? { ...first, contentHtml: restored } : first;
  } catch {
    return first;
  }
}
