import type { SimpleCookie } from './weibo_session.js';
import type { DiscoveryHit } from './discovery.js';
import type { MetaBrowser, MetaHttp } from './meta.js';
import type { WeiboHttp } from './weibo.js';
import type { DiscoveryWebSearch } from './discovery.js';
import type { WeiboSessionOpener } from './weibo_session.js';

/** 本番HTTP: 既存の共通取得器を使い、wreq指紋・SSRF検証・間隔調整を再利用する。 */
export function createProdWeiboHttp(): WeiboHttp {
  return {
    async getJson(url, headers, cookies, timeoutMs, signal) {
      const { fetchWithSafeRedirects } = await import('../../http_fetcher.js');
      const { response } = await fetchWithSafeRedirects(url, timeoutMs, 5, headers, cookies.length ? cookies.map((c) => ({ name: c.name, value: c.value })) : undefined, undefined, signal);
      const text = await response.text();
      try {
        return { status: response.status, data: JSON.parse(text) };
      } catch {
        throw new Error('Weibo non-JSON response status=' + response.status);
      }
    },
  };
}

export function createProdMetaHttp(): MetaHttp {
  return {
    async getPage(url, timeoutMs, signal) {
      const { fetchWithSafeRedirects } = await import('../../http_fetcher.js');
      const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' };
      const { response, finalUrl } = await fetchWithSafeRedirects(url, timeoutMs, 5, headers, undefined, undefined, signal);
      if (signal.aborted) throw signal.reason;
      return { status: response.status, finalUrl, html: await response.text() };
    },
    async getJson(url, timeoutMs, signal) {
      const { fetchWithSafeRedirects } = await import('../../http_fetcher.js');
      const { response } = await fetchWithSafeRedirects(url, timeoutMs, 3, { Accept: 'application/json' }, undefined, undefined, signal);
      if (signal.aborted) throw signal.reason;
      return { status: response.status, data: await response.json() };
    },
  };
}

/** Weibo匿名セッション: 通常表示でサイト発行のCookie群を受け取る。固定sleepなし。 */
export function createProdSessionOpener(): WeiboSessionOpener {
  return {
    async openWeiboSession(signal: AbortSignal): Promise<SimpleCookie[]> {
      const { getBrowser, closeSharedBrowser } = await import('../../browser_engine.js');
      const { applyStealthEvasions } = await import('../../browser_stealth.js');
      const { setupPageSecurity } = await import('../../browser_engine.js');
      const { browser } = await getBrowser();
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await applyStealthEvasions(page);
        await setupPageSecurity(page, true);
        await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const deadline = Date.now() + 15000;
        let cookies: SimpleCookie[] = [];
        while (Date.now() < deadline) {
          if (signal.aborted) throw signal.reason;
          const all = await context.cookies();
          cookies = all
            .filter((c) => ['m.weibo.cn', '.m.weibo.cn', 'weibo.cn', '.weibo.cn'].includes(c.domain))
            .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
          if (cookies.some((c) => c.name === 'SUB')) break;
          await new Promise((r) => setTimeout(r, 800));
        }
        return cookies;
      } finally {
        await context.close().catch(() => undefined);
        void closeSharedBrowser;
      }
    },
  };
}

export function createProdMetaBrowser(): MetaBrowser {
  return {
    async readPage(url, timeoutMs, signal) {
      const { getBrowser } = await import('../../browser_engine.js');
      const { applyStealthEvasions } = await import('../../browser_stealth.js');
      const { setupPageSecurity } = await import('../../browser_engine.js');
      const { browser } = await getBrowser();
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await applyStealthEvasions(page);
        await setupPageSecurity(page, true);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (signal.aborted) throw signal.reason;
        const html = await page.content();
        return { finalUrl: page.url(), html, title: await page.title() };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  };
}

export function createProdWebSearch(): DiscoveryWebSearch {
  return {
    async search(query: string, maxItems: number, opts: { updated?: 'day' | 'week' | 'year' }, signal: AbortSignal): Promise<DiscoveryHit[]> {
      const { fetchYahooWebDirect } = await import('../yahoo.js');
      const updated = opts.updated === 'day' ? 'day' : opts.updated === 'week' ? 'week' : 'year';
      const items = await fetchYahooWebDirect(query, maxItems, signal, { updated });
      return items.map((item) => ({ url: item.url, ...(item.title ? { title: item.title } : {}), ...(item.snippet ? { snippet: item.snippet } : {}) }));
    },
  };
}
