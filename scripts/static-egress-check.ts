/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: 静的取得（wreq-js。fetchWithSafeRedirects）を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on）に通すと、
 *  (1) DNS rebinding（検査のときは解決できない名前が、ゲートウェイの解決では内部の IP になる）は、ゲートウェイが断り、宛先のサーバーには何も届かない
 *      （http は 403 と X-Sora-Egress-Deny、https は接続の失敗）
 *  (2) 名前は、ゲートウェイが解決して、宛先に届く（OS では解決できない名前でも届く）
 *  (3) TLS の ClientHello は、ゲートウェイ経由でも、直接のときと変わらない（SNI だけが、宛先の名前の違いで変わる）
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/static-egress-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 1）
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeHttpSession, fetchWithSafeRedirects } from '../src/http_fetcher.js';
import { getEgressGateway, stopEgressGateway } from '../src/net/egress.js';
import { getSecurityMetrics } from '../src/security/metrics.js';
import { startCaptureServer } from './tls-fingerprint/capture.js';
import { type ClientHello, diffHellos } from './tls-fingerprint/client_hello.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// 宛先の道具: 要求を数える HTTP サーバーと、ClientHello だけを受け取るサーバー（どちらも、127.0.0.1 = 内部の宛先）
const hits: string[] = [];
const web = createServer((request, response) => {
  hits.push(`${request.method} ${request.url}`);
  response.end('web-ok');
}).listen(0, '127.0.0.1');
await once(web, 'listening');
const webPort = (web.address() as AddressInfo).port;
const capture = await startCaptureServer();

// ゲートウェイの設定は、環境変数から（運用の設定と同じ道）。宛先のポートだけ、許す
process.env.SORA_EGRESS_PORTS = `${webPort},${capture.port}`;
process.env.SORA_EGRESS_GATEWAY = 'on';

/** SNI を指定して、ClientHello を取り出す */
async function helloFor(serverName: string): Promise<ClientHello> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const hello = await capture.next();
    if (hello.serverName === serverName) return hello;
  }
  throw new Error(`SNI が ${serverName} の ClientHello が届かない`);
}

async function restartGateway(options: Parameters<typeof getEgressGateway>[0]): Promise<void> {
  await stopEgressGateway();
  await getEgressGateway(options);
}

// (1) 既定の方針: DNS rebinding は、ゲートウェイが断る。名前の解決だけ差し替える（rebind.test は、OS では解決できないが、ゲートウェイは 127.0.0.1 と答える）
await restartGateway({
  resolve: async (host) => {
    if (host === 'rebind.test') return ['127.0.0.1'];
    throw new Error(`ENOTFOUND ${host}`);
  },
});
{
  const http = await fetchWithSafeRedirects(`http://rebind.test:${webPort}/`, 15_000, 0).then(
    ({ response }) => ({ status: response.status, deny: response.headers.get('x-sora-egress-deny') }),
    (error: unknown) => ({ error: String(error) }),
  );
  check('status' in http && http.status === 403 && http.deny === 'private_ip', `http の DNS rebinding が、ゲートウェイに断られていない: ${JSON.stringify(http)}`);
  const https = await fetchWithSafeRedirects(`https://rebind.test:${webPort}/`, 15_000, 0).then(
    () => 'reached',
    () => 'failed',
  );
  check(https === 'failed', 'https の DNS rebinding が、トンネルの失敗になっていない（宛先に届いた）');
  check(hits.length === 0, `内部の宛先のサーバーに、要求が届いた: ${hits.join(', ')}`);
  const denied = getSecurityMetrics().sora_egress_denied_private_ip_total ?? 0;
  check(denied >= 2, `ゲートウェイが、内部の宛先の拒否を数えていない: ${denied}`);
}
await closeHttpSession('rebind.test');

// (2) 名前は、ゲートウェイが解決する（OS では解決できない名前の宛先に、ゲートウェイ経由で届く）
const resolved: string[] = [];
await restartGateway({
  isPrivateIp: () => false, // この宛先（127.0.0.1 の自前のサーバー）は、公開として扱う（ゲートウェイを通ることを確かめるため）
  resolve: async (host) => {
    resolved.push(host);
    if (host === 'web.test' || host === 'capture.test') return ['127.0.0.1'];
    throw new Error(`ENOTFOUND ${host}`);
  },
});
let viaGateway: ClientHello | undefined;
{
  const result = await fetchWithSafeRedirects(`http://web.test:${webPort}/p?x=1`, 15_000, 0).then(
    async ({ response }) => ({ status: response.status, body: await response.text() }),
    (error: unknown) => ({ error: String(error) }),
  );
  check('status' in result && result.status === 200 && result.body === 'web-ok', `ゲートウェイ経由で、名前の宛先に届かない: ${JSON.stringify(result)}`);
  check(hits.includes('GET /p?x=1'), `宛先が、origin-form の要求を受けていない: ${hits.join(', ')}`);
  check(resolved.includes('web.test'), `名前を、ゲートウェイが解決していない: ${resolved.join(', ')}`);
  // ClientHello（TLS）: 接続は切られて失敗する。それが想定どおり
  void fetchWithSafeRedirects(`https://capture.test:${capture.port}/`, 15_000, 0).catch(() => {});
  viaGateway = await helloFor('capture.test');
}
await closeHttpSession('web.test');
await closeHttpSession('capture.test');
await stopEgressGateway();

// (3) 直接（ゲートウェイなし）の ClientHello と比べる: SNI（宛先の名前）だけが違う
{
  process.env.SORA_EGRESS_GATEWAY = 'off';
  process.env.ALLOW_LOCAL_FETCH = 'true'; // 内部（localhost）への、直接の取得を許す（比べる相手を取るため）
  void fetchWithSafeRedirects(`https://localhost:${capture.port}/`, 15_000, 0).catch(() => {});
  const direct = await helloFor('localhost');
  const differences = diffHellos(direct, viaGateway as ClientHello).filter((difference) => difference.field !== 'serverName');
  check(differences.length === 0, `ゲートウェイ経由で、静的取得の ClientHello が変わった: ${JSON.stringify(differences)}`);
  check(direct.serverName === 'localhost' && viaGateway?.serverName === 'capture.test', `SNI が想定と違う: 直接=${direct.serverName} ゲートウェイ経由=${viaGateway?.serverName}`);
}
await closeHttpSession('localhost');
await capture.close();
web.close();

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: 静的取得の通信は、すべて出口のゲートウェイを通る。DNS rebinding は断られ、名前はゲートウェイが解決し、ClientHello は直接のときと変わらない');
process.exit(0);
