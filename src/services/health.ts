import { existsSync } from 'fs';
import { getCacheSize } from '../cache.js';
import { getDb } from '../db.js';
import { sendWebhookNotification } from '../enrichment.js';
import { CHROME_EXECUTABLE_PATH, YAHOO_MCP_PATH } from '../scraper.js';
import { getActiveSessionCount } from '../browser_session.js';

export interface DependencyStatus {
  status: 'ok' | 'error' | 'unavailable';
  latencyMs?: number;
  message?: string;
}

export interface DetailedHealthReport {
  status: 'ok' | 'degraded';
  service: 'sora';
  version: '2.0.0';
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
  } catch (err: any) {
    return { status: 'error', latencyMs: Date.now() - start, message: err?.message || 'probe failed' };
  }
}

/** 詳細ヘルスチェックの実行 */
export async function checkDetailedHealth(): Promise<DetailedHealthReport> {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startTime) / 1000);

  // SQLite チェック
  let sqliteStatus: DependencyStatus;
  const dbStart = Date.now();
  try {
    const db = getDb();
    db.query('SELECT 1').get();
    sqliteStatus = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err: any) {
    sqliteStatus = { status: 'error', latencyMs: Date.now() - dbStart, message: err?.message };
  }

  // Chromium チェック
  const chromiumStatus: DependencyStatus = {
    status: CHROME_EXECUTABLE_PATH ? 'ok' : 'unavailable',
    message: CHROME_EXECUTABLE_PATH ? undefined : 'CHROME_PATH not configured',
  };

  // Yahoo MCP チェック
  const yahooStatus: DependencyStatus = {
    status: existsSync(YAHOO_MCP_PATH) ? 'ok' : 'unavailable',
    message: existsSync(YAHOO_MCP_PATH) ? undefined : 'Yahoo MCP binary not found',
  };

  // 外部依存先並行プローブ
  const [jma, p2pquake, egov] = await Promise.all([
    probeEndpoint('https://www.jma.go.jp/bosai/common/const/area.json', 3000),
    probeEndpoint('https://api.p2pquake.net/v2/history?codes=551&limit=1', 3000),
    probeEndpoint('https://laws.e-gov.go.jp/api/2/keyword?keyword=test', 4000),
  ]);

  const isDegraded = sqliteStatus.status === 'error';

  return {
    status: isDegraded ? 'degraded' : 'ok',
    service: 'sora',
    version: '2.0.0',
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
}

/** 管理者アラート通知 (Slack / Discord Webhook) */
export function sendAdminAlert(event: string, details: Record<string, any>): void {
  const alertWebhookUrl = process.env.ADMIN_ALERT_WEBHOOK_URL;
  if (!alertWebhookUrl) return;

  const payload = {
    event: `sora.alert.${event}`,
    service: 'sora',
    level: 'warning',
    timestamp: new Date().toISOString(),
    details,
  };

  sendWebhookNotification(alertWebhookUrl, payload).catch((err) => {
    console.warn('[Sora/Alert] Failed to send admin alert:', err?.message || err);
  });
}
