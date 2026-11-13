import { describe, expect, spyOn, test } from 'bun:test';
import * as scraper from '../scraper.js';
import { PUBLIC_TENANT_ID } from '../security/tenant_context.js';
import { createScrapeArticleAdapter } from './country_intel/runtime.js';
import { checkProductCompliance } from './trade.js';

/**
 * 利用者を持たない取得（Sora が自分の都合で読むページ）は、public の tenant で読む（設計 5。穴 17）。
 * これまで、tenant を渡さず legacy として動き、鍵なしの利用者の保存済みの状態を、読んで、書き換えていた。
 * （GCC の商品ページは、services/gcc.test.ts で確かめている）
 */

const page = { url: 'https://shop.example.com/p', title: 'Helmet', content: 'content', description: 'd' } as unknown as Awaited<ReturnType<typeof scraper.scrapeUrl>>;

describe('public の tenant で読む取得', () => {
  test('国の情報の記事の取得', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue(page);
    try {
      await createScrapeArticleAdapter()('https://news.example.com/a', new AbortController().signal);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ url: 'https://news.example.com/a', tenantId: PUBLIC_TENANT_ID, noCache: true });
    } finally {
      spy.mockRestore();
    }
  });

  test('trade の商品ページの取得（check_product_compliance の url）', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue(page);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await checkProductCompliance({ url: 'https://shop.example.com/p', productName: 'Helmet', description: 'A helmet', hasBattery: false }).catch(() => {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ url: 'https://shop.example.com/p', tenantId: PUBLIC_TENANT_ID });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
