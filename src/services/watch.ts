import { createHash } from 'crypto';
import { scrapeUrl } from '../scraper.js';
import { deliverWebhook } from '../enrichment.js';
import {
  dbSaveWatchTarget,
  dbGetWatchTarget,
  dbListWatchTargets,
  dbUpdateWatchTargetCheck,
  dbDeleteWatchTarget,
  dbInsertWatchHistory,
  type WatchTargetRecord,
} from '../db.js';
import { errorCode, errorMessage } from '../errors.js';

export class WatchSelectorNotFoundError extends Error {
  readonly code = 'WATCH_SELECTOR_NOT_FOUND';
  constructor(selector: string, url: string) {
    super(`Watch selector not found: ${selector} (${url})`);
    this.name = 'WatchSelectorNotFoundError';
  }
}

export interface WatchCheckResult {
  targetId: string;
  url: string;
  changed: boolean;
  previousHash?: string;
  currentHash: string;
  diffSummary?: string;
  snapshotSnippet?: string;
  checkedAt: string;
  webhookSent?: boolean;
  errorCode?: string;
}

/** 文字列の SHA-256 ハッシュを算出 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/** 監視ターゲットの登録 (新規または更新) */
export async function registerWatchTarget(options: {
  id?: string;
  url: string;
  title?: string;
  selector?: string;
  webhookUrl?: string;
  initialFetch?: boolean;
}, scrapeImpl: typeof scrapeUrl = scrapeUrl
): Promise<{ target: WatchTargetRecord; initialResult?: WatchCheckResult; initialError?: { code: string; message: string } }> {
  let target = dbSaveWatchTarget({
    id: options.id,
    url: options.url,
    title: options.title,
    selector: options.selector,
    webhook_url: options.webhookUrl,
  });

  let initialResult: WatchCheckResult | undefined = undefined;

  // 初期フェッチによるハッシュベースライン作成
  if (options.initialFetch !== false) {
    try {
      initialResult = await checkWatchTarget(target.id, scrapeImpl);
      target = dbGetWatchTarget(target.id) || target;
    } catch (err) {
      console.warn(`[Sora/Watch] Initial fetch for watch target ${target.id} failed:`, errorMessage(err));
      const code = errorCode(err) ?? 'WATCH_INITIAL_FETCH_FAILED';
      return { target, initialError: { code, message: String(errorMessage(err) ?? err).slice(0, 300) } };
    }
  }

  return { target, initialResult };
}

/** 単一ターゲットの差分スキャン & Webhook 通知 */
export async function checkWatchTarget(targetId: string, scrapeImpl: typeof scrapeUrl = scrapeUrl): Promise<WatchCheckResult> {
  const { result, sendWebhook } = await checkAndStore(targetId, scrapeImpl);
  if (sendWebhook) result.webhookSent = await sendWebhook();
  return result;
}

/** 差分の検出と保存まで行い、Webhook は送らずに送る関数として返す (保存してから送る順を守る) */
async function checkAndStore(
  targetId: string,
  scrapeImpl: typeof scrapeUrl,
): Promise<{ result: WatchCheckResult; sendWebhook?: () => Promise<boolean> }> {
  const target = dbGetWatchTarget(targetId);
  if (!target) {
    throw new Error(`Watch target not found: ${targetId}`);
  }

  // スクレイピング実行
  const scraped = await scrapeImpl({
    url: target.url,
    selectors: target.selector ? { content: target.selector } : undefined,
    onlyMainContent: true,
    noCache: true,
  });

  if (target.selector && typeof scraped.extracted?.content !== 'string') {
    throw new WatchSelectorNotFoundError(target.selector, target.url);
  }
  const rawText = target.selector
    ? (scraped.extracted?.content as string)
    : (scraped.content || '');

  const cleanText = rawText.replace(/\s+/g, ' ').trim();
  const currentHash = computeContentHash(cleanText);
  const checkedAt = new Date().toISOString();

  const isFirstCheck = !target.last_hash;
  const isChanged = !isFirstCheck && target.last_hash !== currentHash;

  let diffSummary: string | undefined = undefined;
  let sendWebhook: (() => Promise<boolean>) | undefined;

  if (isFirstCheck) {
    diffSummary = `Initial baseline established (${cleanText.length} characters)`;
    dbUpdateWatchTargetCheck(target.id, currentHash, cleanText.slice(0, 1000));
  } else if (isChanged) {
    const prevLen = (target.last_content || '').length;
    diffSummary = `Content updated: length changed from ${prevLen} to ${cleanText.length} chars (hash: ${target.last_hash?.slice(0, 8)} -> ${currentHash.slice(0, 8)})`;

    // 履歴保存
    dbInsertWatchHistory({
      watch_target_id: target.id,
      diff_summary: diffSummary,
      snapshot: cleanText.slice(0, 2000),
    });

    // ターゲットの最新状態更新
    dbUpdateWatchTargetCheck(target.id, currentHash, cleanText.slice(0, 1000));

    // Webhook 通知 (SSRF 保護済み)。呼んだ側が送り、2xx で受け取られたときだけ true
    if (target.webhook_url) {
      const webhookUrl = target.webhook_url;
      const payload = {
        event: 'watch.diff_detected',
        targetId: target.id,
        url: target.url,
        title: target.title,
        diffSummary,
        currentHash,
        timestamp: checkedAt,
      };
      sendWebhook = () => deliverWebhook(webhookUrl, payload);
    }
  } else {
    // 差分なし: チェック時刻のみ更新
    dbUpdateWatchTargetCheck(target.id, currentHash, target.last_content);
  }

  return {
    result: {
      targetId: target.id,
      url: target.url,
      changed: isChanged,
      previousHash: target.last_hash || undefined,
      currentHash,
      diffSummary,
      snapshotSnippet: cleanText.slice(0, 300),
      checkedAt,
    },
    sendWebhook,
  };
}

/** 一括チェックで同時に送る Webhook の上限 */
const WEBHOOK_CONCURRENCY = 5;

/** 全登録ターゲットの一括差分チェック */
export async function checkAllWatchTargets(scrapeImpl: typeof scrapeUrl = scrapeUrl): Promise<WatchCheckResult[]> {
  const targets = dbListWatchTargets();
  const results: WatchCheckResult[] = [];
  const deliveries: Promise<void>[] = [];
  // 送信は同時に WEBHOOK_CONCURRENCY 件まで。空きを渡す順 (queue) は先に待った順
  let active = 0;
  const queue: Array<() => void> = [];
  const limited = async (send: () => Promise<boolean>): Promise<boolean> => {
    if (active >= WEBHOOK_CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
    else active += 1;
    try {
      return await send();
    } finally {
      const next = queue.shift();
      if (next) next(); // 空きをそのまま次に渡す
      else active -= 1;
    }
  };

  for (const t of targets) {
    try {
      const { result, sendWebhook } = await checkAndStore(t.id, scrapeImpl);
      results.push(result);
      // 保存したらすぐ送り始め、次の確認を待たせない。全部の返事は最後にまとめて待つ。
      // 送信が例外を投げても、ほかの対象の結果を失わない (その対象だけ false)
      if (sendWebhook) {
        deliveries.push(limited(sendWebhook).catch((err) => {
          console.warn(`[Sora/Watch] Webhook delivery for watch target ${t.id} threw:`, errorMessage(err));
          return false;
        }).then((sent) => { result.webhookSent = sent; }));
      }
    } catch (err) {
      results.push({
        targetId: t.id,
        url: t.url,
        changed: false,
        currentHash: t.last_hash || '',
        diffSummary: `Check failed: ${errorMessage(err) || err}`,
        checkedAt: new Date().toISOString(),
        ...(errorCode(err) ? { errorCode: errorCode(err) } : {}),
      });
    }
  }

  await Promise.all(deliveries);
  return results;
}

export function listWatchTargets(): WatchTargetRecord[] {
  return dbListWatchTargets();
}

export function deleteWatchTarget(targetId: string): boolean {
  return dbDeleteWatchTarget(targetId);
}
