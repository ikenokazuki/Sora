import type { Page, Browser, BrowserContext } from 'puppeteer-core';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import {
  getBrowser,
  convertHtmlToMarkdown,
  safeTruncateMarkdown,
  estimateTokens,
  DEFAULT_MAX_CHARS,
  isBlockedHostname,
  validateHostIpDns,
  setupPageSecurity,
  throttleDomain,
  applyStealthEvasions,
  bypassCloudflareTurnstile,
  browserSemaphore,
  recordBrowserUsage,
  humanMouseMove,
  pruneInvisibleElements,
  type BrowserActionStep,
  type Lease,
} from './scraper.js';
import { envBool } from './config.js';
import { errorMessage, ScrapeInputError } from './errors.js';
import { isolationLevel, type Limits, limits } from './security/limits.js';
import { browserResolvesLocally } from './net/egress.js';
import { DEFAULT_SESSION_TENANT, SessionRegistry } from './browser_session_registry.js';

const EVALUATE_FORBIDDEN = 'Forbidden: Arbitrary JavaScript execution via evaluate is disabled by security policy (set SORA_BROWSER_ALLOW_EVALUATE=true to enable)';

function hashToken(token?: string): string | undefined {
  if (!token) return undefined;
  return createHash('sha256').update(token).digest('hex');
}

function verifyOwnerToken(sessionOwnerHash?: string, requestToken?: string): boolean {
  if (!sessionOwnerHash) return true; // 所有者未設定セッションは互換性のため許可
  if (!requestToken) return false;
  const reqHash = hashToken(requestToken);
  if (!reqHash) return false;
  return timingSafeEqual(Buffer.from(sessionOwnerHash), Buffer.from(reqHash));
}

/** Session access check: owner token plus tenant binding (RFC P1-SEC-05). */
export function verifySessionAccess(
  session: { ownerTokenHash?: string; tenantId?: string },
  request: { ownerToken?: string; tenantId?: string },
): boolean {
  if (!verifyOwnerToken(session.ownerTokenHash, request.ownerToken)) return false;
  // Tenant-bound sessions reject cross-tenant access. Owner-less legacy
  // sessions stay accessible for single-user compatibility.
  if (session.tenantId && session.tenantId !== 'legacy') {
    if (!request.tenantId || request.tenantId !== session.tenantId) return false;
  }
  return true;
}

/**
 * 画像を読まずに開いたままのページで、読み込めていない <img> を読み直す（ページの状態は保つ。CSS の背景画像・Web フォントは次の遷移から）。
 * 読み直せたら true（ページ内の処理が失敗したら false。呼び出し側は次の呼び出しでもう一度読み直す）
 */
async function reloadBlockedImages(page: Page): Promise<boolean> {
  return page
    .evaluate(async () => {
      const broken = [...document.images].filter((img) => img.src && img.complete && img.naturalWidth === 0);
      for (const img of broken) img.setAttribute('src', img.src);
      await Promise.race([Promise.all(broken.map((img) => img.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
    })
    .then(
      () => true,
      () => false,
    );
}

// ==========================================
// 1. ステートフル ブラウザセッション管理
// ==========================================
export interface BrowserSession {
  id: string;
  page: Page;
  context: BrowserContext;
  dedicatedBrowser?: Browser;
  ownerTokenHash?: string;
  /** 名前の空間（登録簿の鍵）。tenant を渡さなかった呼び出しは legacy */
  tenantId: string;
  /** 画像・Web フォントを読み込まない設定のまま。あとの呼び出しで画像が要るようになったら false にする */
  blockMedia: boolean;
  /** blockMedia を外したあと、開いたままのページの画像をまだ読み直していない（読み直しが済むまで true。失敗した呼び出しをまたいで残る） */
  imagesStale?: boolean;
  lastActive: number;
  /** 作成した時刻。最長の時間（browserSessionMaxMs）は、ここから数える。使い続けても延びない */
  createdAt: number;
  /** いま使っている呼び出しの数（枠を待っている間も含む）。1 以上のセッションは、期限切れ・追い出しで閉じない */
  inUse: number;
  timer: any;
}

export interface BrowserSessionOptions {
  sessionId?: string;
  ownerToken?: string;
  tenantId?: string;
  createSession?: boolean;
  closeSession?: boolean;
  url?: string;
  actions?: BrowserActionStep[];
  extract?: {
    markdown?: boolean;
    html?: boolean;
    screenshot?: boolean;
    screenshotFullPage?: boolean;
    clipSelector?: string;
    maxChars?: number;
  };
  timeout?: number;
}

export interface BrowserSessionResult {
  source: 'browser';
  sessionId?: string;
  sessionClosed?: boolean;
  url: string;
  title: string;
  content?: string;
  html?: string;
  screenshot?: string; // base64 PNG
  estimatedTokens?: number;
  actionLogs: Array<{
    step: number;
    type: string;
    target?: string;
    success: boolean;
    message?: string;
    elapsedMs: number;
  }>;
  renderedWithBrowser: true;
}

// セッションの非アクティブ自動タイムアウト (5分)
const SESSION_TTL_MS = 5 * 60 * 1000;
/** セッション ID の長さの上限（文字数）。呼び出し側が決められる文字列なので、長さと形を縛る */
export const SESSION_ID_MAX_LENGTH = 128;

// 常駐セッションの登録簿。ID は利用者（tenant）ごとの空間で、数の上限は利用者ごとと全体（設計 6。穴 22・23）
const sessionRegistry = new SessionRegistry<BrowserSession>();

/** セッション ID の検査。長すぎる ID・制御文字を含む ID は入力の誤り（ID は鍵とログに出るので、メモリと、ログの行の偽装を防ぐ） */
export function assertSessionId(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  if (sessionId.length > SESSION_ID_MAX_LENGTH) throw new ScrapeInputError(`sessionId が長すぎます（${SESSION_ID_MAX_LENGTH} 文字まで）`);
  // 制御文字（0x00〜0x1f・0x7f）
  if ([...sessionId].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new ScrapeInputError('sessionId に制御文字は使えません');
}

/** 作成から最長の時間を過ぎたか */
const pastLifetime = (session: BrowserSession, lim: Readonly<Limits>): boolean => Date.now() - session.createdAt >= lim.browserSessionMaxMs;

/** 期限のタイマー。使っていないまま 5 分たつか、最長の時間（作成から）が来るかの、早いほうで閉じる。使用中は閉じない（使い終わりで、数え直す） */
function refreshSessionTimer(session: BrowserSession, lim: Readonly<Limits>) {
  if (session.timer) {
    clearTimeout(session.timer);
  }
  session.lastActive = Date.now();
  const untilLifetimeEnd = session.createdAt + lim.browserSessionMaxMs - Date.now();
  session.timer = setTimeout(async () => {
    if (session.inUse > 0) return;
    if (sessionRegistry.get(session.tenantId, session.id) !== session) return;
    console.log(`[Sora] Session ${session.id} expired (inactivity or lifetime). Closing...`);
    await closeBrowserSession(session.id, session.tenantId);
  }, Math.max(0, Math.min(SESSION_TTL_MS, untilLifetimeEnd)));
}

/**
 * 呼び出しが終わったあとの、セッションの扱い（inUse を戻したあとに呼ぶ）。登録簿にもう無い（持ち主が閉じた・追い出された）なら、何もしない
 * （同じ ID の新しいセッションに、触らない）。ほかの呼び出しがまだ使っているなら、何もしない（最後に終わった呼び出しが扱う）。
 * 最長の時間を過ぎていたら閉じ、そうでなければ、終わりから期限を数え直す
 */
function settleAfterUse(session: BrowserSession, lim: Readonly<Limits>): void {
  if (sessionRegistry.get(session.tenantId, session.id) !== session) return;
  if (session.inUse > 0) return; // ほかの呼び出しがまだ使っている。最後に終わった呼び出しが、数え直す
  if (pastLifetime(session, lim)) {
    void closeBrowserSession(session.id, session.tenantId);
    return;
  }
  refreshSessionTimer(session, lim);
}

/** strict では、tenant の無い（legacy）セッションを使えない（所有者を決められないので、ほかの呼び出しと区別できない） */
function assertSessionsAllowed(tenantId: string): void {
  if (tenantId === DEFAULT_SESSION_TENANT && isolationLevel() === 'strict') {
    throw new Error('Forbidden: SORA_ISOLATION=strict では、利用者を決める鍵が無い呼び出し（legacy）は、ブラウザセッションを使えません');
  }
}

/** セッションの資源（タイマー・ページ・文脈・専用ブラウザ）を閉じる。登録簿からは外さない（外してから呼ぶ） */
async function disposeSession(session: BrowserSession): Promise<void> {
  if (session.timer) {
    clearTimeout(session.timer);
  }
  try {
    await session.page.close().catch(() => {});
    if (session.dedicatedBrowser) {
      await session.dedicatedBrowser.close().catch(() => {});
    } else {
      await session.context.close().catch(() => {});
    }
  } catch (err) {
    console.warn(`[Sora] Error closing session ${session.id}:`, err);
  }
}

/** セッションのクローズ。tenant の空間の中の ID だけを引く（tenant を省くと legacy） */
export async function closeBrowserSession(sessionId: string, tenantId?: string): Promise<boolean> {
  const session = sessionRegistry.remove(tenantId, sessionId);
  if (!session) return false;
  await disposeSession(session);
  return true;
}

/** すべてのセッションをクリーンアップ */
export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.all(sessionRegistry.all().map((s) => closeBrowserSession(s.id, s.tenantId)));
}

/** アクティブセッション数の取得（作成中は含まない） */
export function getActiveSessionCount(): number {
  return sessionRegistry.size;
}

/**
 * 新しいセッションを作って、登録する（呼んだ呼び出しが使用中の状態で）。
 * 予約は同期（数の上限・同じ ID の作成中の検査と一緒）。自分の上限なら、自分の使っていない一番古いセッションを閉じる。
 * 全体がいっぱいなら、ほかの利用者のセッションは閉じずに、ここで断る。作成の途中で失敗したら、予約を取り消し、開いた文脈を閉じる（漏らさない）
 */
async function createBrowserSession(options: BrowserSessionOptions, tenantId: string, id: string, needScreenshot: boolean, lim: Readonly<Limits>): Promise<BrowserSession> {
  const evicted = sessionRegistry.reserve(tenantId, id, { perTenant: lim.browserSessionsPerTenant, total: lim.browserSessionsTotal });
  let browserInstance: Browser | undefined;
  let context: BrowserContext | undefined;
  let isDedicated = false;
  try {
    if (evicted) {
      console.log(`[Sora] Evicting least recently used browser session ${evicted.id} of ${tenantId} due to its session limit (${lim.browserSessionsPerTenant})`);
      await disposeSession(evicted);
    }
    const browserRes = await getBrowser();
    browserInstance = browserRes.browser;
    isDedicated = browserRes.isDedicated;
    // 共有ブラウザは全ページでCookieJarを共有するため、セッションごとに独立した
    context = await browserInstance.createBrowserContext();
    const page = await context.newPage();
    const created: BrowserSession = {
      id,
      page,
      context,
      dedicatedBrowser: isDedicated ? browserInstance : undefined,
      ownerTokenHash: hashToken(options.ownerToken),
      tenantId,
      blockMedia: !needScreenshot,
      lastActive: Date.now(),
      createdAt: Date.now(),
      inUse: 1,
      timer: null,
    };
    await setupPageSecurity(page, () => created.blockMedia);

    // ダイアログ (alert / confirm / prompt) の自動承認
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {}
    });

    await applyStealthEvasions(page);

    sessionRegistry.commit(created);
    return created;
  } catch (err) {
    sessionRegistry.cancel(tenantId, id);
    await (isDedicated ? browserInstance?.close() : context?.close())?.catch(() => {});
    throw err;
  }
}

/**
 * 既存のセッションを使う。所有者+テナントの検証をして（他者・他テナントのセッション操作を防止）、
 * 画像の指定なしで作ったセッションに、あとから画像が要るとき: 読み込みを有効にし、開いたままのページの画像は撮る前に読み直す
 */
function useExistingSession(existing: BrowserSession, options: BrowserSessionOptions, needScreenshot: boolean): BrowserSession {
  if (!verifySessionAccess(existing, { ownerToken: options.ownerToken, tenantId: options.tenantId })) {
    throw new Error('Forbidden: You do not have permission to access this browser session');
  }
  if (needScreenshot && existing.blockMedia) {
    existing.blockMedia = false;
    existing.imagesStale = true;
  }
  return existing;
}

/**
 * 決まっている待ち時間（ミリ秒）の見込み。assertBrowserActionInputs が、始める前に合計を数える。
 * 実行（runActionsOnPage）と同じ読み方: ms が 0 の wait は 1 秒、セレクタを待つ wait の ms を省くと 10 秒、fill・type の間隔を省くと 1 文字 20〜39ms（上限の 40ms で見込む）
 */
function declaredDurationMs(action: BrowserActionStep): number {
  switch (action.type) {
    case 'wait':
      return action.selector ? (action.ms ?? 10_000) : action.ms || 1000;
    case 'click':
      return action.delay ?? 0;
    case 'fill':
    case 'type':
      return (action.delay ?? 40) * (action.text?.length ?? 0);
    default:
      return 0;
  }
}

/** 0 以上 max 以下でない値（負の値・NaN・上限超え）。比較を「範囲の外」でなく「範囲の中でない」で書くのは、NaN を通さないため */
const outOfRange = (value: number, max: number): boolean => !(value >= 0 && value <= max);

/**
 * browser_action 1 回の入力の上限（設計 6。穴 23）。値は水準（SORA_ISOLATION）の表（security/limits.ts）。
 * 超えたら、ブラウザも枠も使う前に、入力の誤り（ScrapeInputError。REST は 400）にする。
 * 時間と文字数は、0 以上 上限以下（負の ms・delay は、決まっている待ち時間の合計を減らして、検査をすり抜けるために使える）
 */
export function assertBrowserActionInputs(
  options: { actions?: BrowserActionStep[]; timeout?: number; extract?: { maxChars?: number; clipSelector?: string } },
  lim: Readonly<Limits> = limits(),
): void {
  const actions = options.actions ?? [];
  if (actions.length > lim.browserActionCount) throw new ScrapeInputError(`actions は ${lim.browserActionCount} 個までです（${actions.length} 個）`);
  if (options.timeout !== undefined && outOfRange(options.timeout, lim.browserActionTimeoutMs)) {
    throw new ScrapeInputError(`timeout は 0〜${lim.browserActionTimeoutMs} ミリ秒です（${options.timeout}）`);
  }
  const { maxChars, clipSelector } = options.extract ?? {};
  if (maxChars !== undefined && outOfRange(maxChars, lim.browserExtractChars)) throw new ScrapeInputError(`extract.maxChars は 0〜${lim.browserExtractChars} 文字です（${maxChars}）`);
  if (clipSelector !== undefined && clipSelector.length > lim.selectorLength) throw new ScrapeInputError(`extract.clipSelector は ${lim.selectorLength} 文字までです`);
  let declaredMs = 0;
  actions.forEach((action, index) => {
    const at = `actions[${index}]（${action.type}）`;
    if (action.ms !== undefined && outOfRange(action.ms, lim.browserActionWaitMs)) throw new ScrapeInputError(`${at} の ms は 0〜${lim.browserActionWaitMs} ミリ秒です（${action.ms}）`);
    if (action.delay !== undefined && outOfRange(action.delay, lim.browserActionDelayMs)) throw new ScrapeInputError(`${at} の delay は 0〜${lim.browserActionDelayMs} ミリ秒です（${action.delay}）`);
    for (const [field, value] of [['text', action.text], ['script', action.script]] as const) {
      if (value !== undefined && value.length > lim.browserActionTextLength) throw new ScrapeInputError(`${at} の ${field} は ${lim.browserActionTextLength} 文字までです`);
    }
    if (action.selector !== undefined && action.selector.length > lim.selectorLength) throw new ScrapeInputError(`${at} の selector は ${lim.selectorLength} 文字までです`);
    declaredMs += declaredDurationMs(action);
  });
  if (declaredMs > lim.browserActionTotalMs) {
    throw new ScrapeInputError(`決まっている待ち時間の合計（${Math.ceil(declaredMs / 1000)} 秒）が、全体の制限時間（${lim.browserActionTotalMs / 1000} 秒）を超えます`);
  }
}

/** 残りの時間がこれ以下（ミリ秒）なら、次のアクションを始めない（タイマーの誤差で、残りが少し残っても、始めないため） */
const DEADLINE_SLACK_MS = 5;

/**
 * 単一ページに対するアクションシーケンスの実行。deadline（Date.now() の絶対時刻）を過ぎたら、残りのアクションは実行しない。
 * 待ちとページ遷移の待ちは、残りの時間で切る（締め切りを渡さなければ、制限しない）
 */
export async function runActionsOnPage(
  page: Page,
  actions: BrowserActionStep[],
  timeoutMs: number,
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<{ actionLogs: any[]; finalUrl: string; title: string }> {
  const actionLogs: any[] = [];
  let stepIndex = 1;
  const remaining = () => deadline - Date.now();
  /** セレクタを待つ時間（既定 10 秒）を、残りの時間で切る。0 は「待たない」でなく「制限なし」なので、最低 1ms */
  const selectorTimeout = (ms = 10_000) => Math.max(1, Math.min(ms, remaining()));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, remaining()))));
  const viewport = page.viewport();
  let mouseX = (viewport?.width ?? 1920) * (0.3 + Math.random() * 0.4);
  let mouseY = (viewport?.height ?? 1080) * (0.3 + Math.random() * 0.4);

  for (const action of actions) {
    if (remaining() <= DEADLINE_SLACK_MS) {
      actionLogs.push({
        step: stepIndex++,
        type: action.type,
        target: action.selector || action.text || action.key || action.url,
        success: false,
        message: '全体の制限時間を超えたので、実行しませんでした',
        elapsedMs: 0,
      });
      continue;
    }
    const stepStart = performance.now();
    try {
      switch (action.type) {
        case 'click': {
          let box: { x: number; y: number } | null = null;
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: selectorTimeout() });
            box = await page.$eval(action.selector, (el: any) => {
              el.scrollIntoView?.({ behavior: 'instant', block: 'center' });
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
          } else if (action.text) {
            box = await page.evaluate((btnText: string) => {
              // 1. インタラクティブ要素を最優先
              const interactiveSelectors =
                'button, a, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]';
              const interactives: any[] = Array.from(document.querySelectorAll(interactiveSelectors));

              let target = interactives.find(
                (el) => el.textContent?.trim() === btnText || el.value?.trim() === btnText,
              );
              if (!target) {
                target = interactives.find(
                  (el) => el.textContent?.trim().includes(btnText) || el.value?.includes(btnText),
                );
              }

              // 2. 末端の要素
              if (!target) {
                const all: any[] = Array.from(document.querySelectorAll('span, label, p, div, li, td'));
                const leaves = all.filter((el) => el.children.length === 0);
                target =
                  leaves.find((el) => el.textContent?.trim() === btnText) ||
                  leaves.find((el) => el.textContent?.trim().includes(btnText));
              }

              if (target) {
                target.scrollIntoView?.({ behavior: 'instant', block: 'center' });
                target.focus?.();
                const r = target.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
              return null;
            }, action.text);
            if (!box) throw new Error(`Element containing text "${action.text}" not found`);
          } else {
            throw new Error('Click action requires selector or text');
          }
          await humanMouseMove(page, mouseX, mouseY, box.x, box.y);
          mouseX = box.x;
          mouseY = box.y;
          await page.mouse.down();
          await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
          await page.mouse.up();
          if (action.delay) await sleep(action.delay);
          break;
        }
        case 'fill':
        case 'type': {
          if (!action.selector) throw new Error('Fill action requires selector');
          await page.waitForSelector(action.selector, { timeout: selectorTimeout() });
          if (action.clear !== false) {
            await page.click(action.selector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
          }
          const humanDelay = action.delay ?? Math.floor(Math.random() * 20 + 20);
          await page.type(action.selector, action.text ?? '', { delay: humanDelay });
          await new Promise((r) => setTimeout(r, 50));
          break;
        }
        case 'press': {
          if (!action.key) throw new Error('Press action requires key');
          await page.keyboard.press(action.key as any);
          await new Promise((r) => setTimeout(r, 50));
          break;
        }
        case 'select': {
          if (!action.selector || action.value === undefined) {
            throw new Error('Select action requires selector and value');
          }
          await page.waitForSelector(action.selector, { timeout: selectorTimeout() });
          await page.select(action.selector, action.value);
          await new Promise((r) => setTimeout(r, 50));
          break;
        }
        case 'scroll': {
          const distance = action.distance ?? 800;
          const direction = action.direction === 'up' ? -distance : distance;
          await page.evaluate((d: number) => {
            window.scrollBy({ top: d, behavior: 'smooth' });
          }, direction);
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
        case 'wait': {
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: selectorTimeout(action.ms) });
          } else if (action.ms) {
            await sleep(action.ms);
          } else {
            await sleep(1000);
          }
          break;
        }
        case 'evaluate': {
          if (!envBool('SORA_BROWSER_ALLOW_EVALUATE')) {
            throw new Error(EVALUATE_FORBIDDEN);
          }
          if (!action.script) throw new Error('Evaluate action requires script');
          await page.evaluate(action.script);
          break;
        }
        case 'navigate': {
          if (!action.url) throw new Error('Navigate action requires url');
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(action.url);
          } catch {
            throw new Error(`Invalid URL: ${action.url}`);
          }
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`Forbidden protocol: ${parsedUrl.protocol}`);
          }
          if (!envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK')) {
            await validateHostIpDns(parsedUrl.hostname, { failClosed: browserResolvesLocally(parsedUrl.hostname) });
          }
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(timeoutMs, remaining())) });
          await bypassCloudflareTurnstile(page);
          await new Promise((r) => setTimeout(r, 300));
          break;
        }
        case 'screenshot': {
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: selectorTimeout() });
          }
          break;
        }
        default:
          throw new Error(`Unsupported action type: ${(action as any).type}`);
      }

      actionLogs.push({
        step: stepIndex++,
        type: action.type,
        target: action.selector || action.text || action.key || action.url || action.script,
        success: true,
        elapsedMs: Math.round(performance.now() - stepStart),
      });
    } catch (actErr) {
      actionLogs.push({
        step: stepIndex++,
        type: action.type,
        target: action.selector || action.text || action.key || action.url,
        success: false,
        message: errorMessage(actErr) || String(actErr),
        elapsedMs: Math.round(performance.now() - stepStart),
      });
    }
  }

  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  return { actionLogs, finalUrl, title };
}

// ==========================================
// 2. メイン実行エントリーポイント (ワンショット & セッション両対応)
// ==========================================
export async function handleBrowserSessionAction(
  options: BrowserSessionOptions,
  /** 入力と時間の上限。既定は、水準（SORA_ISOLATION）の表 */
  lim: Readonly<Limits> = limits(),
): Promise<BrowserSessionResult> {
  const timeoutMs = options.timeout ?? 30000;
  const actions = options.actions ?? [];
  const extract = options.extract ?? { markdown: true };
  const maxChars = extract.maxChars ?? DEFAULT_MAX_CHARS;

  // 0. セッション ID の形（設計 6。穴 23）
  assertSessionId(options.sessionId);

  // 1. セッション終了リクエストの処理（引くのは、呼んだ利用者の空間の中だけ）
  if (options.closeSession && options.sessionId) {
    const existing = sessionRegistry.get(options.tenantId, options.sessionId);
    if (existing && !verifySessionAccess(existing, { ownerToken: options.ownerToken, tenantId: options.tenantId })) {
      throw new Error('Forbidden: You do not have permission to access this browser session');
    }
    const closed = await closeBrowserSession(options.sessionId, options.tenantId);
    return {
      source: 'browser',
      sessionId: options.sessionId,
      sessionClosed: closed,
      url: '',
      title: '',
      actionLogs: [],
      renderedWithBrowser: true,
    };
  }

  // 1.0 入力の上限（設計 6。穴 23）。ブラウザも枠も使う前に断る
  assertBrowserActionInputs(options, lim);

  // 1.1 evaluate アクションの事前検証 (SORA_BROWSER_ALLOW_EVALUATE が真でないときの早期防御)
  if (!envBool('SORA_BROWSER_ALLOW_EVALUATE') && actions.some((a) => a.type === 'evaluate')) {
    const actionLogs = actions.map((act, idx) => {
      if (act.type === 'evaluate') {
        return {
          step: idx + 1,
          type: act.type,
          target: act.script,
          success: false,
          message: EVALUATE_FORBIDDEN,
          elapsedMs: 0,
        };
      }
      return {
        step: idx + 1,
        type: act.type,
        target: act.selector || act.text || act.url,
        success: false,
        message: 'Skipped due to prior policy block',
        elapsedMs: 0,
      };
    });

    return {
      source: 'browser',
      url: options.url || '',
      title: '',
      actionLogs,
      renderedWithBrowser: true,
    };
  }

  const needScreenshot = Boolean(
    options.extract?.screenshot ||
    options.extract?.clipSelector ||
    options.actions?.some((a) => a.type === 'screenshot')
  );
  const isStateful = Boolean(options.sessionId || options.createSession);
  let session: BrowserSession | undefined;
  let isDedicated = false;
  let page: Page;
  let browserInstance: Browser | undefined;
  let context: BrowserContext | undefined;
  /** ワンショット実行が持つ枠（実行の終わりまで持つ）。セッション作成の枠は、作成の間だけ持つ */
  let oneShotLease: Lease | undefined;

  /** ステートフルな呼び出しが持つ枠（呼び出しの終わりまで持つ） */
  let statefulLease: Lease | undefined;
  /** この呼び出しが使用中にしたセッション（inUse を足したもの）。終わりで戻す */
  let using: BrowserSession | undefined;
  /** ステートフルな呼び出しの終わり（失敗も含む）: 枠を戻し、使用中の印を外し、期限を数え直す（最長の時間を過ぎていたら閉じる） */
  const endStatefulUse = () => {
    statefulLease?.();
    statefulLease = undefined;
    if (using) {
      using.inUse--;
      settleAfterUse(using, lim);
      using = undefined;
    }
  };

  if (isStateful) {
    // 既存セッションの取得または新規作成。ID は、呼んだ利用者の空間の中だけで引く
    const tenantId = options.tenantId || DEFAULT_SESSION_TENANT;
    assertSessionsAllowed(tenantId);
    const requestedId = options.sessionId || `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      let existing = options.sessionId ? sessionRegistry.get(tenantId, options.sessionId) : undefined;
      if (existing && existing.inUse === 0 && pastLifetime(existing, lim)) {
        // 最長の時間を過ぎた、使っていないセッション。閉じて、新しく作る（期限のタイマーを待たない）
        await closeBrowserSession(existing.id, tenantId);
        existing = undefined;
      }
      if (existing) {
        // 所有者+テナントの検証のあと、使用中にする（枠を待つ間も、期限切れ・追い出しで閉じない）
        using = existing = useExistingSession(existing, options, needScreenshot);
        existing.inUse++;
      }
      // 作成済みでも新規でも、枠の下で動く（ワンショットと同じ。呼び出しの終わりまで持つ）。枠を断られたら、ここで例外
      statefulLease = await browserSemaphore.acquire(tenantId);
      recordBrowserUsage();
      if (existing && sessionRegistry.get(tenantId, existing.id) !== existing) {
        // 枠を待つ間に、持ち主の closeSession で閉じられた。見つからないときと同じに、新しく作る
        existing.inUse--;
        existing = undefined;
        using = undefined;
      }
      if (!existing && options.sessionId) {
        // 枠を待つ間に、同じ ID のセッションが作られていたら、それを使う。同じ ID の作成が走っているなら、終わるのを待って、引き直す
        // （同じ ID の同時の呼び出し。空いている枠の数に左右されずに、同じ結果になる。先の作成が失敗したら、自分で作る）
        existing = sessionRegistry.get(tenantId, options.sessionId);
        for (let waiting = sessionRegistry.pending(tenantId, options.sessionId); !existing && waiting; waiting = sessionRegistry.pending(tenantId, options.sessionId)) {
          await waiting;
          existing = sessionRegistry.get(tenantId, options.sessionId);
        }
        if (existing) {
          using = existing = useExistingSession(existing, options, needScreenshot);
          existing.inUse++;
        }
      }
      session = existing ?? (using = await createBrowserSession(options, tenantId, requestedId, needScreenshot, lim));
      page = session.page;
      refreshSessionTimer(session, lim);
    } catch (err) {
      endStatefulUse();
      throw err;
    }
  } else {
    // ワンショット実行（セッション管理なし・即破棄）
    oneShotLease = await browserSemaphore.acquire(options.tenantId);
    recordBrowserUsage();
    try {
      const browserRes = await getBrowser();
      browserInstance = browserRes.browser;
      isDedicated = browserRes.isDedicated;
      context = await browserInstance.createBrowserContext();
      page = await context.newPage();
      await setupPageSecurity(page, !needScreenshot);

      // ダイアログ (alert / confirm / prompt) の自動承認
      page.on('dialog', async (dialog) => {
        try {
          await dialog.accept();
        } catch {}
      });

      await applyStealthEvasions(page);
    } catch (err) {
      oneShotLease?.();
      throw err;
    }
  }

  try {
    // 全体の時間の締め切り。ブラウザとページの用意が済んだあと、最初の URL への遷移の前から数える（枠を待った時間・ブラウザの用意の時間は数えない。最初の遷移は数える）
    const deadline = Date.now() + lim.browserActionTotalMs;
    // 初期 URL が指定されている場合、ページ遷移を実行
    if (options.url) {
      if (!envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK') && isBlockedHostname(new URL(options.url).hostname)) {
        throw new Error(`Access to private or blocked host is forbidden: ${options.url}`);
      }
      const currentUrl = page.url();
      if (!currentUrl || currentUrl === 'about:blank' || currentUrl !== options.url) {
        await throttleDomain(new URL(options.url).hostname);
        await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())) });
        await bypassCloudflareTurnstile(page);
        // SPA hydration 安定化
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // アクションの実行
    const { actionLogs, finalUrl, title } = await runActionsOnPage(page, actions, timeoutMs, deadline);

    // セッションクローズ指定があった場合は即座に閉じて返却
    if (options.closeSession) {
      if (session) await closeBrowserSession(session.id, session.tenantId);
      return {
        source: 'browser',
        sessionId: session?.id,
        sessionClosed: true,
        url: finalUrl,
        title,
        actionLogs,
        renderedWithBrowser: true,
      };
    }

    if (session?.imagesStale && (await reloadBlockedImages(page))) session.imagesStale = false;

    // データの抽出
    let content: string | undefined;
    let html: string | undefined;
    let screenshot: string | undefined;

    if (extract.html || extract.markdown !== false) {
      await pruneInvisibleElements(page);
    }

    if (extract.html) {
      html = await page.content().catch(() => '');
    }

    if (extract.markdown !== false) {
      const rawHtml = html || (await page.content().catch(() => ''));
      if (rawHtml) {
        const { markdown } = convertHtmlToMarkdown(rawHtml, finalUrl, maxChars, true);
        content = safeTruncateMarkdown(markdown, maxChars);
      }
    }

    const estimatedTokens = content ? estimateTokens(content) : undefined;

    if (extract.screenshot || extract.clipSelector) {
      if (extract.clipSelector) {
        try {
          const el = await page.$(extract.clipSelector);
          if (el) {
            screenshot = (await el.screenshot({
              type: 'png',
              encoding: 'base64',
            })) as string;
          }
        } catch {}
      }
      if (!screenshot && extract.screenshot) {
        try {
          const isFull = extract.screenshotFullPage ?? true;
          if (isFull) {
            await page.evaluate(async () => {
              const maxScroll = Math.min(document.body.scrollHeight, 15000);
              const step = 800;
              for (let y = 0; y < maxScroll; y += step) {
                window.scrollTo(0, y);
                await new Promise((r) => setTimeout(r, 40));
              }
              window.scrollTo(0, 0);
            });
            await new Promise((r) => setTimeout(r, 150));
          }
          screenshot = (await page.screenshot({
            fullPage: isFull,
            type: 'png',
            encoding: 'base64',
          })) as string;
        } catch {
          try {
            screenshot = (await page.screenshot({
              fullPage: false,
              type: 'png',
              encoding: 'base64',
            })) as string;
          } catch {}
        }
      }
    }

    return {
      source: 'browser',
      sessionId: session?.id,
      sessionClosed: false,
      url: finalUrl,
      title,
      content,
      html,
      screenshot,
      estimatedTokens,
      actionLogs,
      renderedWithBrowser: true,
    };
  } finally {
    // ワンショット実行の場合は必ずクリーンアップ & セマフォ解放
    if (!isStateful) {
      try {
        await page.close().catch(() => {});
        if (isDedicated && browserInstance) {
          await browserInstance.close().catch(() => {});
        } else if (context) {
          await context.close().catch(() => {});
        }
      } finally {
        oneShotLease?.();
      }
    } else {
      endStatefulUse();
    }
  }
}
