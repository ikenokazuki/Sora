/**
 * 出口のゲートウェイ（egress_gateway.ts）を、Sora の実行で使うための設定と、プロセスで 1 つの本体。
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 1。
 *
 * - SORA_EGRESS_GATEWAY（既定 off）: on で、ブラウザの外向きの通信を、ゲートウェイに通す。使わないユーザーには、何も起動しない（使うときに、初めて起動する）
 * - SORA_EGRESS_PORTS（既定 80,443）: 許す宛先ポート
 * - 運用者のプロキシ（SORA_PROXY_URL・HTTPS_PROXY など。net/proxy_config.ts）は、ゲートウェイの上流にする。NO_PROXY の宛先は、上流を使わず、
 *   ゲートウェイが直接つなぐ（検査は、同じに受ける）
 */
import { envBool, envError, envList, type Env } from '../config.js';
import { EgressGateway, type EgressGatewayOptions, parseUpstreamProxyUrl } from './egress_gateway.js';
import { isProxyBypassed } from './no_proxy.js';
import { getProxyConfig } from './proxy_config.js';

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[Sora] ${message}`);
}

/**
 * 起動の検査（checkEnv）を通らない経路（組み込み・テスト）でも、この設定の不正な値を、黙って既定にしない
 * （打ち間違いで、ゲートウェイが off になる・ポートが既定になる・運用者のプロキシを迂回して直接つなぐ、を防ぐ）。
 * 登録簿と同じ文（変数名と正しい形。秘密の値は出さない）で、エラーにする。
 */
function rejectInvalid(env: Env | undefined, ...names: ('SORA_EGRESS_GATEWAY' | 'SORA_EGRESS_PORTS' | 'SORA_PROXY_URL' | 'SORA_PROXY_LIST')[]): void {
  for (const name of names) {
    const problem = envError(name, env);
    if (problem) throw new Error(problem);
  }
}

/**
 * 外向きの通信を、出口のゲートウェイに通すか。SORA_EGRESS_GATEWAY が on（true・1・yes）のとき。
 * 書き方の誤りは、使わないことにせず、エラーにする。SORA_FETCH_ALLOW_PRIVATE_NETWORK=true（内部への取得を許す、開発・テスト用）のときは、使わない。
 * env を省略すると、プロセスの環境を読む。
 */
export function isEgressGatewayEnabled(env?: Env): boolean {
  rejectInvalid(env, 'SORA_EGRESS_GATEWAY');
  if (!envBool('SORA_EGRESS_GATEWAY', env)) return false;
  if (envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK', env)) {
    warnOnce('SORA_FETCH_ALLOW_PRIVATE_NETWORK=true（内部への取得を許す設定）なので、SORA_EGRESS_GATEWAY=on でも、出口のゲートウェイは使わない');
    return false;
  }
  return true;
}

/**
 * ブラウザが、この宛先の名前を、Sora の手元で（OS の DNS で）引くか。出口のゲートウェイ・運用者のプロキシ越しなら、相手が解決するので、引かない。
 * NO_PROXY の宛先は、プロキシを通さず、直接つなぐので、手元で引く（ゲートウェイを使うときは、NO_PROXY の宛先も、ゲートウェイが解決する）。
 */
export function browserResolvesLocally(host: string, env?: Env): boolean {
  if (isEgressGatewayEnabled(env)) return false;
  const { proxyServer, proxyBypassList } = getProxyConfig(env);
  return !proxyServer || isProxyBypassed(host, proxyBypassList);
}

/**
 * 環境変数から、ゲートウェイの設定を作る。運用者のプロキシは、上流にする（http・https・socks5 に対応。ほかは、エラー: 黙って、上流なしにしない）。
 * NO_PROXY の宛先は、上流を使わない。SORA_EGRESS_PORTS が未設定なら、ポートはゲートウェイの既定（80・443）。env を省略すると、プロセスの環境を読む。
 */
export function egressGatewayOptionsFromEnv(env?: Env): EgressGatewayOptions {
  rejectInvalid(env, 'SORA_EGRESS_PORTS', 'SORA_PROXY_URL', 'SORA_PROXY_LIST');
  // SORA_PROXY_LIST は、静的取得が、リクエストごとに替える一覧。ゲートウェイの上流は 1 つなので、黙って無視すると、替えているつもりで 1 つに偏る
  if (envList('SORA_PROXY_LIST', env).length > 0) throw new Error('SORA_PROXY_LIST（リクエストごとに替えるプロキシの一覧）は、SORA_EGRESS_GATEWAY=on のときは使えない（ゲートウェイの上流は、SORA_PROXY_URL などの 1 つ）');
  const options: EgressGatewayOptions = {};
  const allowedPorts = envList('SORA_EGRESS_PORTS', env).map(Number);
  if (allowedPorts.length > 0) options.allowedPorts = allowedPorts;
  const { proxyServer, proxyBypassList } = getProxyConfig(env);
  if (proxyServer) {
    options.upstream = parseUpstreamProxyUrl(proxyServer);
    if (proxyBypassList) options.bypassUpstream = (host) => isProxyBypassed(host, proxyBypassList);
  }
  return options;
}

export interface EgressEndpoint {
  host: string;
  port: number;
  /** ブラウザなどに、プロキシとして渡す URL */
  url: string;
}

let starting: Promise<EgressEndpoint> | undefined;
let running: EgressGateway | undefined;

/**
 * プロセスで 1 つの、出口のゲートウェイを返す（初めて呼ぶときに、ループバックで待ち受けを始める）。
 * 設定は、環境変数から。options は、最初の起動のときだけ、環境変数の設定より優先して使う（確認の道具が、検査の方針を差し替えるため）。
 * 起動に失敗しても、その失敗は覚えない（設定を直して、もう一度呼べる）。
 */
export function getEgressGateway(options: EgressGatewayOptions = {}): Promise<EgressEndpoint> {
  starting ??= (async () => {
    const gateway = new EgressGateway({ ...egressGatewayOptionsFromEnv(), ...options });
    const port = await gateway.start();
    running = gateway;
    return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` };
  })().catch((error) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/** ゲートウェイを止める（中継中の接続も切る）。次に getEgressGateway を呼ぶと、新しく始める */
export async function stopEgressGateway(): Promise<void> {
  const gateway = running;
  running = undefined;
  starting = undefined;
  await gateway?.stop();
}
