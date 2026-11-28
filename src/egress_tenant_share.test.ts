import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHttpSession } from './http_fetcher.js';
import { app } from './index.js';
import { egressOwnerAtLimit, getEgressGateway, stopEgressGateway } from './net/egress.js';
import { createEgressTestKit, fakeResolver } from './net/egress_test_kit.js';
import { resetApiKeyStoreCache } from './security/api_keys.js';
import { tenantIdForName } from './security/tenant_context.js';

/**
 * 出口のゲートウェイの接続を、利用者ごとに数える（監査 8）。以前は全体の 512 本だけで、1 人が止まるページを大量に取ると、
 * ゲートウェイが埋まり、ほかの利用者の取得が全部断られた（時間切れのあとも、wreq-js が接続を閉じないので、数分続いた）。
 * 本物のアプリ（認証 → /scrape → 静的取得 → ゲートウェイ）で、1 人が自分の上限で止まり、ほかの利用者は取れることを見る。
 */
const MALLORY = 'mallory-key-0123456789abcdef';
const VICTIM = 'victim-key-0123456789abcdefg';
const kit = createEgressTestKit();
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_EGRESS_GATEWAY', 'SORA_AUTH_KEYS_FILE', 'SORA_API_KEY', 'SORA_ALLOW_ANONYMOUS'];
/** mallory が取る、止まるページの宛先。mallory の上限（ここでは 2 本）より多い。利用者ごとの上限が無ければ、10 本とも接続を握る */
const stalledHosts = Array.from({ length: 10 }, (_, i) => `s${i}.test`);
let saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  for (const key of touchedKeys) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sora-egress-share-'));
  const path = join(dir, 'keys.json');
  writeFileSync(path, JSON.stringify({ keys: [{ name: 'mallory', key: MALLORY }, { name: 'victim', key: VICTIM }] }), { mode: 0o600 });
  chmodSync(path, 0o600);
  process.env.SORA_AUTH_KEYS_FILE = path;
  process.env.SORA_EGRESS_GATEWAY = 'on';
  resetApiKeyStoreCache();
});

afterEach(async () => {
  await stopEgressGateway();
  for (const host of [...stalledHosts, 'ok.test']) for (const name of ['mallory', 'victim']) await closeHttpSession(host, tenantIdForName(name));
  await kit.cleanup();
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
  for (const key of touchedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const scrape = (key: string, url: string) =>
  app.fetch(
    new Request('http://localhost/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mode: 'fast', timeoutMs: 3000, noCache: true }),
    }),
    { remoteAddr: null },
  );

describe('出口のゲートウェイの接続は、利用者ごとに数える', () => {
  test('1 人が、止まるページを自分の上限より多く取ると、その人の分だけが断られ（429）、ほかの利用者は取れる', async () => {
    // 頭部と本文の一部だけを送り、本文を終えない宛先（長さは決めない: wreq-js は、Content-Length の小さい応答を、本文を全部読んでから返す）
    const stalled = await kit.startTcpServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n'));
    });
    const ok = await kit.startOrigin('<html><head><title>ok</title></head><body><main><h1>hello</h1><p>This page is fine and has enough words to read.</p></main></body></html>');
    const { resolve } = fakeResolver(Object.fromEntries([...stalledHosts, 'ok.test'].map((host) => [host, ['127.0.0.1']])));
    // 全体（40 本）は、mallory の 10 本より大きくする。全体が満杯のときの断りは、頭部を読む前に返すので、混んだ機械では、wreq-js の側でエラー（429 でない）になることがある
    await getEgressGateway({ allowedPorts: [stalled.port, ok.port], resolve, isPrivateIp: () => false, maxConnections: 40, ownerSharePercent: 5 }); // 1 人 2 本

    const malloryRequests = stalledHosts.map((host) => scrape(MALLORY, `http://${host}:${stalled.port}/`));
    // mallory の 2 本が、ゲートウェイの接続を握るまで待つ
    const deadline = Date.now() + 3000;
    while (!egressOwnerAtLimit(tenantIdForName('mallory')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(egressOwnerAtLimit(tenantIdForName('mallory'))).toBe(true);

    const victim = await scrape(VICTIM, `http://ok.test:${ok.port}/`);
    expect(victim.status).toBe(200);
    expect(JSON.stringify(await victim.json())).toContain('hello');

    const statuses = (await Promise.all(malloryRequests)).map((response) => response.status);
    expect(statuses.filter((status) => status === 429)).toHaveLength(8); // 上限を超えた 8 本は、試さずに（か、ゲートウェイに断られて）429
    expect(statuses.filter((status) => status === 408)).toHaveLength(2); // 握った 2 本は、本文の時間切れ
    expect(stalled.connections).toHaveLength(2);

    // 時間切れのあとも、wreq-js は止まった接続を閉じない（mallory の分に残る）。それでも、ほかの利用者は取れる
    const after = await scrape(VICTIM, `http://ok.test:${ok.port}/again`);
    expect(after.status).toBe(200);
  }, 20_000);
});
