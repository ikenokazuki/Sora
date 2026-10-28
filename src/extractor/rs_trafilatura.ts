/**
 * rs-trafilatura（https://github.com/Murrough-Foley/rs-trafilatura、MIT OR Apache-2.0）のコマンドで、
 * ページの本文の HTML とページの種類（article・listing・forum など）を得る。
 * --markdown を付けないと、本文の HTML からリンクの href が落ちる（include_links が既定で無効のため）。
 * コマンドは RS_TRAFILATURA_PATH（イメージでは /usr/local/bin/rs-trafilatura）。未設定・失敗・時間切れのときは
 * undefined を返し、呼び出し側は Readability の経路に戻る。評価は docs/evaluations/main-content/results.md。
 */
import { existsSync } from 'node:fs';
import { incrementSecurityCounter } from '../security/metrics.js';

export interface RsMainContent {
  pageType?: string;
  contentHtml: string;
}

/** 1 ページの取り出しの上限。rs-trafilatura は 1 ページ数十 ms なので、これを超えるのは異常なページだけ */
const RS_TIMEOUT_MS = 5000;

export async function extractMainContentWithRs(
  html: string,
  url: string,
  bin: string | undefined = process.env.RS_TRAFILATURA_PATH,
): Promise<RsMainContent | undefined> {
  if (!bin || !html || !existsSync(bin)) return undefined;
  try {
    const proc = Bun.spawn([bin, '--url', url, '--hybrid', '--markdown'], { stdin: new TextEncoder().encode(html), stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), RS_TIMEOUT_MS);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    const out = code === 0 ? JSON.parse(stdout || '{}') : {};
    if (typeof out.content_html !== 'string' || !out.content_html.trim()) {
      try { incrementSecurityCounter('sora_main_content_rs_empty_total'); } catch {}
      return undefined;
    }
    return { contentHtml: out.content_html, ...(typeof out.page_type === 'string' ? { pageType: out.page_type } : {}) };
  } catch {
    try { incrementSecurityCounter('sora_main_content_rs_failed_total'); } catch {}
    return undefined;
  }
}
