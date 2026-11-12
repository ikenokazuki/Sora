/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: Sora のブラウザ（getBrowser）を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on）に通すと、
 *  (1) 内部の宛先（ループバック）は、ゲートウェイが断り（http は 403 と X-Sora-Egress-Deny、https はトンネルの失敗）、宛先のサーバーには何も届かない
 *  (2) 名前は、ゲートウェイが解決する（ブラウザ自身は、OS で解決できない名前の宛先に、届く）
 *  (3) ブラウザの ClientHello は、ゲートウェイ経由でも、直接のときと変わらない（SNI だけが、宛先の名前の違いで変わる）
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/browser-egress-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 1）
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'puppeteer-core';
import { closeSharedBrowser, getBrowser } from '../src/browser_engine.js';
import { getEgressGateway, stopEgressGateway } from '../src/net/egress.js';
import { getSecurityMetrics } from '../src/security/metrics.js';
import { startCaptureServer } from './tls-fingerprint/capture.js';
import { type ClientHello, diffHellos } from './tls-fingerprint/client_hello.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// 宛先の道具: 接続を数える HTTP サーバーと、ClientHello だけを受け取るサーバー（どちらも、127.0.0.1 = 内部の宛先）
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

/** ページを開く。応答（頭部）か、失敗の文を返す */
async function visit(page: Page, url: string): Promise<{ status?: number; deny?: string; error?: string; body?: string }> {
  try {
    const response = await page.goto(url, { timeout: 15_000, waitUntil: 'domcontentloaded' });
    return { status: response?.status(), deny: response?.headers()['x-sora-egress-deny'], body: await page.evaluate(() => document.body?.innerText ?? '') };
  } catch (error) {
    return { error: String(error) };
  }
}

/** SNI を指定して、ClientHello を取り出す（ブラウザは、1 回の遷移で、複数の接続を作ることがある） */
async function helloFor(serverName: string): Promise<ClientHello> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const hello = await capture.next();
    if (hello.serverName === serverName) return hello;
  }
  throw new Error(`SNI が ${serverName} の ClientHello が届かない`);
}

async function restartBrowser(): Promise<void> {
  await closeSharedBrowser();
  await stopEgressGateway();
}

// (1) 既定の方針: 内部の宛先は、ゲートウェイが断る
{
  const { browser } = await getBrowser();
  const spawnArgs = browser.process()?.spawnargs ?? [];
  for (const flag of ['--proxy-bypass-list=<-loopback>', '--disable-quic']) check(spawnArgs.includes(flag), `Chromium の起動引数に ${flag} が無い`);
  check(spawnArgs.some((arg) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(arg)), `Chromium が、ゲートウェイ（ループバック）をプロキシにしていない: ${spawnArgs.filter((arg) => arg.startsWith('--proxy')).join(' ')}`);
  check(spawnArgs.includes('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'), 'Chromium の起動引数に、ブラウザ自身の名前解決を止める --host-resolver-rules が無い');

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const http = await visit(page, `http://127.0.0.1:${webPort}/`);
  check(http.status === 403 && http.deny === 'private_ip', `http://127.0.0.1 が、ゲートウェイに断られていない: ${JSON.stringify(http)}`);
  const https = await visit(page, `https://127.0.0.1:${webPort}/`);
  check(https.error !== undefined && https.status === undefined, `https://127.0.0.1 が、トンネルの失敗になっていない: ${JSON.stringify(https)}`);
  // 別の書き方でも、断られる（ブラウザが整える前の書き方は、ゲートウェイ側でも判定する）
  const decimal = await visit(page, `http://2130706433:${webPort}/`);
  check(decimal.status === 403 || decimal.error !== undefined, `http://2130706433（127.0.0.1 の別の書き方）が通った: ${JSON.stringify(decimal)}`);
  check(hits.length === 0, `内部の宛先のサーバーに、要求が届いた: ${hits.join(', ')}`);
  const denied = getSecurityMetrics().sora_egress_denied_private_ip_total ?? 0;
  check(denied >= 2, `ゲートウェイが、内部の宛先の拒否を数えていない: ${denied}`);
  await context.close();
}
await restartBrowser();

// (2) 名前は、ゲートウェイが解決する（OS では解決できない名前の宛先に、ゲートウェイ経由で届く）
const resolved: string[] = [];
let viaGateway: ClientHello | undefined;
{
  await getEgressGateway({
    isPrivateIp: () => false, // この宛先（127.0.0.1 の自前のサーバー）は、公開として扱う（ゲートウェイを通ることを確かめるため）
    resolve: async (host) => {
      resolved.push(host);
      if (host === 'web.test' || host === 'capture.test') return ['127.0.0.1'];
      throw new Error(`ENOTFOUND ${host}`);
    },
  });
  const { browser } = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const result = await visit(page, `http://web.test:${webPort}/p?x=1`);
  check(result.status === 200 && result.body === 'web-ok', `ゲートウェイ経由で、名前の宛先に届かない: ${JSON.stringify(result)}`);
  check(hits.includes('GET /p?x=1'), `宛先が、origin-form の要求を受けていない: ${hits.join(', ')}`);
  check(resolved.includes('web.test'), `名前を、ゲートウェイが解決していない: ${resolved.join(', ')}`);
  // ClientHello（TLS）: 接続は切られて失敗する。それが想定どおり
  void page.goto(`https://capture.test:${capture.port}/`, { timeout: 15_000 }).catch(() => {});
  viaGateway = await helloFor('capture.test');
  await context.close();
}
await restartBrowser();

// (3) 直接（ゲートウェイなし）の ClientHello と比べる: SNI（宛先の名前）だけが違う
{
  process.env.SORA_EGRESS_GATEWAY = 'off';
  const { browser } = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  void page.goto(`https://localhost:${capture.port}/`, { timeout: 15_000 }).catch(() => {});
  const direct = await helloFor('localhost');
  await context.close();
  const differences = diffHellos(direct, viaGateway as ClientHello).filter((difference) => difference.field !== 'serverName');
  check(differences.length === 0, `ゲートウェイ経由で、ブラウザの ClientHello が変わった: ${JSON.stringify(differences)}`);
  check(direct.serverName === 'localhost' && viaGateway?.serverName === 'capture.test', `SNI が想定と違う: 直接=${direct.serverName} ゲートウェイ経由=${viaGateway?.serverName}`);
}
await closeSharedBrowser();
await capture.close();
web.close();

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: ブラウザの通信は、すべて出口のゲートウェイを通る。内部の宛先は断られ、名前はゲートウェイが解決し、ClientHello は直接のときと変わらない');
process.exit(0);
