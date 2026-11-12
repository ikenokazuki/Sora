// 運用者のプロキシの設定（環境変数）を読む。ブラウザ（browser_engine.ts）・静的取得（http_fetcher.ts）・出口のゲートウェイ（egress.ts）が共有する。

/**
 * 環境変数からプロキシ設定を取得します。
 * 優先順位: SORA_PROXY_URL > HTTPS_PROXY / https_proxy > HTTP_PROXY / http_proxy > ALL_PROXY / all_proxy
 * NO_PROXY / no_proxy はプロキシ除外リストとして解釈されます。
 */
export function getProxyConfig(env: NodeJS.ProcessEnv = process.env): { proxyServer?: string; proxyBypassList?: string } {
  const proxyServer =
    env.SORA_PROXY_URL?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim() ||
    undefined;

  const proxyBypassList =
    env.NO_PROXY?.trim() ||
    env.no_proxy?.trim() ||
    undefined;

  return { proxyServer, proxyBypassList };
}
