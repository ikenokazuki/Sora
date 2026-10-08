import type { Page, CookieParam, Protocol } from 'puppeteer-core';
import type { PersistedCookie } from './db.js';
import { DEFAULT_MAX_CHARS } from './types.js';
import {
  browserSemaphore,
  getBrowser,
  pruneInvisibleElements,
  recordBrowserUsage,
  resolveChromiumPath,
  setupPageSecurity,
} from './browser_engine.js';
import {
  dbGetTenantCookies,
  dbGetTenantStorage,
  dbSaveDomainCookies,
  dbSaveTenantStorage,
} from './db.js';
import { ACCEPT_LANGUAGE, groupCookiesByDomain, pickBrowserProfile, throttleDomain } from './http_fetcher.js';
import { enrichTimeTreeHtml, waitForTimeTreeResponses } from './timetree.js';

export const PORT = parseInt(process.env.PORT || '8000', 10);

/** 実行中のChromiumのバージョンすら取得できなかった場合の最終フォールバック。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function getFallbackUserAgent(): string {
  const major = getAlignedChromeMajorVersion();
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
}

/**
 * 両経路で名乗る Chrome メジャーバージョン。
 * 静的fetchは wreq-js のプロファイル上限に張り付くため、
 * ブラウザ側も同じ値に揃えないと同一 Cookie で別バージョンを名乗る。
 */
export function getAlignedChromeMajorVersion(): string {
  const m = pickBrowserProfile().match(/chrome_(\d+)/);
  return m ? m[1] : '128';
}

export function buildUserAgentFromDefault(defaultUa: string): string {
  const match = defaultUa.match(/(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const alignedMajor = getAlignedChromeMajorVersion();
  const version = match ? match[1].replace(/^\d+/, alignedMajor) : alignedMajor + '.0.0.0';
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + version + ' Safari/537.36';
}

export function buildUserAgentMetadata(defaultUa: string): Protocol.Emulation.UserAgentMetadata {
  const match = defaultUa.match(/(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const alignedMajor = getAlignedChromeMajorVersion();
  const fullVersion = match ? match[1].replace(/^\d+/, alignedMajor) : alignedMajor + '.0.0.0';
  const majorVersion = fullVersion.split('.')[0];
  return {
    brands: [
      { brand: 'Not)A;Brand', version: '99' },
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
    ],
    fullVersionList: [
      { brand: 'Not)A;Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
    ],
    fullVersion,
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

export function patchWebRtcIpLeak(): void {
  const isRealIpCandidate = (candidate: string): boolean => {
    const m = candidate.match(/^candidate:\S+ \d+ udp \d+ (\S+) \d+ typ (host|srflx)/);
    if (!m) return false;
    const ip = m[1];
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip !== '0.0.0.0';
  };

  const NativeRTCPeerConnection = (globalThis as any).RTCPeerConnection;
  if (!NativeRTCPeerConnection) return;
  const proto = NativeRTCPeerConnection.prototype;

  const origAddEventListener = proto.addEventListener;
  proto.addEventListener = function (this: any, type: string, listener: any, options?: any) {
    if (type !== 'icecandidate' || typeof listener !== 'function') {
      return origAddEventListener.call(this, type, listener, options);
    }
    const wrapped = function (this: any, event: any) {
      if (event.candidate && isRealIpCandidate(event.candidate.candidate)) return;
      return listener.call(this, event);
    };
    return origAddEventListener.call(this, type, wrapped, options);
  };

  const nativeDescriptor = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  if (nativeDescriptor?.set && nativeDescriptor.get) {
    Object.defineProperty(proto, 'onicecandidate', {
      configurable: true,
      enumerable: nativeDescriptor.enumerable,
      get: nativeDescriptor.get,
      set(this: any, handler: any) {
        if (typeof handler !== 'function') {
          return nativeDescriptor.set!.call(this, handler);
        }
        const wrapped = function (this: any, event: any) {
          if (event.candidate && isRealIpCandidate(event.candidate.candidate)) return;
          return handler.call(this, event);
        };
        return nativeDescriptor.set!.call(this, wrapped);
      },
    });
  }
}

export const VIEWPORT_WIDTH = 1920;
export const VIEWPORT_HEIGHT = 1080;
export const STEALTH_LOCALE = 'ja-JP';

export async function applyNativeEmulationOverrides(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: VIEWPORT_WIDTH,
      screenHeight: VIEWPORT_HEIGHT,
    });
    await client.send('Emulation.setLocaleOverride', { locale: STEALTH_LOCALE });
  } catch {}
}

export function patchCanvasFingerprint(): void {
  const seed = Math.random() * 10000;
  const proto = (globalThis as any).CanvasRenderingContext2D?.prototype;
  if (!proto?.getImageData) return;

  const originalGetImageData = proto.getImageData;
  proto.getImageData = function (this: any, ...args: any[]) {
    const imageData = originalGetImageData.apply(this, args);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const pseudoRandom = Math.abs(Math.sin(seed * (i + 1))) % 1;
      if (pseudoRandom < 0.02) {
        data[i] = data[i] ^ 1;
      }
    }
    return imageData;
  };
}

export async function applyStealthEvasions(page: Page): Promise<void> {
  try {
    const defaultUa = await page.browser().userAgent();
    await page.setUserAgent(buildUserAgentFromDefault(defaultUa), buildUserAgentMetadata(defaultUa));
  } catch {
    const fallbackUa = getFallbackUserAgent();
    await page.setUserAgent(fallbackUa, buildUserAgentMetadata(fallbackUa));
  }
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await applyNativeEmulationOverrides(page);
  await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    (globalThis as any).chrome = {
      runtime: {},
      app: {},
      csi: () => {},
      loadTimes: () => {},
    };
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
    });
    Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
      get: () => 'Win32',
      configurable: true,
    });
  });
  await page.evaluateOnNewDocument(patchWebRtcIpLeak);
  await page.evaluateOnNewDocument(patchCanvasFingerprint);
}

export async function bypassCloudflareTurnstile(page: Page, timeoutMs = 10000): Promise<boolean> {
  try {
    const turnstileIframe = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', {
      timeout: Math.min(timeoutMs, 5000),
    });
    if (turnstileIframe) {
      const frame = await turnstileIframe.contentFrame();
      if (frame) {
        const checkbox = await frame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage');
        if (checkbox) {
          await checkbox.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
          return true;
        }
      }
    }
  } catch {}
  return false;
}

export async function humanMouseMove(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  const steps = 12 + Math.floor(Math.random() * 10);
  const ctrlX = fromX + (toX - fromX) * 0.5 + (Math.random() - 0.5) * 80;
  const ctrlY = fromY + (toY - fromY) * 0.5 + (Math.random() - 0.5) * 80;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = (1 - eased) ** 2 * fromX + 2 * (1 - eased) * eased * ctrlX + eased ** 2 * toX;
    const y = (1 - eased) ** 2 * fromY + 2 * (1 - eased) * eased * ctrlY + eased ** 2 * toY;
    await page.mouse.move(x, y);
    if (i < steps) await new Promise((r) => setTimeout(r, 3 + Math.random() * 7));
  }
}

export async function autoScrollPage(page: Page, maxScrolls = 8): Promise<void> {
  try {
    await page.evaluate(async (limit: number) => {
      const step = window.innerHeight;
      let lastHeight = 0;
      for (let i = 0; i < limit; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 80));
        const height = document.body.scrollHeight;
        if (window.scrollY + window.innerHeight >= height && height === lastHeight) break;
        lastHeight = height;
      }
      window.scrollTo(0, 0);
    }, maxScrolls);
  } catch {}
}

export async function waitForDomStable(page: Page, quietMs = 800, timeoutMs = 5000): Promise<void> {
  try {
    await page.evaluate(
      async (quiet: number, limit: number) => {
        const start = Date.now();
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        if (!doc) return;

        // 「見えている本文」が変わった時刻を追跡する。属性だけを書き換え続けるページ
        // （多言語化ウィジェット・計測タグ等）で静止しないまま上限まで待たないため、DOM 変化そのものは見ない。
        // ponytail: 画像の src 書き換えは検知しない（個数の増減のみ）。data-src/srcset の遅延読み込みは HTML 解析側
        // （resolveImageUrl）で実 URL に解決される。JS で URL を組み立てる遅延読み込みが問題になれば、実 src の数を署名に加える。
        const signature = (t: string) => {
          const n = t.length;
          const mid = n >> 1;
          return `${n}|${doc?.images?.length ?? 0}|${t.slice(0, 120)}|${t.slice(mid, mid + 120)}|${t.slice(-120)}`;
        };
        let lastSignature = signature((doc?.body?.innerText ?? '').trim());
        let lastChange = Date.now();

        const loadingSelectors = [
          '.loading',
          '.spinner',
          '.skeleton',
          '[aria-busy="true"]',
          '[role="progressbar"]',
          '.is-loading',
          '.loading__spinner',
          '.loading__content',
        ];

        while (Date.now() - start < limit) {
          let hasVisibleLoading = false;
          if (win) {
            for (const sel of loadingSelectors) {
              const elements = doc.querySelectorAll(sel);
              for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const style = win.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  hasVisibleLoading = true;
                  break;
                }
              }
              if (hasVisibleLoading) break;
            }
          }

          const bodyText = (doc?.body?.innerText ?? '').trim();
          const mainText = (doc?.querySelector('article, main, [role="main"]')?.innerText ?? bodyText).trim();
          const isLoadingText = (text: string) => /^(?:(?:now\s+)?loading|読み込み中|読込中)[\s.…。]*$/i.test(text);
          hasVisibleLoading ||= !bodyText || isLoadingText(bodyText) || isLoadingText(mainText);
          const hasMainContent = Boolean(
            mainText || bodyText.length >= 400
          );

          // メインコンテンツが存在しローディングスピナーが消えている場合は 200ms の静止で即座に完了
          // それ以外でも 400ms または指定された quietMs の短い方で完了
          const effectiveQuiet = hasVisibleLoading
            ? quiet
            : hasMainContent
            ? Math.min(quiet, 200)
            : Math.min(quiet, 400);

          const current = signature(bodyText);
          if (current !== lastSignature) {
            lastSignature = current;
            lastChange = Date.now();
          }

          if (!hasVisibleLoading && Date.now() - lastChange >= effectiveQuiet) {
            return;
          }

          await new Promise((r) => setTimeout(r, 50));
        }
      },
      quietMs,
      timeoutMs,
    );
  } catch {}
}

export async function inlineShadowDomContent(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const MARKER = 'data-sora-shadow-copy';
      const walk = (root: Document | ShadowRoot) => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as any).shadowRoot as ShadowRoot | null;
          if (!sr) continue;
          walk(sr);
          const copy = el.querySelector(`:scope > [${MARKER}]`) || document.createElement('div');
          copy.setAttribute(MARKER, '');
          copy.innerHTML = sr.innerHTML;
          el.appendChild(copy);
        }
      };
      walk(document);
    });
  } catch {}
}



/** 通信静止（networkidle）を待つ上限。超えたら現在の DOM で本文取得へ進む。 */
const NETWORK_IDLE_CAP_MS = 5000;

/**
 * Stealth Chromium レンダリング
 */
export async function fetchWithStealthBrowser(
  url: string,
  timeoutMs = 30000,
  clipSelector?: string,
  customCookies?: CookieParam[],
  waitUntil: 'networkidle0' | 'networkidle2' = 'networkidle2',
  needScreenshot = false,
  fullPage = true,
  tenantId = 'legacy',
  readiness?: { isContentReady: (html: string, finalUrl: string) => boolean; onWait?: () => void },
): Promise<{ html: string; title: string; screenshot?: string; finalUrl: string }> {
  const chromePath = resolveChromiumPath();
  if (!chromePath) {
    throw new Error('Chromium/Chrome が見つからないためブラウザレンダリングを実行できません');
  }

  await throttleDomain(url);
  await browserSemaphore.acquire();
  recordBrowserUsage();

  try {
    const { browser, isDedicated } = await getBrowser();
    const context = await browser.createBrowserContext();

    try {
      const page: Page = await context.newPage();
      await setupPageSecurity(page, !needScreenshot && !clipSelector);
      try {
        const defaultUa = await browser.userAgent();
        await page.setUserAgent(buildUserAgentFromDefault(defaultUa), buildUserAgentMetadata(defaultUa));
      } catch {
        const fallbackUa = getFallbackUserAgent();
        await page.setUserAgent(fallbackUa, buildUserAgentMetadata(fallbackUa));
      }
      await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
      await applyNativeEmulationOverrides(page);
      await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });

      const domain = new URL(url).hostname;
      const persistedCookies = dbGetTenantCookies(tenantId, domain);
      if (persistedCookies && persistedCookies.length > 0) {
        const restoredCookies = persistedCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || domain,
          path: c.path || '/',
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        try {
          await page.setCookie(...(restoredCookies as any));
        } catch {}
      }

      const persistedStorage = dbGetTenantStorage(tenantId, domain);
      if (persistedStorage && Object.keys(persistedStorage).length > 0) {
        await page.evaluateOnNewDocument((data: Record<string, string>) => {
          try {
            for (const [k, v] of Object.entries(data)) {
              localStorage.setItem(k, v);
            }
          } catch {}
        }, persistedStorage);
      }

      if (customCookies && customCookies.length > 0) {
        const puppeteerCookies = customCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        await page.setCookie(...(puppeteerCookies as any));
      }

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
          get: () => undefined,
          configurable: true,
        });
        Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
          get: () => 'Win32',
          configurable: true,
        });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['ja-JP', 'ja', 'en-US', 'en'],
        });
      });
      await page.evaluateOnNewDocument(patchWebRtcIpLeak);
      await page.evaluateOnNewDocument(patchCanvasFingerprint);

      const timeTreeResponses: unknown[] = [];
      const timeTreePending: Promise<void>[] = [];
      const target = new URL(url);
      if (target.hostname === 'timetreeapp.com' && /^\/public_calendars\/[^/]+\/?$/.test(target.pathname)) {
        const calendarId = target.pathname.split('/')[2];
        page.on('response', response => {
          const endpoint = new URL(response.url());
          if (response.ok() && endpoint.hostname === target.hostname && endpoint.pathname === `/api/v2/public_calendars/${calendarId}/public_events`) {
            timeTreePending.push(response.json().then(data => { timeTreeResponses.push(data); }).catch(() => {}));
          }
        });
      }

      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      let idleCap: ReturnType<typeof setTimeout> | undefined;
      try {
        // networkidle は計測・ロングポーリング等で永遠に来ない場合があり、本文が揃っていてもタイムアウトまで待ってしまう。
        // load 後の静止待ちだけ NETWORK_IDLE_CAP_MS で打ち切り、現在の DOM で本文取得へ進む。
        const idleCapped = new Promise<void>((resolve) => {
          page.once('load', () => {
            idleCap = setTimeout(resolve, Math.max(1, Math.min(NETWORK_IDLE_CAP_MS, remaining())));
          });
        });
        const navigation = page.goto(url, { waitUntil, timeout: timeoutMs });
        navigation.catch(() => {}); // 上限で先に進んだ後の goto 失敗は無視する
        await Promise.race([navigation, idleCapped]);
      } catch (gotoErr: any) {
        // networkidle 等のネットワーク待機タイムアウト時でも、DOM（HTML）が読み込まれていれば処理を続行
        const currentHtml = await page.content().catch(() => '');
        if (!currentHtml || currentHtml.length <= 500) {
          throw gotoErr;
        }
      } finally {
        if (idleCap) clearTimeout(idleCap);
      }

      try {
        const viewport = page.viewport();
        const w = viewport?.width ?? 1920;
        const h = viewport?.height ?? 1080;
        const x1 = w * (0.2 + Math.random() * 0.3);
        const y1 = h * (0.2 + Math.random() * 0.3);
        const x2 = w * (0.5 + Math.random() * 0.3);
        const y2 = h * (0.5 + Math.random() * 0.3);
        await humanMouseMove(page, x1, y1, x2, y2);
      } catch {}

      await autoScrollPage(page);
      await waitForDomStable(page, 800, Math.min(5000, remaining()));
      const captureHtml = async () => {
        await waitForTimeTreeResponses(timeTreePending, deadline);
        await inlineShadowDomContent(page);
        const visibleHtml = await pruneInvisibleElements(page, true) ?? await page.content();
        await waitForTimeTreeResponses(timeTreePending, deadline);
        return enrichTimeTreeHtml(visibleHtml, timeTreeResponses);
      };
      let html = await captureHtml();
      const contentDeadline = Math.min(deadline, Date.now() + 2000);
      let waiting = false;
      while (readiness && !readiness.isContentReady(html, page.url()) && Date.now() < contentDeadline) {
        if (!waiting) {
          waiting = true;
          readiness.onWait?.();
        }
        await page.waitForNetworkIdle({ idleTime: 200, concurrency: 0, timeout: Math.max(1, Math.min(1000, contentDeadline - Date.now())) }).catch(() => {});
        await waitForDomStable(page, 200, Math.max(0, Math.min(1000, contentDeadline - Date.now())));
        html = await captureHtml();
      }
      const finalUrl = page.url();
      const title = await page.title();

      try {
        const currentCookies = await page.cookies();
        if (currentCookies.length > 0) {
          const cookiesByDomain = groupCookiesByDomain(currentCookies as any, domain);
          for (const [key, list] of cookiesByDomain) {
            dbSaveDomainCookies(key, list);
          }
        }
      } catch {}

      try {
        const currentStorage = await page.evaluate(() => {
          try {
            return { ...localStorage };
          } catch {
            return null;
          }
        });
        if (currentStorage && Object.keys(currentStorage).length > 0) {
          dbSaveTenantStorage(tenantId, domain, currentStorage);
        }
      } catch {}

      let screenshot: string | undefined = undefined;
      if (needScreenshot || clipSelector) {
        if (clipSelector) {
          try {
            const el = await page.$(clipSelector);
            if (el) {
              const buf = await el.screenshot({ encoding: 'base64' });
              screenshot = buf as string;
            }
          } catch {}
        } else {
          try {
            if (fullPage) {
              try {
                await page.evaluate(async () => {
                  const scrollH = Math.min(document.body?.scrollHeight || document.documentElement?.scrollHeight || 0, 15000);
                  if (scrollH > 1000) {
                    window.scrollTo(0, scrollH);
                    await new Promise((r) => setTimeout(r, 60));
                    window.scrollTo(0, 0);
                  }
                });
              } catch {}
            }
            const buf = await page.screenshot({ encoding: 'base64', fullPage });
            screenshot = buf as string;
          } catch {
            try {
              const buf = await page.screenshot({ encoding: 'base64', fullPage: false });
              screenshot = buf as string;
            } catch {}
          }
        }
      }

      return { html, title, screenshot, finalUrl };
    } finally {
      if (isDedicated) {
        await browser.close();
      } else {
        await context.close();
      }
    }
  } finally {
    browserSemaphore.release();
  }
}
