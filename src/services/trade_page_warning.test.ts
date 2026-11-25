import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { ResourceBusyError } from '../errors.js';
import * as scraper from '../scraper.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { fakeHtsModel, modelAnswer } from '../test_fixtures/hts_model.js';
import { CheckProductComplianceResultSchema } from '../types.js';
import { resetCrossBreakerForTest } from './cbp_cross.js';
import { resetHtsDataForTest } from './hts_data.js';
import { setHtsModelForTest } from './hts_model.js';
import { checkProductCompliance } from './trade.js';

/**
 * check_product_compliance が商品ページ（url）を読めなかったときは、判定を続けるが、ページの内容を使っていないことを、応答の warnings で知らせる。
 * 読めなかったページ（HTTP エラーや本文のないページ）の題名は、商品名にしない。ページの取得は偽物、HTS のモデルと外部の応答はテスト用。
 */
type Page = Awaited<ReturnType<typeof scraper.scrapeUrl>>;
const url = 'https://shop.example.com/mug';
const mug = { productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', material: 'ceramic', foodContact: true };

let restore: (() => void) | undefined;
let warn: ReturnType<typeof spyOn>;
let scrape: ReturnType<typeof spyOn> | undefined;
beforeAll(() => {
  restore = installExternalApiFixtures();
});
afterAll(() => {
  restore?.();
  setHtsModelForTest(undefined);
});
beforeEach(() => {
  clearCache();
  resetCrossBreakerForTest();
  resetHtsDataForTest();
  setHtsModelForTest(fakeHtsModel([[/mug|tableware/i, modelAnswer(['6912004400', '6912004500'])]]));
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  scrape?.mockRestore();
  warn.mockRestore();
});

const pageIs = (value: Partial<Page>) => {
  scrape = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url, title: '', content: '', ...value } as Page);
};
const pageFails = (error: Error) => {
  scrape = spyOn(scraper, 'scrapeUrl').mockRejectedValue(error);
};

describe('商品ページを読めなかったとき', () => {
  test('取得に失敗した → 理由と一緒に知らせる（商品の情報が無いので、確認の質問になる）', async () => {
    pageFails(new Error('接続できませんでした'));
    const result = await checkProductCompliance({ url });
    expect(result.overallStatus).toBe('needs_more_info');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('商品ページを読めなかったので');
    expect(result.warnings?.[0]).toContain('接続できませんでした');
  });

  test('混み合って断られた（ResourceBusyError）場合も同じ。商品名が渡されていれば、判定まで進み、知らせは残る', async () => {
    pageFails(new ResourceBusyError('ブラウザの枠が空きません', 'queue_full', 30));
    const result = await checkProductCompliance({ url, ...mug });
    expect(result.overallStatus).not.toBe('needs_more_info');
    expect(result.warnings?.[0]).toContain('ブラウザの枠が空きません');
  });

  test('エラーのページ（contentStatus: unavailable）は、題名も説明も使わない', async () => {
    pageIs({ contentStatus: 'unavailable', title: '403 Forbidden', content: 'Access denied', description: 'mug' });
    const result = await checkProductCompliance({ url });
    expect(result.overallStatus).toBe('needs_more_info');
    expect(result.product.name).toBeUndefined();
    expect(result.product.description).toBeUndefined();
    expect(result.warnings?.[0]).toContain('HTTP エラーか、本文のないページ');
  });
});

describe('知らせを付けないとき', () => {
  test('ページを読めた・url を渡していない', async () => {
    pageIs({ title: mug.productName, description: mug.description });
    const read = await checkProductCompliance({ url, material: 'ceramic', foodContact: true });
    expect(read.product.name).toBe(mug.productName);
    expect(read.warnings).toBeUndefined();
    expect((await checkProductCompliance(mug)).warnings).toBeUndefined();
  });
});

test('応答の型（OpenAPI）にも warnings がある', () => {
  expect(Object.keys(CheckProductComplianceResultSchema.shape)).toContain('warnings');
});
