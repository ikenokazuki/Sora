/**
 * 出口のゲートウェイ（egress_gateway.ts）を、Sora の実行で使うための設定と、プロセスで 1 つの本体。
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 1。
 *
 * - SORA_EGRESS_GATEWAY（既定 off）: on で、外向きの通信（ブラウザ・静的取得・Bun の fetch・子プロセス）を、ゲートウェイに通す。使わないユーザーには、何も起動しない（使うときに、初めて起動する）
 * - SORA_EGRESS_PORTS（既定 80,443）: 許す宛先ポート
 * - 運用者のプロキシ（SORA_PROXY_URL・HTTPS_PROXY など。net/proxy_config.ts）は、ゲートウェイの上流にする。NO_PROXY の宛先は、上流を使わず、
 *   ゲートウェイが直接つなぐ（検査は、同じに受ける）
 */
import { createHash } from 'node:crypto';
import { envBool, envError, envList, type Env } from '../config.js';
import { limits } from '../security/limits.js';
import { type EgressAllowedDestination, EgressGateway, type EgressGatewayOptions, parseUpstreamProxyUrl } from './egress_gateway.js';
import { canonicalHost, ipLiteralVersion, isAllowableInternalIp, isMetadataHostname, isPrivateIp } from './ip_policy.js';
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
function rejectInvalid(env: Env | undefined, ...names: ('SORA_EGRESS_GATEWAY' | 'SORA_EGRESS_PORTS' | 'SORA_EGRESS_ALLOW_HOSTS' | 'SORA_PROXY_URL' | 'SORA_PROXY_LIST')[]): void {
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
 * SORA_EGRESS_ALLOW_HOSTS の要素（`host:port`。登録簿が、書式を検査して、整えてある）を、宛先にする。
 * 挙げても通さない宛先（メタデータの名前・内部として通せない IP リテラル）は、黙って通さないままにせず、エラーにする。
 */
function parseAllowedDestination(entry: string): EgressAllowedDestination {
  const colon = entry.lastIndexOf(':');
  const host = canonicalHost(entry.slice(0, colon));
  const port = Number(entry.slice(colon + 1));
  const neverAllowed = isMetadataHostname(host) || (ipLiteralVersion(host) !== 0 && isPrivateIp(host) && !isAllowableInternalIp(host));
  if (neverAllowed) {
    throw new Error(`SORA_EGRESS_ALLOW_HOSTS に、挙げても通さない宛先があります: ${entry}（クラウドのメタデータの名前・IP、リンクローカル・未指定・マルチキャスト・予約の IP は、通せません）`);
  }
  return { host, port };
}

/**
 * 環境変数から、ゲートウェイの設定を作る。運用者のプロキシは、上流にする（http・https・socks5 に対応。ほかは、エラー: 黙って、上流なしにしない）。
 * NO_PROXY の宛先は、上流を使わない。SORA_EGRESS_PORTS が未設定なら、ポートはゲートウェイの既定（80・443）。env を省略すると、プロセスの環境を読む。
 */
export function egressGatewayOptionsFromEnv(env?: Env): EgressGatewayOptions {
  rejectInvalid(env, 'SORA_EGRESS_PORTS', 'SORA_EGRESS_ALLOW_HOSTS', 'SORA_PROXY_URL', 'SORA_PROXY_LIST');
  // SORA_PROXY_LIST は、静的取得が、リクエストごとに替える一覧。ゲートウェイの上流は 1 つなので、黙って無視すると、替えているつもりで 1 つに偏る
  if (envList('SORA_PROXY_LIST', env).length > 0) throw new Error('SORA_PROXY_LIST（リクエストごとに替えるプロキシの一覧）は、SORA_EGRESS_GATEWAY=on のときは使えない（ゲートウェイの上流は、SORA_PROXY_URL などの 1 つ）');
  const options: EgressGatewayOptions = {};
  const allowedPorts = envList('SORA_EGRESS_PORTS', env).map(Number);
  if (allowedPorts.length > 0) options.allowedPorts = allowedPorts;
  const allowDestinations = envList('SORA_EGRESS_ALLOW_HOSTS', env).map(parseAllowedDestination);
  if (allowDestinations.length > 0) options.allowDestinations = allowDestinations;
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
/** ブラウザのプロセスの番号ごとの受け口（のポート）と、いまその番号を持つ利用者の印 */
const slotListeners = new Map<number, Promise<number>>();
const slotOwners = new Map<number, string>();

/**
 * プロセスで 1 つの、出口のゲートウェイを返す（初めて呼ぶときに、ループバックで待ち受けを始める）。
 * 設定は、環境変数から。1 人が同時に持てる接続の割合は、水準の表（egressTenantSharePercent）から。
 * options は、最初の起動のときだけ、環境変数の設定より優先して使う（確認の道具が、検査の方針を差し替えるため）。
 * 起動に失敗しても、その失敗は覚えない（設定を直して、もう一度呼べる）。
 */
export function getEgressGateway(options: EgressGatewayOptions = {}): Promise<EgressEndpoint> {
  starting ??= (async () => {
    const gateway = new EgressGateway({ ...egressGatewayOptionsFromEnv(), ownerSharePercent: limits().egressTenantSharePercent, ...options });
    const port = await gateway.start();
    running = gateway;
    return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` };
  })().catch((error) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/** ゲートウェイを始めたか（始めている途中も含む）。使わないユーザーに、何も起動していないことの確認に使う */
export function isEgressGatewayStarted(): boolean {
  return starting !== undefined;
}

/**
 * ゲートウェイが、利用者を見分ける印（利用者の ID のハッシュの先頭 16 進 24 字）。利用者の名前は、プロキシの URL（エラーの文に出ることがある）に出さない。
 * ゲートウェイは、印ごとに同時の接続を数える（egressTenantSharePercent）
 */
export function egressOwnerToken(tenantId: string): string {
  return createHash('sha256').update(`sora-egress-owner:${tenantId}`).digest('hex').slice(0, 24);
}

/**
 * 本体の取得（wreq-js・Bun の fetch）に使う、利用者の印を付けたゲートウェイの URL（`http://<印>:@127.0.0.1:<port>`）。
 * どちらも、URL の名前を Proxy-Authorization（Basic）でゲートウェイに送る（平文の要求にも CONNECT にも。2026-11-27 に実測）
 */
export async function egressProxyUrlFor(tenantId: string): Promise<string> {
  const { host, port } = await getEgressGateway();
  return `http://${egressOwnerToken(tenantId)}:@${host}:${port}`;
}

/**
 * ブラウザのプロセスの番号（slot）ごとの受け口。Chromium は、プロキシに資格情報を送れないので、プロセスごとに受け口を分けて、
 * そこへの接続を、いまその番号を持つ利用者（tenantId）の数に入れる。受け口は番号ごとに 1 つ（番号の数は SORA_BROWSER_MAX_PROCESSES まで）で、
 * 番号を別の利用者に渡すとき（前のプロセスを閉じて、残りを片づけてから起動する）に、呼び直して利用者を替える
 */
export async function egressEndpointForSlot(slot: number, tenantId: string): Promise<EgressEndpoint> {
  slotOwners.set(slot, egressOwnerToken(tenantId));
  await getEgressGateway();
  let listening = slotListeners.get(slot);
  if (!listening) {
    const gateway = running;
    if (!gateway) throw new Error('出口のゲートウェイは止まった');
    listening = gateway.addListener(() => slotOwners.get(slot) ?? '');
    slotListeners.set(slot, listening);
    listening.catch(() => {
      if (slotListeners.get(slot) === listening) slotListeners.delete(slot);
    });
  }
  const port = await listening;
  return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` };
}

/** その利用者の接続が、ゲートウェイの上限（egressTenantSharePercent）に達しているか。ゲートウェイが動いていなければ false */
export function egressOwnerAtLimit(tenantId: string): boolean {
  return running?.ownerAtLimit(egressOwnerToken(tenantId)) ?? false;
}

/**
 * 子プロセス（Yahoo の検索バイナリ・住所データの構築）の環境変数に足す、出口のゲートウェイの指定（`childEnv` の extra に渡す）。
 * 使わないときは空（子プロセスの環境は、これまでどおり）。使うときは、HTTP_PROXY・HTTPS_PROXY（大文字・小文字）をゲートウェイの URL にし、
 * ALL_PROXY・NO_PROXY は消す: 運用者の上流のプロキシと NO_PROXY は、ゲートウェイが受け持つ。残すと、子が、ゲートウェイを通さず、直接つなぐ
 * （Yahoo のバイナリは、NO_PROXY の宛先に、プロキシを使わず、直接つなぐ。2026-11-13 に実測）。
 * 環境変数だけの指定なので、守らない子プロセスや、乗っ取られた子プロセスは、止められない（ネットワークの分離が受け持つ。設計 7）。
 * ゲートウェイを始められないとき（設定の誤り）は失敗する（子プロセスに、直接の経路を、黙って渡さない）。
 */
export async function egressChildProxyEnv(): Promise<Record<string, string | undefined>> {
  if (!isEgressGatewayEnabled()) return {};
  const { url } = await getEgressGateway();
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: undefined, all_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined };
}

/** ゲートウェイを止める（番号ごとの受け口も、中継中の接続も切る）。次に getEgressGateway を呼ぶと、新しく始める */
export async function stopEgressGateway(): Promise<void> {
  const gateway = running;
  running = undefined;
  starting = undefined;
  slotListeners.clear();
  await gateway?.stop();
}
