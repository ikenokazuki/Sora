import { createHash } from 'crypto';
import { scrapeUrl } from '../scraper.js';
import { sendWebhookNotification } from '../enrichment.js';
import {
  dbSaveWatchTarget,
  dbGetWatchTarget,
  dbListWatchTargets,
  dbUpdateWatchTargetCheck,
  dbDeleteWatchTarget,
  dbInsertWatchHistory,
  dbListWatchHistory,
  type WatchTargetRecord,
  type WatchHistoryRecord,
} from '../db.js';

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
  intervalSeconds?: number;
  initialFetch?: boolean;
}): Promise<{ target: WatchTargetRecord; initialResult?: WatchCheckResult }> {
  let target = dbSaveWatchTarget({
    id: options.id,
    url: options.url,
    title: options.title,
    selector: options.selector,
    webhook_url: options.webhookUrl,
    interval_seconds: options.intervalSeconds,
  });

  let initialResult: WatchCheckResult | undefined = undefined;

  // 初期フェッチによるハッシュベースライン作成
  if (options.initialFetch !== false) {
    try {
      initialResult = await checkWatchTarget(target.id);
      target = dbGetWatchTarget(target.id) || target;
    } catch (err: any) {
      console.warn(`[Sora/Watch] Initial fetch for watch target ${target.id} failed:`, err?.message);
    }
  }

  return { target, initialResult };
}

/** 単一ターゲットの差分スキャン & Webhook 通知 */
export async function checkWatchTarget(targetId: string): Promise<WatchCheckResult> {
  const target = dbGetWatchTarget(targetId);
  if (!target) {
    throw new Error(`Watch target not found: ${targetId}`);
  }

  // スクレイピング実行
  const scraped = await scrapeUrl({
    url: target.url,
    selectors: target.selector ? { content: target.selector } : undefined,
    onlyMainContent: true,
    noCache: true,
  });

  const rawText = target.selector && scraped.extracted?.content
    ? scraped.extracted.content
    : (scraped.content || '');

  const cleanText = rawText.replace(/\s+/g, ' ').trim();
  const currentHash = computeContentHash(cleanText);
  const checkedAt = new Date().toISOString();

  const isFirstCheck = !target.last_hash;
  const isChanged = !isFirstCheck && target.last_hash !== currentHash;

  let diffSummary: string | undefined = undefined;
  let webhookSent = false;

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

    // Webhook 通知送信 (SSRF 保護済み)
    if (target.webhook_url) {
      sendWebhookNotification(target.webhook_url, {
        event: 'watch.diff_detected',
        targetId: target.id,
        url: target.url,
        title: target.title,
        diffSummary,
        currentHash,
        timestamp: checkedAt,
      });
      webhookSent = true;
    }
  } else {
    // 差分なし: チェック時刻のみ更新
    dbUpdateWatchTargetCheck(target.id, currentHash, target.last_content);
  }

  return {
    targetId: target.id,
    url: target.url,
    changed: isChanged,
    previousHash: target.last_hash || undefined,
    currentHash,
    diffSummary,
    snapshotSnippet: cleanText.slice(0, 300),
    checkedAt,
    webhookSent: webhookSent ? true : undefined,
  };
}

/** 全登録ターゲットの一括差分チェック */
export async function checkAllWatchTargets(): Promise<WatchCheckResult[]> {
  const targets = dbListWatchTargets();
  const results: WatchCheckResult[] = [];

  for (const t of targets) {
    try {
      const res = await checkWatchTarget(t.id);
      results.push(res);
    } catch (err: any) {
      results.push({
        targetId: t.id,
        url: t.url,
        changed: false,
        currentHash: t.last_hash || '',
        diffSummary: `Check failed: ${err?.message || err}`,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

export function listWatchTargets(): WatchTargetRecord[] {
  return dbListWatchTargets();
}

export function getWatchHistory(targetId: string, limit = 20): WatchHistoryRecord[] {
  return dbListWatchHistory(targetId, limit);
}

export function deleteWatchTarget(targetId: string): boolean {
  return dbDeleteWatchTarget(targetId);
}
