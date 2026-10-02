import * as cheerio from 'cheerio';
import type { TrackingEvent, TrackingStatus } from '../types.js';

export interface RenderedTrackPage {
  title: string;
  finalUrl: string;
  bodyText: string;
  html: string;
}

export interface RenderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 本文に現れたら取得完了とみなす正規表現。空ならDOM安定まで待つ。 */
  readyMarkers?: RegExp[];
}

/** 公式追跡ページをステルスChromiumで描画する。Chromiumなしは undefined（呼び出し側が案内へフォールバック）。 */
export async function renderTrackingPage(url: string, options: RenderOptions = {}): Promise<RenderedTrackPage | undefined> {
  const { signal, timeoutMs = 25000, readyMarkers = [] } = options;
  let engine: typeof import('../../../browser_engine.js');
  let stealth: typeof import('../../../browser_stealth.js');
  try {
    engine = await import('../../../browser_engine.js');
    stealth = await import('../../../browser_stealth.js');
  } catch {
    return undefined;
  }
  if (typeof engine.resolveChromiumPath === 'function' && !engine.resolveChromiumPath()) return undefined;
  const { browser } = await engine.getBrowser();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await stealth.applyStealthEvasions(page);
    if (typeof engine.setupPageSecurity === 'function') await engine.setupPageSecurity(page, true);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    let bodyText = '';
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      try {
        bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      } catch {
        bodyText = '';
      }
      if (readyMarkers.length === 0 || readyMarkers.some((re) => re.test(bodyText))) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    let html = '';
    try {
      html = await page.content();
    } catch {
      html = '';
    }
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '';
    }
    return { title, finalUrl: page.url(), bodyText, html };
  } finally {
    await context.close().catch(() => undefined);
  }
}

const CHALLENGE_PATTERNS = [
  /access denied/i, /reference\s*id/i, /press\s*&?\s*hold/i, /verify you are (a )?human/i,
  /checking your browser/i, /just a moment/i, /attention required/i, /are you a robot/i,
  /captcha/i, /perimeterx/i, /akamai/i,
];

export function looksLikeChallenge(title: string, bodyText: string): boolean {
  const text = title + '\n' + bodyText.slice(0, 2000);
  return CHALLENGE_PATTERNS.some((re) => re.test(text));
}

/** header/footer/nav/script/style を除いた本文テキスト。キーワード判定の誤爆を抑える。 */
export function scopedBodyText(html: string): string {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, header, footer, nav, [role="navigation"], [role="contentinfo"]').remove();
    return $.text().replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 英語＋日本語の配送状態キーワード判定。not_found は呼び出し側の各社マーカーで先に判定する。 */
export function statusFromText(text: string): TrackingStatus {
  const t = text.replace(/\s+/g, ' ');
  if (!t) return 'unknown';
  const lower = t.toLowerCase();
  if (/delivered|配達完了|お届け完了|お届け済み|配達済み|配達済|受取完了|受取済/i.test(t)) return 'delivered';
  if (/out for delivery|with delivery courier|配達中|持出中/i.test(t)) return 'in_transit';
  if (/return to sender|returned|返送|返品/i.test(t)) return 'returned';
  if (/label created|shipment information received|shipping label.*created|受付|引受|集荷|pre-shipment|order processed/i.test(t)) return 'registered';
  if (/in transit|on the way|arrived|departed|processed|picked up|at (local )?facility|clearance|customs|delay|exception|held|輸送中|通過|中継|発送|出発|到着|通関|遅延|保留|保管中/i.test(t)) return 'in_transit';
  return 'unknown';
}

const HEADLINE_TERMS = [
  'delivered', 'out for delivery', 'in transit', 'on the way', 'exception', 'delay',
  '配達完了', 'お届け完了', '配達中', '持出中', '輸送中', '通関', '集荷', '引受',
];

/** 状態キーワードを含む先頭行を statusText 証拠として抜き出す。 */
export function findStatusHeadline(bodyText: string): string | undefined {
  const lowerTerms = HEADLINE_TERMS.map((t) => t.toLowerCase());
  for (const rawLine of bodyText.split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 4 || line.length > 160) continue;
    const lower = line.toLowerCase();
    if (lowerTerms.some((t) => lower.includes(t))) return line;
  }
  return undefined;
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATE_RES = [
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b`),
  /\b\d{4}\/\d{1,2}\/\d{1,2}\b/,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
  /\b\d{1,2}-\d{1,2}-\d{4}\b/,
];

/** 日付を含む行を履歴として抜き出す汎用抽出。時刻・場所の厳密対応はしない。 */
export function extractDatedEvents(bodyText: string, max = 12): TrackingEvent[] {
  const events: TrackingEvent[] = [];
  const seen = new Set<string>();
  for (const rawLine of bodyText.split('\n')) {
    if (events.length >= max) break;
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || line.length > 300) continue;
    const match = DATE_RES.map((re) => line.match(re)).find(Boolean);
    if (!match) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const status = line.replace(match[0], '').replace(/^[-–—:,;\s]+/, '').trim().slice(0, 160) || line.slice(0, 160);
    events.push({ date: match[0], status });
  }
  return events;
}
