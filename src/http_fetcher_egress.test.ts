import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeHttpSession, fetchWithSafeRedirects, NativeFetchSession } from './http_fetcher.js';
import { getEgressGateway, stopEgressGateway } from './net/egress.js';
import { createEgressTestKit, fakeResolver } from './net/egress_test_kit.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

// 静的取得（wreq-js）が、SORA_EGRESS_GATEWAY=on のとき、出口のゲートウェイを通ること。
// テストの事前設定（test_preload.ts）は、外へ出ないよう、プロキシの環境変数に、閉じたポートの架空のプロキシを入れている。
// ゲートウェイは、それを運用者の上流として読むので、このファイルの間だけ外す
const kit = createEgressTestKit();
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'ALLOW_LOCAL_FETCH', 'SORA_EGRESS_GATEWAY'];
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
    process.env.ALLOW_LOCAL_FETCH = 'true';
    await fetchWithSafeRedirects(`http://127.0.0.1:${origin.port}/a?x=1`, 5000, 0, headers);
    delete process.env.ALLOW_LOCAL_FETCH;
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
