import { browserCdpMode, browserProcessUsage, browserSandboxStatus } from '../browser_engine.js';
import { isEgressGatewayEnabled, isEgressGatewayStarted } from '../net/egress.js';
import { type ApiKeyTableStatus, apiKeyTableStatus } from './api_keys.js';
import { isolationLevel } from './limits.js';

/** 隔離の状態（運用者が見る。/health?detailed=true と /metrics。設計 8）。水準が strict のときだけ返す */
export interface IsolationStatus {
  level: 'strict';
  browser: {
    /** 直近に起動した Chromium のサンドボックス。起動する前は unknown */
    sandbox: 'on' | 'off' | 'unknown';
    /** Chromium との接続。pipe は TCP のデバッグポートを開かない。port は 127.0.0.1 で待ち受ける */
    connection: 'pipe' | 'port';
    /** tenant ごとの Chromium のプロセス: いま番号（uid）を持っている数と、上限 */
    processes: { active: number; max: number };
  };
  /** 出口のゲートウェイ: 使う設定か・始めているか */
  egressGateway: { enabled: boolean; started: boolean };
  /** 鍵の表（鍵ファイルを使っていて、表があるときだけ）。stale は、前の鍵で動いている状態 */
  authKeys?: ApiKeyTableStatus;
}

/** 状態の取り出し口。テストが差し替える（本番は実際のものを読む） */
export interface StatusSources {
  sandbox: () => 'on' | 'off' | 'unknown';
  connection: () => 'pipe' | 'port';
  processes: () => { active: number; max: number };
  gatewayEnabled: () => boolean;
  gatewayStarted: () => boolean;
  authKeys: () => ApiKeyTableStatus | undefined;
}

export const statusSources: StatusSources = {
  sandbox: browserSandboxStatus,
  connection: () => browserCdpMode(),
  processes: browserProcessUsage,
  gatewayEnabled: () => isEgressGatewayEnabled(),
  gatewayStarted: isEgressGatewayStarted,
  authKeys: () => apiKeyTableStatus(),
};

/**
 * 隔離の状態。standard は undefined（何も調べず、応答を増やさない = 今までどおり）。strict は、管理者の鍵の関所の中でだけ呼ぶ
 * （サンドボックスが off など、守りの弱いところを、ほかの利用者に見せない）。ゲートウェイの設定が読めないときは、使わない扱い
 * （環境変数の書き方の誤りは、起動の検査が止める。ここで状態の取得ごと失敗させない）。
 */
export function isolationStatus(sources: StatusSources = statusSources): IsolationStatus | undefined {
  if (isolationLevel() !== 'strict') return undefined;
  let enabled = false;
  try {
    enabled = sources.gatewayEnabled();
  } catch {}
  const authKeys = sources.authKeys();
  return {
    level: 'strict',
    browser: { sandbox: sources.sandbox(), connection: sources.connection(), processes: sources.processes() },
    egressGateway: { enabled, started: sources.gatewayStarted() },
    ...(authKeys ? { authKeys } : {}),
  };
}

const gauge = (name: string, help: string, value: number): string[] => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];

/** Prometheus 形式の gauge の行（HELP・TYPE・値）。/metrics が足す。真偽は 1・0（サンドボックスが unknown のときは 0） */
export function isolationGaugeLines(status: IsolationStatus): string[] {
  const { browser, egressGateway, authKeys } = status;
  return [
    ...gauge('sora_isolation_strict', 'SORA_ISOLATION=strict (1 whenever this metric is present)', 1),
    ...gauge('sora_browser_sandbox_on', 'Chromium sandbox of the last launch is on (0: off, or no launch yet)', browser.sandbox === 'on' ? 1 : 0),
    ...gauge('sora_browser_cdp_pipe', 'Chromium is driven over a pipe (0: over a local TCP port)', browser.connection === 'pipe' ? 1 : 0),
    ...gauge('sora_browser_tenant_processes', 'Per-tenant Chromium processes holding a slot', browser.processes.active),
    ...gauge('sora_browser_tenant_processes_max', 'Upper limit of per-tenant Chromium processes', browser.processes.max),
    ...gauge('sora_egress_gateway_enabled', 'Egress gateway is configured on', egressGateway.enabled ? 1 : 0),
    ...gauge('sora_egress_gateway_started', 'Egress gateway is listening', egressGateway.started ? 1 : 0),
    ...(authKeys
      ? [
          ...gauge('sora_auth_keys_stale', 'Key file cannot be read; the previous key table is still in force (revoked keys remain valid)', authKeys.stale ? 1 : 0),
          ...gauge('sora_auth_keys_stale_seconds', 'Seconds the previous key table has been in force (0 when not stale)', authKeys.staleSeconds),
        ]
      : []),
  ];
}
