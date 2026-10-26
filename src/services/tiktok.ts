import { cleanMarkdownTokens } from '../enrichment.js';
import { errorMessage } from '../errors.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { readBodyWithLimit } from '../net/safe_transport.js';
import { json3ToParagraphs, tLabel } from './youtube.js';

/**
 * TikTok の動画を scrape の本文にする（説明文・投稿者・投稿日時・長さ・自動字幕）。
 * 静的な取得では WAF の確認画面になるので、scrape がブラウザで開いたページの埋め込みデータ
 * （`__UNIVERSAL_DATA_FOR_REHYDRATION__` の `webapp.video-detail`）を読む。字幕は、データにある WebVTT の URL を
 * そのまま取得する（署名はページの側で付いている。Cookie は要らなかった。2026-10-26 に確認）。
 */

const CAPTION_TIMEOUT_MS = 10_000;
const CAPTION_MAX_BYTES = 5 * 1024 * 1024; // 16 分のニュース解説の自動字幕で約 36KB
// 字幕の取得先は TikTok の配信のホストだけ（データにある URL でも、それ以外には出さない）
const CAPTION_HOST = /(?:^|\.)(?:tiktok\.com|tiktokcdn\.com)$/i;
const NO_CAPTIONS = 'この動画には字幕（自動字幕を含む）がありません。話している内容は分からないので、説明文から分かることだけを答え、推測で補わないでください。';
const FETCH_FAILED = 'TikTok から字幕を取得できませんでした。時間をおいて再試行してください。話している内容は推測で補わないでください。';

interface TikTokItem {
  desc?: string;
  createTime?: string | number;
  author?: { uniqueId?: string; nickname?: string };
  video?: {
    duration?: number;
    subtitleInfos?: Array<{ Url?: string; LanguageCodeName?: string; Format?: string; Source?: string }>;
    claInfo?: { captionInfos?: Array<{ url?: string; languageCode?: string; isAutoGen?: boolean; isOriginalCaption?: boolean; captionFormat?: string }> };
  };
}

export interface TiktokPage {
  title: string;
  content: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  contentStatus: 'body' | 'metadata_only';
}

/** TikTok の動画のページ（`/@ユーザー/video/動画 ID`）の URL から、ユーザーと動画 ID を読む。ホストは完全一致で判定する。 */
export function parseTikTokVideoUrl(input: string): { user: string; videoId: string } | undefined {
  try {
    const url = new URL(input);
    if (!/^(?:www\.|m\.)?tiktok\.com$/i.test(url.hostname)) return undefined;
    const m = url.pathname.match(/^\/@([\w.-]+)\/video\/(\d+)\/?$/);
    return m ? { user: m[1], videoId: m[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** WebVTT の字幕を、開始時刻（ミリ秒）と文の並びにする。番号の行とタグ（`<c.color>` など）は外す。 */
export function parseWebVtt(vtt: string): Array<{ startMs: number; text: string }> {
  const cues: Array<{ startMs: number; text: string }> = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    const m = at >= 0 ? lines[at].match(/^\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/) : null;
    if (!m) continue;
    const text = lines.slice(at + 1).join(' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ startMs: ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]), text });
  }
  return cues;
}

function readItem(html: string): TikTokItem | undefined {
  const json = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) return undefined;
  try {
    return JSON.parse(json)?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  } catch {
    return undefined;
  }
}

/** 元の言語の字幕を選ぶ（TikTok が訳した字幕は使わない）。自動字幕かどうかも返す。 */
function pickCaption(item: TikTokItem): { url: string; auto: boolean } | undefined {
  const original = item.video?.claInfo?.captionInfos?.find((c) => c.isOriginalCaption && c.url);
  const subtitle = item.video?.subtitleInfos?.find((s) => s.Url && (s.Format ?? 'webvtt') === 'webvtt');
  const url = original?.url ?? subtitle?.Url;
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !CAPTION_HOST.test(parsed.hostname)) return undefined;
  } catch {
    return undefined;
  }
  return { url, auto: original ? original.isAutoGen !== false : subtitle?.Source === 'ASR' };
}

async function fetchCaptionText(url: string): Promise<string> {
  const { response } = await fetchWithSafeRedirects(url, CAPTION_TIMEOUT_MS, 5);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  return new TextDecoder().decode(await readBodyWithLimit(response, CAPTION_MAX_BYTES));
}

/**
 * ブラウザで開いた TikTok の動画のページから、scrape の本文を作る。埋め込みデータが無ければ undefined（ふつうのページとして読む）。
 * 字幕の段落は YouTube と同じく `### 1m23s` の見出しで分ける。
 * ponytail: 長い字幕でも検索語に関係する段落を選ばない（TikTok は短い動画が多い。16 分のニュース解説で約 1 万字）。scrape の maxChars で切る
 */
export async function getTiktokPage(html: string, url: string, options: { title?: string } = {}): Promise<TiktokPage | undefined> {
  const item = readItem(html);
  if (!item) return undefined;
  const desc = cleanMarkdownTokens(item.desc ?? '').trim();
  const author = item.author?.nickname || item.author?.uniqueId
    ? `${item.author?.nickname ?? item.author?.uniqueId}${item.author?.uniqueId ? ` (@${item.author.uniqueId})` : ''}`
    : undefined;
  const createdSec = Number(item.createTime);
  const publishedTime = createdSec > 0 ? new Date(createdSec * 1000).toISOString() : undefined;
  const title = options.title || desc.split('\n')[0] || 'TikTok の動画';
  const meta = [
    author ? `- 投稿者: ${author}` : '',
    publishedTime ? `- 投稿日: ${publishedTime}` : '',
    item.video?.duration ? `- 長さ: ${item.video.duration} 秒` : '',
    `- URL: ${url}`,
  ].filter(Boolean).join('\n');
  const head = [`# ${title}`, meta, desc ? `## 説明文\n\n${desc}` : ''].filter(Boolean).join('\n\n');

  const caption = pickCaption(item);
  let transcript = `## 字幕\n\n${NO_CAPTIONS}`;
  let contentStatus: TiktokPage['contentStatus'] = 'metadata_only';
  if (caption) {
    try {
      const cues = parseWebVtt(await fetchCaptionText(caption.url));
      const paragraphs = json3ToParagraphs({ events: cues.map((c) => ({ tStartMs: c.startMs, segs: [{ utf8: c.text }] })) });
      if (paragraphs.length > 0) {
        const heading = `## 字幕（${caption.auto ? 'TikTok の自動字幕。聞き間違いを含む' : 'TikTok の字幕'}）`;
        transcript = `${heading}\n\n${paragraphs.map((p) => `### ${tLabel(p.startSec)}\n\n${p.text}`).join('\n\n')}`;
        contentStatus = 'body';
      }
    } catch (err) {
      transcript = `## 字幕\n\n${FETCH_FAILED}（${errorMessage(err) || err}）`;
    }
  }
  return { title, content: `${head}\n\n${transcript}`, description: desc ? desc.slice(0, 200) : undefined, publishedTime, author, contentStatus };
}
