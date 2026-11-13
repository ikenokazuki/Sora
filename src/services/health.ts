import { existsSync } from 'fs';
import { getCacheSize } from '../cache.js';
import { getDb } from '../db.js';
import { sendWebhookNotification } from '../enrichment.js';
import { CHROME_EXECUTABLE_PATH, YAHOO_MCP_EXECUTABLE_PATH } from '../scraper.js';
import { getActiveSessionCount } from '../browser_session.js';
import { SORA_VERSION } from '../types.js';
import { errorKind, errorMessage } from '../errors.js';
import { envUrl } from '../config.js';

export interface DependencyStatus {
  status: 'ok' | 'error' | 'unavailable';
  latencyMs?: number;
  message?: string;
}

export interface DetailedHealthReport {
  status: 'ok' | 'degraded';
  service: 'sora';
  version: typeof SORA_VERSION;
  uptimeSeconds: number;
  cachedEntries: number;
  activeBrowserSessions: number;
  dependencies: {
    sqlite: DependencyStatus;
    chromium: DependencyStatus;
    yahooMcp: DependencyStatus;
    jma: DependencyStatus;
    p2pquake: DependencyStatus;
    egov: DependencyStatus;
  };
  timestamp: string;
}

const startTime = Date.now();

/** 外部エンドポイントの簡易疎通確認 (HTTP GET) */
async function probeEndpoint(url: string, timeoutMs = 3000): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Sora-Health-Check/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    if (res.ok || res.status === 404 || res.status === 400) {
      return { status: 'ok', latencyMs };
    }
    return { status: 'error', latencyMs, message: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start, message: errorMessage(err) || 'probe failed' };
  }
}

/** 外部の 3 か所への確認を、使い回す時間。鍵なしで開く経路が、呼ぶたびに外部へ通信しないように（設計 5・穴 14） */
const PROBE_TTL_MS = 60_000;
type ExternalProbes = [DependencyStatus, DependencyStatus, DependencyStatus];
let probeCache: { at: number; probes: Promise<ExternalProbes> } | undefined;

/**
 * 外部の 3 か所（気象庁・P2PQuake・e-Gov）への確認。1 分のうちは、前の結果を返す。同時の呼び出しは、1 組の確認にまとめる
 * （進行中の確認の Promise を使い回す）。失敗した確認の結果も、1 分のあいだ、そのまま返す（失敗を理由に取り直さない）
 */
function probeExternalDependencies(now: number): Promise<ExternalProbes> {
  if (probeCache && now >= probeCache.at && now - probeCache.at < PROBE_TTL_MS) return probeCache.probes;
  const probes = Promise.all([
    probeEndpoint('https://www.jma.go.jp/bosai/common/const/area.json', 3000),
    probeEndpoint('https://api.p2pquake.net/v2/history?codes=551&limit=1', 3000),
    probeEndpoint('https://laws.e-gov.go.jp/api/2/keyword?keyword=test', 4000),
  ]);
  probeCache = { at: now, probes };
  return probes; // probeEndpoint は、失敗も DependencyStatus として返し、例外を投げない
}

/** テスト用: 外部への確認の結果を捨てる */
export function resetHealthProbeCache(): void {
  probeCache = undefined;
}

/**
 * 詳細ヘルスチェックの実行。外部の 3 か所への確認は 1 分に 1 回まで（結果を使い回す）。SQLite・Chromium・キャッシュの件数などの
 * 内部の項目は、毎回、取り直す。now はキャッシュの期限の判定だけに使う（テスト用。省くと、いまの時刻）
 */
export async function checkDetailedHealth(options: { now?: number } = {}): Promise<DetailedHealthReport> {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startTime) / 1000);

  // SQLite チェック
  let sqliteStatus: DependencyStatus;
  const dbStart = Date.now();
  try {
    const db = getDb();
    db.query('SELECT 1').get();
    sqliteStatus = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err) {
    sqliteStatus = { status: 'error', latencyMs: Date.now() - dbStart, message: errorMessage(err) };
  }

  // Chromium チェック
  const chromiumStatus: DependencyStatus = {
    status: CHROME_EXECUTABLE_PATH ? 'ok' : 'unavailable',
    message: CHROME_EXECUTABLE_PATH ? undefined : 'CHROME_PATH not configured',
  };

  // Yahoo MCP チェック
  const yahooStatus: DependencyStatus = {
    status: existsSync(YAHOO_MCP_EXECUTABLE_PATH) ? 'ok' : 'unavailable',
    message: existsSync(YAHOO_MCP_EXECUTABLE_PATH) ? undefined : 'Yahoo MCP binary not found',
  };

  // 外部依存先の確認（1 分に 1 回まで）
  const [jma, p2pquake, egov] = await probeExternalDependencies(options.now ?? now);

  const isDegraded = sqliteStatus.status === 'error';

  const report: DetailedHealthReport = {
    status: isDegraded ? 'degraded' : 'ok',
    service: 'sora',
    version: SORA_VERSION,
    uptimeSeconds,
    cachedEntries: getCacheSize(),
    activeBrowserSessions: getActiveSessionCount(),
    dependencies: {
      sqlite: sqliteStatus,
      chromium: chromiumStatus,
      yahooMcp: yahooStatus,
      jma,
      p2pquake,
      egov,
    },
    timestamp: new Date().toISOString(),
  };

  // 管理者アラートは degraded（SQLite 障害）の場合のみ送信する。
  // 外部依存の瞬断では毎回発火させない。
  if (isDegraded) {
    sendAdminAlert('health.degraded', { sqlite: sqliteStatus.message ?? 'unknown' });
  }

  return report;
}

/** 管理者アラート通知 (Slack / Discord Webhook) */
export function sendAdminAlert(event: string, details: Record<string, any>): void {
  const alertWebhookUrl = envUrl('SORA_ALERT_WEBHOOK_URL');
  if (!alertWebhookUrl) return;

  const payload = {
    event: `sora.alert.${event}`,
    service: 'sora',
    level: 'warning',
    timestamp: new Date().toISOString(),
    details,
  };

  sendWebhookNotification(alertWebhookUrl, payload).catch((err) => {
    // 宛先の URL は秘密を含み、例外の文にも入るので、例外の種類だけを出す
    console.warn('[Sora/Alert] Failed to send admin alert:', errorKind(err));
  });
}
