// 運用者のプロキシの設定（環境変数）を読む。ブラウザ（browser_engine.ts）・静的取得（http_fetcher.ts）・出口のゲートウェイ（egress.ts）が共有する。
import { envStr, envUrl, type Env } from '../config.js';

/**
 * 環境変数からプロキシ設定を取得します。
 * 優先順位: SORA_PROXY_URL > HTTPS_PROXY / https_proxy > HTTP_PROXY / http_proxy > ALL_PROXY / all_proxy
 * NO_PROXY / no_proxy はプロキシ除外リストとして解釈されます。
 * env を省略すると、プロセスの環境を読みます（テスト用に渡せます）。
 */
export function getProxyConfig(env?: Env): { proxyServer?: string; proxyBypassList?: string } {
  // 標準の名前は検査しない文字列（scheme の無い host:port も Chromium は受け付ける）なので、ここで前後の空白を除く
  const first = (names: Parameters<typeof envStr>[0][]) => names.map((name) => envStr(name, env)?.trim()).find(Boolean);
  const proxyServer = envUrl('SORA_PROXY_URL', env) || first(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']);
  const proxyBypassList = first(['NO_PROXY', 'no_proxy']);
  return { proxyServer, proxyBypassList };
}
