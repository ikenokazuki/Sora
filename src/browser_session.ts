import type { Page, Browser } from 'puppeteer-core';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import {
  getBrowser,
  USER_AGENT,
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
  type BrowserActionStep,
} from './scraper.js';

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

// ==========================================
// 1. ステートフル ブラウザセッション管理
// ==========================================
export interface BrowserSession {
  id: string;
  page: Page;
  dedicatedBrowser?: Browser;
  ownerTokenHash?: string;
  lastActive: number;
  timer: any;
}

export interface BrowserSessionOptions {
  sessionId?: string;
  ownerToken?: string;
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
  proxyUrl?: string;
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
// 同時保持可能な最大アクティブセッション数 (メモリ枯渇・リーク防止)
export const MAX_ACTIVE_SESSIONS = 20;

// 常駐セッションストア
const activeSessions = new Map<string, BrowserSession>();

/** セッションタイマーのリセット */
function refreshSessionTimer(session: BrowserSession) {
  if (session.timer) {
    clearTimeout(session.timer);
  }
  session.lastActive = Date.now();
  session.timer = setTimeout(async () => {
    console.log(`[Sora] Session ${session.id} expired due to inactivity. Closing...`);
    await closeBrowserSession(session.id);
  }, SESSION_TTL_MS);
}

/** 最も古いアクティブセッションを退避・クローズ (LRU) */
async function evictOldestSessionIfNeeded(): Promise<void> {
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of activeSessions.entries()) {
      if (s.lastActive < oldestTime) {
        oldestTime = s.lastActive;
        oldestId = id;
      }
    }
    if (oldestId) {
      console.log(`[Sora] Evicting oldest browser session ${oldestId} due to capacity limit (${MAX_ACTIVE_SESSIONS})`);
      await closeBrowserSession(oldestId);
    }
  }
}

/** セッションのクローズ */
export async function closeBrowserSession(sessionId: string): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  if (session.timer) {
    clearTimeout(session.timer);
  }

  activeSessions.delete(sessionId);

  try {
    await session.page.close().catch(() => {});
    if (session.dedicatedBrowser) {
      await session.dedicatedBrowser.close().catch(() => {});
    }
  } catch (err) {
    console.warn(`[Sora] Error closing session ${sessionId}:`, err);
  }

  return true;
}

/** すべてのセッションをクリーンアップ */
export async function closeAllBrowserSessions(): Promise<void> {
  const sessionIds = Array.from(activeSessions.keys());
  await Promise.all(sessionIds.map((id) => closeBrowserSession(id)));
}

/** アクティブセッション数の取得 */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}

/** 単一ページに対するアクションシーケンスの実行 */
async function runActionsOnPage(
  page: Page,
  actions: BrowserActionStep[],
  timeoutMs: number,
): Promise<{ actionLogs: any[]; finalUrl: string; title: string }> {
  const actionLogs: any[] = [];
  let stepIndex = 1;

  for (const action of actions) {
    const stepStart = performance.now();
    try {
      switch (action.type) {
        case 'click': {
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: 10000 });
            await page.click(action.selector);
          } else if (action.text) {
            const clicked = await page.evaluate((btnText: string) => {
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
                target.click();
                return true;
              }
              return false;
            }, action.text);
            if (!clicked) throw new Error(`Element containing text "${action.text}" not found`);
          } else {
            throw new Error('Click action requires selector or text');
          }
          if (action.delay) await new Promise((r) => setTimeout(r, action.delay));
          break;
        }
        case 'fill':
        case 'type': {
          if (!action.selector) throw new Error('Fill action requires selector');
          await page.waitForSelector(action.selector, { timeout: 10000 });
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
          await page.waitForSelector(action.selector, { timeout: 10000 });
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
            await page.waitForSelector(action.selector, { timeout: action.ms ?? 10000 });
          } else if (action.ms) {
            await new Promise((r) => setTimeout(r, action.ms));
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
          break;
        }
        case 'evaluate': {
          if (process.env.ALLOW_BROWSER_EVALUATE !== 'true') {
            throw new Error('Forbidden: Arbitrary JavaScript execution via evaluate is disabled by security policy (set ALLOW_BROWSER_EVALUATE=true to enable)');
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
          if (process.env.ALLOW_LOCAL_FETCH !== 'true') {
            await validateHostIpDns(parsedUrl.hostname);
          }
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          await bypassCloudflareTurnstile(page);
          await new Promise((r) => setTimeout(r, 300));
          break;
        }
        case 'screenshot': {
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: 10000 });
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
    } catch (actErr: any) {
      actionLogs.push({
        step: stepIndex++,
        type: action.type,
        target: action.selector || action.text || action.key || action.url,
        success: false,
        message: actErr?.message || String(actErr),
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
): Promise<BrowserSessionResult> {
  const timeoutMs = options.timeout ?? 30000;
  const actions = options.actions ?? [];
  const extract = options.extract ?? { markdown: true };
  const maxChars = extract.maxChars ?? DEFAULT_MAX_CHARS;

  // 1. セッション終了リクエストの処理
  if (options.closeSession && options.sessionId) {
    const closed = await closeBrowserSession(options.sessionId);
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

  const isStateful = Boolean(options.sessionId || options.createSession);
  let session: BrowserSession | undefined;
  let isDedicated = false;
  let page: Page;
  let browserInstance: Browser | undefined;

  if (isStateful) {
    // 既存セッションの取得または新規作成
    const requestedId = options.sessionId || `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (options.sessionId && activeSessions.has(options.sessionId)) {
      session = activeSessions.get(options.sessionId)!;
      // セッション所有者の検証 (他者のセッション操作を防止)
      if (!verifyOwnerToken(session.ownerTokenHash, options.ownerToken)) {
        throw new Error('Forbidden: You do not have permission to access this browser session');
      }
      page = session.page;
    } else {
      // 新規セッションの初期化 (上限超過時は最古セッションを退避)
      await evictOldestSessionIfNeeded();

      await browserSemaphore.acquire();
      try {
        const browserRes = await getBrowser(options.proxyUrl);
        browserInstance = browserRes.browser;
        isDedicated = browserRes.isDedicated;
        page = await browserInstance.newPage();
        await setupPageSecurity(page);

        // ダイアログ (alert / confirm / prompt) の自動承認
        page.on('dialog', async (dialog) => {
          try {
            await dialog.accept();
          } catch {}
        });

        await applyStealthEvasions(page);

        session = {
          id: requestedId,
          page,
          dedicatedBrowser: isDedicated ? browserInstance : undefined,
          ownerTokenHash: hashToken(options.ownerToken),
          lastActive: Date.now(),
          timer: null,
        };
        activeSessions.set(requestedId, session);
      } finally {
        browserSemaphore.release();
      }
    }
    refreshSessionTimer(session);
  } else {
    // ワンショット実行（セッション管理なし・即破棄）
    await browserSemaphore.acquire();
    try {
      const browserRes = await getBrowser(options.proxyUrl);
      browserInstance = browserRes.browser;
      isDedicated = browserRes.isDedicated;
      page = await browserInstance.newPage();
      await setupPageSecurity(page);

      // ダイアログ (alert / confirm / prompt) の自動承認
      page.on('dialog', async (dialog) => {
        try {
          await dialog.accept();
        } catch {}
      });

      await applyStealthEvasions(page);
    } catch (err) {
      browserSemaphore.release();
      throw err;
    }
  }

  try {
    // 初期 URL が指定されている場合、ページ遷移を実行
    if (options.url) {
      if (process.env.ALLOW_LOCAL_FETCH !== 'true' && isBlockedHostname(new URL(options.url).hostname)) {
        throw new Error(`Access to private or blocked host is forbidden: ${options.url}`);
      }
      const currentUrl = page.url();
      if (!currentUrl || currentUrl === 'about:blank' || currentUrl !== options.url) {
        await throttleDomain(new URL(options.url).hostname);
        await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await bypassCloudflareTurnstile(page);
        // SPA hydration 安定化
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // アクションの実行
    const { actionLogs, finalUrl, title } = await runActionsOnPage(page, actions, timeoutMs);

    // セッションクローズ指定があった場合は即座に閉じて返却
    if (options.closeSession) {
      if (session) await closeBrowserSession(session.id);
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

    // データの抽出
    let content: string | undefined;
    let html: string | undefined;
    let screenshot: string | undefined;

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
          screenshot = (await page.screenshot({
            fullPage: extract.screenshotFullPage ?? false,
            type: 'png',
            encoding: 'base64',
          })) as string;
        } catch {}
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
        }
      } finally {
        browserSemaphore.release();
      }
    }
  }
}
