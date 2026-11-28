import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError } from './errors.js';
import { closeHttpSession, fetchWithSafeRedirects, NativeFetchSession } from './http_fetcher.js';
import { egressOwnerAtLimit, egressProxyUrlFor, getEgressGateway, stopEgressGateway } from './net/egress.js';
import { createEgressTestKit, fakeResolver } from './net/egress_test_kit.js';
import { runAsCaller } from './security/caller.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { withEnv } from './test_fixtures/env.js';

// 静的取得（wreq-js）が、SORA_EGRESS_GATEWAY=on のとき、出口のゲートウェイを通ること。
// テストの事前設定（test_preload.ts）は、外へ出ないよう、プロキシの環境変数に、閉じたポートの架空のプロキシを入れている。
// ゲートウェイは、それを運用者の上流として読むので、このファイルの間だけ外す
const kit = createEgressTestKit();
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_EGRESS_GATEWAY'];
const hosts = ['web.test', 'rebind.test', 'native.test', 'other.test', '127.0.0.1'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  for (const key of touchedKeys) delete process.env[key];
  process.env.SORA_EGRESS_GATEWAY = 'on';
  resetSecurityMetrics();
});

afterEach(async () => {
  for (const host of hosts) await closeHttpSession(host); // 取得のセッションは、作ったときのプロキシ（ゲートウェイのポート）を覚えているので、テストごとに捨てる
  await stopEgressGateway();
  await kit.cleanup();
  for (const key of touchedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('fetchWithSafeRedirects と出口のゲートウェイ', () => {
  test('on のとき、名前は、ゲートウェイが解決する。宛先は、origin-form の要求を受ける（OS では解決できない名前でも届く）', async () => {
    const origin = await kit.startOrigin('web-ok');
    const { resolve, calls } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });

    const { response } = await fetchWithSafeRedirects(`http://web.test:${origin.port}/p?x=1`, 5000, 0);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('web-ok');
    expect(origin.requests[0].head.split('\r\n')[0]).toBe('GET /p?x=1 HTTP/1.1');
    expect(origin.requests[0].head).toMatch(new RegExp(`^host: web\\.test:${origin.port}$`, 'im'));
    expect(calls).toContain('web.test');
  });

  test('検査のときは解決できない名前が、ゲートウェイの解決で内部の IP になっても（DNS rebinding）、宛先には届かない。403 と理由が返る', async () => {
    const origin = await kit.startOrigin('secret');
    const { resolve } = fakeResolver({ 'rebind.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [origin.port], resolve }); // 判定は既定（内部の IP は断る）

    const { response } = await fetchWithSafeRedirects(`http://rebind.test:${origin.port}/`, 5000, 0);

    expect(response.status).toBe(403);
    expect(response.headers.get('x-sora-egress-deny')).toBe('private_ip');
    expect(origin.requests).toHaveLength(0);
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('https（CONNECT）でも、内部の IP になる名前は、トンネルを張れず、宛先には何も届かない', async () => {
    const origin = await kit.startOrigin('secret');
    const { resolve } = fakeResolver({ 'rebind.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [origin.port], resolve });

    await expect(fetchWithSafeRedirects(`https://rebind.test:${origin.port}/`, 5000, 0)).rejects.toThrow();

    expect(origin.received).toHaveLength(0);
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('平文 http の要求の頭部は、ゲートウェイを通しても、wreq が出した順序・表記のまま（違うのは、宛先の名前の Host と、末尾の Connection: close だけ）', async () => {
    const origin = await kit.startOrigin('x');
    const headers = { 'X-Custom': 'v' };
    // 比べる相手: ゲートウェイを通さない取得（内部への取得を許す設定で、宛先は 127.0.0.1）
    process.env.SORA_EGRESS_GATEWAY = 'off';
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    await fetchWithSafeRedirects(`http://127.0.0.1:${origin.port}/a?x=1`, 5000, 0, headers);
    delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.SORA_EGRESS_GATEWAY = 'on';
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });
    await fetchWithSafeRedirects(`http://web.test:${origin.port}/a?x=1`, 5000, 0, headers);

    const [direct, viaGateway] = origin.requests.map((request) => request.head.split('\r\n'));
    const comparable = (lines: string[]) => lines.filter((line) => !/^(host|connection):/i.test(line));
    expect(comparable(viaGateway)).toEqual(comparable(direct));
    expect(comparable(direct).length).toBeGreaterThan(8); // 比べているのが、wreq の Chrome らしい頭部（sec-ch-ua・Accept など）であること
    expect(viaGateway[1]).toMatch(/^Host: web\.test:\d+$/); // Host は先頭
    expect(viaGateway.at(-1)).toBe('Connection: close');
  });

  test('取得ごとのプロキシの指定（proxyUrl）は、on のときはエラー。黙って無視すると、ゲートウェイを迂回したと思わせる', async () => {
    await expect(fetchWithSafeRedirects('http://other.test/', 1000, 0, undefined, undefined, 'http://other-proxy.example:8080')).rejects.toThrow('SORA_EGRESS_GATEWAY');
  });
});

describe('利用者ごとの接続の数（ゲートウェイが印で数える）', () => {
  /** 頭部と本文の一部を送り、本文を終えない宛先（取得は頭部で返り、接続は開いたまま）。長さは決めない（chunked）: wreq-js は、Content-Length の小さい応答を、本文を全部読んでから返す */
  const startStalledOrigin = () =>
    kit.startTcpServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n'));
    });
  const tenants = ['name:alice', 'name:bob'];
  const ownerHosts = ['owner-a.test', 'owner-b.test', 'owner-c.test'];
  afterEach(async () => {
    for (const host of ownerHosts) for (const tenant of tenants) await closeHttpSession(host, tenant);
  });

  test('tenantId を渡した取得は、その利用者の印で通る。上限に達した利用者の次の取得は、試さずに ResourceBusyError（egress）。ほかの利用者は通る', async () => {
    const stalled = await startStalledOrigin();
    const { resolve } = fakeResolver({ 'owner-a.test': ['127.0.0.1'], 'owner-b.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [stalled.port], resolve, isPrivateIp: () => false, maxConnections: 4, ownerSharePercent: 25 }); // 1 人 1 本

    const held = await fetchWithSafeRedirects(`http://owner-a.test:${stalled.port}/`, 5000, 0, undefined, undefined, undefined, 'name:alice');
    expect(held.response.status).toBe(200);
    expect(egressOwnerAtLimit('name:alice')).toBe(true);

    const refused = await fetchWithSafeRedirects(`http://owner-b.test:${stalled.port}/`, 5000, 0, undefined, undefined, undefined, 'name:alice').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResourceBusyError);
    expect((refused as ResourceBusyError).resource).toBe('egress');
    expect((refused as ResourceBusyError).reason).toBe('connection_limit');
    expect(stalled.connections).toHaveLength(1); // 試していない
    expect(getSecurityMetrics().sora_egress_denied_tenant_limit_total ?? 0).toBe(0); // ゲートウェイにも届いていない
    expect(getSecurityMetrics().sora_egress_busy_connection_limit_total).toBe(1);

    const bob = await fetchWithSafeRedirects(`http://owner-b.test:${stalled.port}/`, 5000, 0, undefined, undefined, undefined, 'name:bob');
    expect(bob.response.status).toBe(200);
  });

  test('ゲートウェイが混んでいて断った平文 http の応答（全体の limit・利用者ごとの tenant_limit）は、ページとして返さず ResourceBusyError（その結果を共有のキャッシュに入れない）', async () => {
    const stalled = await startStalledOrigin();
    const { resolve } = fakeResolver({ 'owner-a.test': ['127.0.0.1'], 'owner-b.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [stalled.port], resolve, isPrivateIp: () => false, maxConnections: 1 }); // 全体で 1 本

    expect((await fetchWithSafeRedirects(`http://owner-a.test:${stalled.port}/`, 5000, 0, undefined, undefined, undefined, 'name:bob')).response.status).toBe(200);
    const refused = await fetchWithSafeRedirects(`http://owner-b.test:${stalled.port}/`, 5000, 0, undefined, undefined, undefined, 'name:alice').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResourceBusyError);
    expect((refused as ResourceBusyError).resource).toBe('egress');
  });

  test('strict で tenantId の無い取得（Sora 自身の上流への取得）は、いま呼んでいる利用者の印で通る', async () => {
    const stalled = await startStalledOrigin();
    const { resolve } = fakeResolver({ 'owner-c.test': ['127.0.0.1'] });
    await withEnv({ SORA_ISOLATION: 'strict' }, async () => {
      await getEgressGateway({ allowedPorts: [stalled.port], resolve, isPrivateIp: () => false, maxConnections: 4, ownerSharePercent: 25 });
      const held = await runAsCaller('name:alice', () => fetchWithSafeRedirects(`http://owner-c.test:${stalled.port}/`, 5000, 0));
      expect(held.response.status).toBe(200);
      expect(egressOwnerAtLimit('name:alice')).toBe(true);
      expect(egressOwnerAtLimit('legacy')).toBe(false);
    });
  });

  test('NativeFetchSession は、作るときに渡した印つきの URL で通る', async () => {
    const stalled = await startStalledOrigin();
    const { resolve } = fakeResolver({ 'native.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [stalled.port], resolve, isPrivateIp: () => false, maxConnections: 4, ownerSharePercent: 25 });

    const response = await new NativeFetchSession(await egressProxyUrlFor('name:alice')).fetch(`http://native.test:${stalled.port}/n`);
    expect(response.status).toBe(200);
    expect(egressOwnerAtLimit('name:alice')).toBe(true);
    await response.body?.cancel();
  });
});

describe('NativeFetchSession（wreq が使えないときの代わり）と出口のゲートウェイ', () => {
  test('on のときは、これも、ゲートウェイを通る', async () => {
    const origin = await kit.startOrigin('native-ok');
    const { resolve, calls } = fakeResolver({ 'native.test': ['127.0.0.1'] });
    await getEgressGateway({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });

    const response = await new NativeFetchSession().fetch(`http://native.test:${origin.port}/n`);

    expect(await response.text()).toBe('native-ok');
    expect(calls).toContain('native.test');
  });
});
