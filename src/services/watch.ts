import { createHash } from 'crypto';
import { scrapeUrl } from '../scraper.js';
import { deliverWebhook } from '../enrichment.js';
import {
  dbClaimWatchCheck,
  dbCountWatchTargets,
  dbReleaseWatchCheck,
  dbSaveWatchTarget,
  dbGetWatchTarget,
  dbListWatchTargets,
  dbUpdateWatchTargetCheck,
  dbDeleteWatchTarget,
  dbInsertWatchHistory,
  type WatchTargetRecord,
} from '../db.js';
import { errorCode, errorKind, errorMessage, ResourceBusyError, WatchLimitError } from '../errors.js';
import { limits as currentLimits, type Limits } from '../security/limits.js';
import { incrementSecurityCounter } from '../security/metrics.js';

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
  /** 最小の間隔（確認できる間隔の下限）の中なので、取得せずに見送った（一括の確認だけ） */
  skipped?: boolean;
  /** 見送ったとき、もう一度確認できるまでの秒 */
  retryAfterSec?: number;
}

/** 文字列の SHA-256 ハッシュを算出 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/** 監視ターゲットの登録 (新規または更新)。持ち主は tenantId。別の tenant が持つ id への登録は断る */
export async function registerWatchTarget(options: {
  tenantId: string;
  id?: string;
  url: string;
  title?: string;
  selector?: string;
  webhookUrl?: string;
  initialFetch?: boolean;
  /** 上限の値。省くと、SORA_ISOLATION の水準の値（テスト用に差し替えられる） */
  limits?: Readonly<Limits>;
}, scrapeImpl: typeof scrapeUrl = scrapeUrl
): Promise<{ target: WatchTargetRecord; initialResult?: WatchCheckResult; initialError?: { code: string; message: string } }> {
  const lim = options.limits ?? currentLimits();
  // 1 人の登録数の上限。自分の既存のウォッチの更新（同じ id）は数えない。数えてから保存するまでに await が無いので、同時の登録でも超えない
  if (!(options.id && dbGetWatchTarget(options.id, options.tenantId))) {
    const current = dbCountWatchTargets(options.tenantId);
    if (current >= lim.watchTargetsPerTenant) {
      incrementSecurityCounter('sora_watch_limit_exceeded_total');
      throw new WatchLimitError(
        'WATCH_LIMIT_EXCEEDED',
        `登録できるウォッチは 1 人 ${lim.watchTargetsPerTenant} 件までです（いま ${current} 件）。使わないウォッチを delete してから登録してください`,
        lim.watchTargetsPerTenant,
        current,
      );
    }
  }
  let target = dbSaveWatchTarget({
    tenantId: options.tenantId,
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
      initialResult = await checkWatchTarget(target.id, options.tenantId, scrapeImpl, lim);
      target = dbGetWatchTarget(target.id, options.tenantId) || target;
    } catch (err) {
      console.warn(`[Sora/Watch] Initial fetch for watch target ${target.id} failed:`, errorMessage(err));
      const code = errorCode(err) ?? 'WATCH_INITIAL_FETCH_FAILED';
      return { target, initialError: { code, message: String(errorMessage(err) ?? err).slice(0, 300) } };
    }
  }

  return { target, initialResult };
}

/** 単一ターゲットの差分スキャン & Webhook 通知。tenant が違う id は、存在しない id と同じに「見つからない」 */
export async function checkWatchTarget(targetId: string, tenantId: string, scrapeImpl: typeof scrapeUrl = scrapeUrl, lim: Readonly<Limits> = currentLimits()): Promise<WatchCheckResult> {
  const { result, sendWebhook } = await checkAndStore(targetId, tenantId, scrapeImpl, lim);
  if (sendWebhook) result.webhookSent = await sendWebhook();
  return result;
}

/** 差分の検出と保存まで行い、Webhook は送らずに送る関数として返す (保存してから送る順を守る) */
async function checkAndStore(
  targetId: string,
  tenantId: string,
  scrapeImpl: typeof scrapeUrl,
  lim: Readonly<Limits>,
): Promise<{ result: WatchCheckResult; sendWebhook?: () => Promise<boolean> }> {
  const target = dbGetWatchTarget(targetId, tenantId);
  if (!target) {
    throw new Error(`Watch target not found: ${targetId}`);
  }

  // 同じウォッチの確認の最小の間隔（設計 6。穴 18・24）。間隔があるとき（0 でない）だけ、取得の前に、確認の権利を同期で取る
  // （同時の確認でも 1 つだけが通る。間隔が 0 のときは何も書かず、これまでと同じ）。取得に失敗しても、上流には届いているので、間隔に数える
  // （届く前の失敗は、下で戻す）。間隔は、確認の「始め」から数える（確認の結果を保存するときも、この時刻を使う）
  const claim = lim.watchMinIntervalMs > 0 ? dbClaimWatchCheck(target.id, tenantId, lim.watchMinIntervalMs) : undefined;
  const claimedAt = claim?.claimed ? claim.at : undefined;
  if (claim && !claim.claimed) {
    incrementSecurityCounter('sora_watch_too_frequent_total');
    const retryAfterSec = Math.ceil(claim.waitMs / 1000); // waitMs は 1 以上なので、1 以上
    throw new WatchLimitError(
      'WATCH_TOO_FREQUENT',
      `このウォッチは、前の確認から ${Math.round(lim.watchMinIntervalMs / 1000)} 秒以上空けて確認してください（あと ${retryAfterSec} 秒）`,
      Math.round(lim.watchMinIntervalMs / 1000),
      0,
      retryAfterSec,
    );
  }

  // スクレイピング実行。持ち主の tenant で取得する（保存済みのセッションも、持ち主のものを使う）
  let scraped: Awaited<ReturnType<typeof scrapeUrl>>;
  try {
    scraped = await scrapeImpl({
      url: target.url,
      selectors: target.selector ? { content: target.selector } : undefined,
      onlyMainContent: true,
      noCache: true,
      tenantId,
    });
  } catch (err) {
    // ブラウザの枠が混み合って断られた失敗は、上流に届く前なので、間隔に数えない（5 秒後の再試行が、15 分待ちにならないように）
    if (claim?.claimed && err instanceof ResourceBusyError) dbReleaseWatchCheck(target.id, tenantId, claim.at, claim.previous);
    throw err;
  }

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
    dbUpdateWatchTargetCheck(target.id, currentHash, cleanText.slice(0, 1000), claimedAt);
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
    dbUpdateWatchTargetCheck(target.id, currentHash, cleanText.slice(0, 1000), claimedAt);

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
    dbUpdateWatchTargetCheck(target.id, currentHash, target.last_content, claimedAt);
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

/** その tenant の全登録ターゲットの一括差分チェック（別の tenant の分は、取得も Webhook もしない） */
export async function checkAllWatchTargets(tenantId: string, scrapeImpl: typeof scrapeUrl = scrapeUrl, lim: Readonly<Limits> = currentLimits()): Promise<WatchCheckResult[]> {
  const targets = dbListWatchTargets(tenantId);
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
      const { result, sendWebhook } = await checkAndStore(t.id, tenantId, scrapeImpl, lim);
      results.push(result);
      // 保存したらすぐ送り始め、次の確認を待たせない。全部の返事は最後にまとめて待つ。
      // 送信が例外を投げても、ほかの対象の結果を失わない (その対象だけ false)
      if (sendWebhook) {
        deliveries.push(limited(sendWebhook).catch((err) => {
          // 送信の例外の文は宛先の URL（秘密を含みうる）を含むので、例外の種類だけを出す
          console.warn(`[Sora/Watch] Webhook delivery for watch target ${t.id} threw:`, errorKind(err));
          return false;
        }).then((sent) => { result.webhookSent = sent; }));
      }
    } catch (err) {
      // 最小の間隔の中のウォッチは、取得せずに見送る（失敗ではない。ほかのウォッチの確認は続ける）
      if (err instanceof WatchLimitError && err.code === 'WATCH_TOO_FREQUENT') {
        results.push({
          targetId: t.id,
          url: t.url,
          changed: false,
          currentHash: t.last_hash || '',
          diffSummary: `確認の間隔の中なので、見送りました（あと ${err.retryAfterSec} 秒）`,
          checkedAt: new Date(t.last_checked_at ?? Date.now()).toISOString(), // 実際に確認した時刻（いまではない）
          skipped: true,
          retryAfterSec: err.retryAfterSec,
        });
        continue;
      }
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

export function listWatchTargets(tenantId: string): WatchTargetRecord[] {
  return dbListWatchTargets(tenantId);
}

export function deleteWatchTarget(targetId: string, tenantId: string): boolean {
  return dbDeleteWatchTarget(targetId, tenantId);
}
