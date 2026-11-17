import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { extractText } from 'unpdf';
import { ResourceBusyError } from './errors.js';
import { safeTruncateMarkdown } from './enrichment.js';
import { parsePdfToMarkdown, pdfQueuePolicy, pdfSlots } from './pdf.js';
import { runAsCaller } from './security/caller.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { makePdf } from './test_fixtures/pdf.js';

/**
 * PDF の解析（設計 6。穴 26）。以前は、全ページを一度に（Promise.all）読み、本文の大きさもページ数も上限が無く、同時に何件でも、1 つのスレッドで解析した。
 * いまは、読むページの上限と、必要な文字数に達したら止める早期終了（結果は変えない）と、公平な順番（同時 2 件）を置く。
 */

const SAVED_ISOLATION = process.env.SORA_ISOLATION;
const held: Array<() => void> = [];
beforeEach(() => {
  delete process.env.SORA_ISOLATION;
  resetSecurityMetrics();
});
afterEach(() => {
  for (const release of held.splice(0)) release();
  if (SAVED_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = SAVED_ISOLATION;
});

const URL_OF = 'https://x.example/a.pdf';
const lineOf = (n: number, width = 76): string => `line ${n} ${'x'.repeat(width)}`.slice(0, width + 8);
/** 以前の実装と同じ手順で、全ページを読んだ本文（比較の基準）。pdf.js は渡したバッファを手放す（空にする）ので、写しを渡す */
async function reference(pdf: Uint8Array): Promise<string> {
  const { text } = await extractText(pdf.slice(), { mergePages: true });
  return (Array.isArray(text) ? text.join('\n\n') : text).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

describe('結果は、以前と同じ（読まなくてよい分を、読まないだけ）', () => {
  test('小さな PDF: 本文・総ページ数・読んだページ数。以前の実装と同じ本文', async () => {
    const pdf = makePdf([['Hello page one'], ['Second page text']]);
    const result = await parsePdfToMarkdown(pdf.slice(), URL_OF);
    expect(result.content).toBe(safeTruncateMarkdown(await reference(pdf), 30_000));
    expect(result.content).toContain('Hello page one');
    expect(result.content).toContain('Second page text');
    expect(result.isTruncated).toBe(false);
    expect(result.metadata).toMatchObject({ totalPages: 2, pagesRead: 2 });
    expect(result.contentType).toBe('application/pdf');
  });

  test('文書情報（Title・Author）を返す（以前は、バッファが解析のあとに空になり、あとから読んだ文書情報が、黙って落ちていた）', async () => {
    const pdf = makePdf([['body text']], { title: 'Sample Title', author: 'Sample Author' });
    const result = await parsePdfToMarkdown(pdf, URL_OF);
    expect(result).toMatchObject({ title: 'Sample Title', author: 'Sample Author' });
    expect(result.metadata).toMatchObject({ Title: 'Sample Title', Author: 'Sample Author', totalPages: 1, pagesRead: 1 });
  });

  test('必要な文字数（ハイライトの元の 20 万字）に達したら、残りのページは読まない。本文・ハイライトの元は、全ページを読んだ場合と同じ', async () => {
    const pages = Array.from({ length: 150 }, (_, p) => Array.from({ length: 40 }, (_, l) => lineOf(p * 100 + l)));
    const pdf = makePdf(pages);
    const result = await parsePdfToMarkdown(pdf.slice(), URL_OF);
    const all = await reference(pdf);
    expect(all.length).toBeGreaterThan(300_000);
    expect(result.content).toBe(safeTruncateMarkdown(all, 30_000));
    expect(result.fullContent).toBe(safeTruncateMarkdown(all, 200_000));
    expect(result.isTruncated).toBe(true);
    expect(result.metadata).toMatchObject({ totalPages: 150 });
    expect(result.metadata?.pagesRead).toBeLessThan(150);
  });
});

describe('読むページの上限', () => {
  test('strict は先頭 200 ページまで。超えたら、isTruncated と pagesRead で示す。standard は 1,000 ページまで', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const pdf = makePdf(Array.from({ length: 250 }, (_, p) => [`marker-${p + 1}`]));
    const strict = await parsePdfToMarkdown(pdf.slice(), URL_OF);
    expect(strict.metadata).toMatchObject({ totalPages: 250, pagesRead: 200 });
    expect(strict.isTruncated).toBe(true);
    expect(strict.content).toContain('marker-200');
    expect(strict.content).not.toContain('marker-201');
    delete process.env.SORA_ISOLATION;
    const standard = await parsePdfToMarkdown(pdf.slice(), URL_OF);
    expect(standard.metadata).toMatchObject({ totalPages: 250, pagesRead: 250 });
    expect(standard.isTruncated).toBe(false);
    expect(standard.content).toContain('marker-250');
  });
});

describe('1 回の解析の時間の上限（1 ページが重い PDF が、枠を握り続けない）', () => {
  /** 呼ぶたびに 5 秒進む時計（解析の始まりに 1 回、ページを読む前に 1 回ずつ呼ばれる） */
  const clock = () => { let t = 0; return () => (t += 5_000); };

  test('strict の 15 秒に達したら、読んだページまでで止める。isTruncated・pagesRead・警告（共有のキャッシュに、短くだけ残るように）。standard は 60 秒なので、同じ時計でも多く読む', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const pdf = makePdf(Array.from({ length: 20 }, (_, p) => [`page-${p + 1}`]));
    const strict = await parsePdfToMarkdown(pdf.slice(), URL_OF, 30_000, { now: clock() });
    expect(strict.metadata).toMatchObject({ totalPages: 20, pagesRead: 2 });
    expect(strict.isTruncated).toBe(true);
    expect(strict.warnings?.join('\n')).toContain('時間の上限');
    expect(strict.content).toContain('page-2');
    expect(strict.content).not.toContain('page-3');
    delete process.env.SORA_ISOLATION;
    const standard = await parsePdfToMarkdown(pdf.slice(), URL_OF, 30_000, { now: clock() });
    expect(standard.metadata).toMatchObject({ pagesRead: 11 });
  });

  test('上限に達しなければ、警告は付かない', async () => {
    const result = await parsePdfToMarkdown(makePdf([['a'], ['b']]), URL_OF);
    expect(result.warnings).toBeUndefined();
  });

  test('ページの合間に、イベントループへ処理を譲る（解析の間も、タイマーが動く）', async () => {
    const pdf = makePdf(Array.from({ length: 120 }, (_, p) => Array.from({ length: 30 }, (_, l) => lineOf(p * 100 + l))));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      await parsePdfToMarkdown(pdf, URL_OF, 30_000);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  });
});

describe('文書情報（Title・Author など）は、決まった項目だけを、長さを切って返す（PDF 側が決める大きさを、そのまま返さない）', () => {
  test('Title・Author は 300 字まで。空白だけの Title は、ファイル名に戻す', async () => {
    const huge = makePdf([['body']], { title: 'T'.repeat(20_000), author: 'A'.repeat(20_000) });
    const result = await parsePdfToMarkdown(huge, URL_OF);
    expect(result.title?.length).toBeLessThanOrEqual(301);
    expect(result.author?.length).toBeLessThanOrEqual(301);
    expect(String(result.metadata?.Title).length).toBeLessThanOrEqual(301);
    const blank = await parsePdfToMarkdown(makePdf([['body']], { title: '   ' }), URL_OF);
    expect(blank.title).toBe('a.pdf');
  });

  test('決まった項目（Title・Author・Subject・Keywords・Creator・Producer・日付・PDFFormatVersion）だけ。任意のキー（Custom など）は捨てる', async () => {
    const pdf = makePdf([['body']], { title: 'T', author: 'A', custom: { Foo: 'custom-secret' }, subject: 'S', extraInfo: { Weird: 'x'.repeat(5000) } });
    const result = await parsePdfToMarkdown(pdf, URL_OF);
    expect(result.metadata).toMatchObject({ Title: 'T', Author: 'A', Subject: 'S', PDFFormatVersion: '1.4', totalPages: 1, pagesRead: 1 });
    expect(JSON.stringify(result.metadata)).not.toContain('custom-secret');
    expect(result.metadata).not.toHaveProperty('Custom');
    expect(result.metadata).not.toHaveProperty('Weird');
    expect(JSON.stringify(result.metadata).length).toBeLessThan(1000);
  });
});

describe('解析の順番（同時 2 件。利用者ごとに公平。待つ数に上限）', () => {
  const tiny = () => makePdf([['tiny']]);
  const hold = async (n: number) => { for (let i = 0; i < n; i++) held.push(await pdfSlots.acquire('name:S')); };
  const parse = (tenantId: string): Promise<string> => {
    const promise = parsePdfToMarkdown(tiny(), URL_OF, 30_000, { tenantId }).then(() => tenantId);
    promise.catch(() => undefined);
    return promise;
  };

  test('A が 3 件を並べたあとの B の 1 件は、A の 1 件の次に動く（先入れ先出しなら、A の 3 件が先）', async () => {
    await hold(2);
    const order: string[] = [];
    const jobs = [parse('name:A'), parse('name:A'), parse('name:A'), parse('name:B')];
    for (const job of jobs) void job.then((who) => order.push(who));
    await Bun.sleep(20);
    expect(order).toEqual([]);
    // 空きを 1 つだけ作る（解析は、1 件ずつ、順に動く）。もう 1 つは、最後まで握ったまま
    const [first] = held.splice(0, 1);
    first?.();
    await Promise.all(jobs);
    expect(order).toEqual(['name:A', 'name:B', 'name:A', 'name:A']);
  });

  test('1 人が待てる解析の数（strict は 20 件）を超えたら、待たせず tenant_queue_full（PDF の資源）。ほかの利用者は待てる', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await hold(2);
    const waiting = Array.from({ length: 20 }, () => parse('name:A'));
    const error = await parse('name:A').then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error).toMatchObject({ reason: 'tenant_queue_full', resource: 'pdf' });
    expect((error as Error).message).toContain('PDF の解析の順番');
    expect(getSecurityMetrics()['sora_pdf_busy_tenant_queue_full_total']).toBe(1);
    const other = parse('name:B');
    for (const release of held.splice(0)) release();
    await Promise.all([...waiting, other]);
  });

  test('バイト列を関数で渡すと、順番が来てから呼ぶ（待っている間は、本体を読まない。断られたら、一度も読まない）', async () => {
    await hold(2);
    let reads = 0;
    const provider = async () => { reads++; return tiny(); };
    const job = parsePdfToMarkdown(provider, URL_OF, 30_000, { tenantId: 'name:A' });
    job.catch(() => undefined);
    await Bun.sleep(30);
    expect(reads).toBe(0);
    for (const release of held.splice(0)) release();
    expect((await job).content).toContain('tiny');
    expect(reads).toBe(1);
    // 断られた呼び出しは、読まない
    process.env.SORA_ISOLATION = 'strict';
    await hold(2);
    const waiting = Array.from({ length: 20 }, () => parse('name:A'));
    let refusedReads = 0;
    const refused = await parsePdfToMarkdown(async () => { refusedReads++; return tiny(); }, URL_OF, 30_000, { tenantId: 'name:A' }).then(() => undefined, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ResourceBusyError);
    expect(refusedReads).toBe(0);
    for (const release of held.splice(0)) release();
    await Promise.all(waiting);
  });

  test('待っている間に取得が中止（signal）されたら、順番から外れる', async () => {
    await hold(2);
    const controller = new AbortController();
    const promise = parsePdfToMarkdown(tiny(), URL_OF, 30_000, { tenantId: 'name:A', signal: controller.signal });
    promise.catch(() => undefined);
    await Bun.sleep(10);
    controller.abort(new Error('client closed'));
    await expect(Promise.race([promise, Bun.sleep(1000).then(() => { throw new Error('終わらなかった'); })])).rejects.toThrow('client closed');
    expect(pdfSlots.pendingCount).toBe(0);
  });

  test('解析が失敗しても、順番を手放す（壊れた PDF のあとでも、次の解析が動く）', async () => {
    for (let i = 0; i < 4; i++) await parsePdfToMarkdown(new TextEncoder().encode('not a pdf'), URL_OF, 30_000, { tenantId: 'name:A' }).catch(() => undefined);
    expect(pdfSlots.activeCount).toBe(0);
    const ok = await parsePdfToMarkdown(tiny(), URL_OF, 30_000, { tenantId: 'name:A' });
    expect(ok.content).toContain('tiny');
  });

  test('tenantId を渡さなければ、呼んでいる利用者（currentCaller）で数える。呼び出しの外は legacy', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await hold(2);
    const waiting = Array.from({ length: 20 }, () => parse('name:A'));
    // A の範囲の中で呼ぶと、A の待ちの上限（20 件）に当たる。tenantId を渡す必要は無い
    const error = await runAsCaller('name:A', () => parsePdfToMarkdown(tiny(), URL_OF)).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ reason: 'tenant_queue_full', resource: 'pdf' });
    // 範囲の外は legacy（A の列ではない）なので待てる
    const outside = parsePdfToMarkdown(tiny(), URL_OF);
    outside.catch(() => undefined);
    for (const release of held.splice(0)) release();
    await Promise.all([...waiting, outside]);
  });

  test('水準ごとの既定の方針: standard は 1 人 50・全体 200・60 秒、strict は 20・80・30 秒（同時 2 件）', () => {
    expect(pdfQueuePolicy()).toEqual({ perTenant: 50, total: 200, waitMs: 60_000, sharePercent: 100 });
    expect(pdfSlots.max).toBe(2);
    process.env.SORA_ISOLATION = 'strict';
    expect(pdfQueuePolicy()).toEqual({ perTenant: 20, total: 80, waitMs: 30_000, sharePercent: 100 });
  });
});
