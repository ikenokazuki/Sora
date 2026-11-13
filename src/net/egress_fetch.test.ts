import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { getEgressGateway, isEgressGatewayStarted, stopEgressGateway } from './egress.js';
import { installEgressFetch, uninstallEgressFetch } from './egress_fetch.js';
import { createEgressTestKit, fakeResolver } from './egress_test_kit.js';

// Bun の fetch（globalThis.fetch）が、SORA_EGRESS_GATEWAY=on のとき、出口のゲートウェイを通ること。
// 天気・防災・荷物追跡などの固定の提供元、webhook、提供元の応答が決める URL は、どれも、この fetch で取る。
// テストの事前設定（test_preload.ts）は、外へ出ないよう、プロキシの環境変数に、閉じたポートの架空のプロキシを入れている。
// ゲートウェイは、それを運用者の上流として読むので、このファイルの間だけ外す
const kit = createEgressTestKit();
const touchedKeys = ['SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_EGRESS_GATEWAY', 'SORA_EGRESS_ALLOW_HOSTS'];
const realFetch = globalThis.fetch;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  for (const key of touchedKeys) delete process.env[key];
  process.env.SORA_EGRESS_GATEWAY = 'on';
  resetSecurityMetrics();
});

afterEach(async () => {
  uninstallEgressFetch();
  globalThis.fetch = realFetch;
  await stopEgressGateway();
  await kit.cleanup();
  for (const key of touchedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('installEgressFetch: on のとき、fetch は、出口のゲートウェイを通る', () => {
  test('名前は、ゲートウェイが解決し、宛先は、origin-form の要求を受ける（OS では解決できない名前でも届く）', async () => {
    const origin = await kit.startOrigin('web-ok');
    const { resolve, calls } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    installEgressFetch({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });

    const response = await fetch(`http://web.test:${origin.port}/p?x=1`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('web-ok');
    expect(origin.requests[0].head.split('\r\n')[0]).toBe('GET /p?x=1 HTTP/1.1');
    expect(origin.requests[0].head).toMatch(new RegExp(`^host: web\\.test:${origin.port}$`, 'im'));
    expect(calls).toContain('web.test');
  });

  test('内部の宛先（ループバック）は、ゲートウェイが断り、宛先には何も届かない。403 と理由が返る', async () => {
    const origin = await kit.startOrigin('secret');
    installEgressFetch({ allowedPorts: [origin.port] }); // 判定は既定（内部の IP は断る）

    const byIp = await fetch(`http://127.0.0.1:${origin.port}/`);
    const byName = await fetch(`http://localhost:${origin.port}/`);

    expect(byIp.status).toBe(403);
    expect(byIp.headers.get('x-sora-egress-deny')).toBe('private_ip');
    expect(byName.status).toBe(403);
    expect(byName.headers.get('x-sora-egress-deny')).toBe('blocked_host');
    expect(origin.requests).toHaveLength(0);
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('https（CONNECT）でも、内部の宛先には、トンネルを張れず、宛先には何も届かない', async () => {
    const origin = await kit.startOrigin('secret');
    installEgressFetch({ allowedPorts: [origin.port] });

    await expect(fetch(`https://127.0.0.1:${origin.port}/`)).rejects.toThrow();

    expect(origin.received).toHaveLength(0);
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('許していないポートは、断る（既定は 80・443 だけ）', async () => {
    const origin = await kit.startOrigin('secret');
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    installEgressFetch({ resolve, isPrivateIp: () => false }); // ポートの指定なし = 既定

    const response = await fetch(`http://web.test:${origin.port}/`);

    expect(response.status).toBe(403);
    expect(response.headers.get('x-sora-egress-deny')).toBe('port');
    expect(origin.requests).toHaveLength(0);
  });

  test('環境変数 NO_PROXY が、その宛先を挙げていても、ゲートウェイを迂回しない（Bun は、NO_PROXY の宛先には、指定したプロキシも使わずに、直接つなぐ）', async () => {
    const origin = await kit.startOrigin('secret');
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.no_proxy = '127.0.0.1,localhost';
    installEgressFetch({ allowedPorts: [origin.port] });

    const byIp = await fetch(`http://127.0.0.1:${origin.port}/`);
    const byName = await fetch(`http://localhost:${origin.port}/`);

    expect(byIp.status).toBe(403);
    expect(byName.status).toBe(403);
    expect(origin.requests).toHaveLength(0);
  });

  test('運用者の NO_PROXY は、これまでどおり、ゲートウェイが受け持つ: NO_PROXY の宛先は、上流のプロキシを使わず、直接つなぐ（検査は受ける）', async () => {
    const origin = await kit.startOrigin('direct-ok');
    const upstream = await kit.startFakeHttpProxy();
    process.env.SORA_PROXY_URL = `http://127.0.0.1:${upstream.port}`;
    process.env.NO_PROXY = 'direct.test';
    const { resolve } = fakeResolver({ 'direct.test': ['127.0.0.1'] });
    // ゲートウェイは、最初の fetch で、環境変数から作る（その後、プロセスの環境から NO_PROXY は外れる）。外れたあとも、迂回の指定は残ること
    installEgressFetch({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });

    const first = await fetch(`http://direct.test:${origin.port}/d1`);
    const viaUpstream = await fetch(`http://other.test:${origin.port}/o`);
    const second = await fetch(`http://direct.test:${origin.port}/d2`);

    expect(await first.text()).toBe('direct-ok');
    expect(await second.text()).toBe('direct-ok');
    expect(origin.requests.map((request) => request.head.split('\r\n')[0])).toEqual(['GET /d1 HTTP/1.1', 'GET /d2 HTTP/1.1']);
    expect(await viaUpstream.text()).toBe('up');
    expect(upstream.heads).toHaveLength(1);
    expect(upstream.heads[0].split('\r\n')[0]).toBe(`GET http://other.test:${origin.port}/o HTTP/1.1`);
  });

  test('SORA_EGRESS_ALLOW_HOSTS に挙げた宛先は、内部の IP でも届く。挙げていない宛先は、これまでどおり断られる（環境変数 → ゲートウェイの設定 → fetch）', async () => {
    const origin = await kit.startOrigin('svc-ok');
    process.env.SORA_EGRESS_ALLOW_HOSTS = `svc.test:${origin.port}`;
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
    installEgressFetch({ resolve }); // 判定と、許すポートは、既定のまま（内部の IP・80 と 443 以外のポートは断る）

    const listed = await fetch(`http://svc.test:${origin.port}/a`);
    const unlisted = await fetch(`http://other.test:${origin.port}/b`);

    expect(await listed.text()).toBe('svc-ok');
    expect(unlisted.status).toBe(403);
    expect(origin.requests).toHaveLength(1);
  });

  test('POST の本文（文字列・FormData）は、そのまま届く', async () => {
    const origin = await kit.startOrigin('posted');
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    installEgressFetch({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });
    const form = new FormData();
    form.append('k', 'v');

    await fetch(`http://web.test:${origin.port}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'あ' }) });
    await fetch(`http://web.test:${origin.port}/form`, { method: 'POST', body: form });

    expect(origin.requests[0].body.toString()).toBe(JSON.stringify({ a: 'あ' }));
    expect(origin.requests[1].body.toString()).toContain('name="k"');
  });

  test('長さが先にわからない本文（ストリーム）は、ゲートウェイが 400 で断る。いまの呼び出し元には、無い（Transfer-Encoding の要求本文は、通さない）', async () => {
    const origin = await kit.startOrigin('x');
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    installEgressFetch({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
      },
    });

    const response = await fetch(`http://web.test:${origin.port}/`, { method: 'POST', body, duplex: 'half' } as RequestInit);

    expect(response.status).toBe(400);
    expect(response.headers.get('x-sora-egress-deny')).toBe('bad_request');
    expect(origin.requests).toHaveLength(0);
  });

  test('並列の要求（30 件）は、すべて届く（1 接続 1 要求の転送でも、詰まらない）', async () => {
    const origin = await kit.startOrigin('par-ok');
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    installEgressFetch({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });

    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`http://web.test:${origin.port}/par${i}`).then(async (r) => [r.status, await r.text()])));

    expect(responses.every(([status, body]) => status === 200 && body === 'par-ok')).toBe(true);
    expect(origin.requests).toHaveLength(30);
  });

  test('リダイレクト先も、ゲートウェイを通る（公開の宛先から、内部の宛先への 302 は、断られる）', async () => {
    let redirectPort = 0;
    const served: string[] = [];
    const redirector = await kit.startTcpServer((socket) => {
      socket.once('data', () => {
        served.push('hit');
        socket.end(`HTTP/1.1 302 Found\r\nLocation: http://internal.test:${redirectPort}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      });
    });
    redirectPort = redirector.port;
    const { resolve } = fakeResolver({ 'redirect.test': ['127.0.0.1'], 'internal.test': ['127.0.0.2'] });
    installEgressFetch({ allowedPorts: [redirectPort], resolve, isPrivateIp: (ip) => ip === '127.0.0.2' });

    const response = await fetch(`http://redirect.test:${redirectPort}/start`);

    expect(served).toEqual(['hit']);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-sora-egress-deny')).toBe('private_ip');
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('呼び出しごとに、別のプロキシを指定するとエラー（黙って無視すると、ゲートウェイを迂回したと思わせる）。ゲートウェイ自身の URL なら、よい', async () => {
    const origin = await kit.startOrigin('x');
    const { resolve } = fakeResolver({ 'web.test': ['127.0.0.1'] });
    const gateway = await getEgressGateway({ allowedPorts: [origin.port], resolve, isPrivateIp: () => false });
    installEgressFetch();
    const url = `http://web.test:${origin.port}/`;

    await expect(fetch(url, { proxy: 'http://other-proxy.example:8080' })).rejects.toThrow('SORA_EGRESS_GATEWAY');
    await expect(fetch(url, { proxy: { url: 'http://other-proxy.example:8080' } } as RequestInit)).rejects.toThrow('SORA_EGRESS_GATEWAY');
    expect((await fetch(url, { proxy: gateway.url })).status).toBe(200);
    expect((await fetch(url, { proxy: { url: gateway.url } } as RequestInit)).status).toBe(200);
    // proxy: undefined と明示しても、指定なしと同じ（ゲートウェイを通る）。迂回の抜け道にならない
    expect((await fetch(`http://localhost:${origin.port}/`, { proxy: undefined })).status).toBe(403);
  });

  test('ゲートウェイを始められないとき（設定の誤り）は、直接つなぐ道に落ちず、失敗する', async () => {
    const origin = await kit.startOrigin('must-not-be-reached');
    process.env.SORA_PROXY_LIST = 'http://proxy-a.example:8080'; // ゲートウェイの上流は 1 つ。一覧とは併用できない
    installEgressFetch();

    await expect(fetch(`http://127.0.0.1:${origin.port}/`)).rejects.toThrow('SORA_PROXY_LIST');

    expect(origin.requests).toHaveLength(0);
  });

  test('fetch.preconnect（ゲートウェイを通らない、先行の接続）は、何もしない', async () => {
    const origin = await kit.startOrigin('x');
    installEgressFetch({ allowedPorts: [origin.port] });

    fetch.preconnect(`http://127.0.0.1:${origin.port}/`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(origin.received).toHaveLength(0);
  });
});

describe('installEgressFetch: off のとき、何も変わらない', () => {
  const stub = () => {
    const calls: unknown[][] = [];
    const fn = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response('stubbed'));
    }) as unknown as typeof fetch;
    return { calls, fn };
  };

  test('引数は、数も中身も、そのまま、元の fetch に渡る。ゲートウェイは、始めない', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'off';
    const { calls, fn } = stub();
    globalThis.fetch = fn;
    installEgressFetch();
    const init = { method: 'POST', body: 'x' };

    expect(await (await fetch('http://a.test/', init)).text()).toBe('stubbed');
    await fetch('http://b.test/');

    expect(calls[0][1]).toBe(init);
    expect(calls[0]).toHaveLength(2);
    expect(calls[1]).toEqual(['http://b.test/']);
    expect(isEgressGatewayStarted()).toBe(false);
  });

  test('環境変数が未設定でも、同じ（既定は、使わない）。NO_PROXY も、そのまま', async () => {
    delete process.env.SORA_EGRESS_GATEWAY;
    process.env.NO_PROXY = 'localhost';
    const { calls, fn } = stub();
    globalThis.fetch = fn;
    installEgressFetch();

    await fetch('http://a.test/');

    expect(calls).toHaveLength(1);
    expect(process.env.NO_PROXY).toBe('localhost');
    expect(isEgressGatewayStarted()).toBe(false);
  });

  test('設定の書き方の誤りは、使わないことにせず、失敗する（打ち間違いで、ゲートウェイが黙って外れない）', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'onn';
    const { calls, fn } = stub();
    globalThis.fetch = fn;
    installEgressFetch();

    await expect(fetch('http://a.test/')).rejects.toThrow('SORA_EGRESS_GATEWAY');
    expect(calls).toHaveLength(0);
  });
});

describe('installEgressFetch / uninstallEgressFetch', () => {
  test('重ねて呼んでも、二重に包まない。uninstall で、元の fetch に戻る', () => {
    const original = globalThis.fetch;
    installEgressFetch();
    const wrapped = globalThis.fetch;
    installEgressFetch();

    expect(wrapped).not.toBe(original);
    expect(globalThis.fetch).toBe(wrapped);
    uninstallEgressFetch();
    expect(globalThis.fetch).toBe(original);
  });

  test('ほかのコードが fetch を差し替えていたら、uninstall は、それを元に戻さない', () => {
    installEgressFetch();
    const other = (() => Promise.resolve(new Response('other'))) as unknown as typeof fetch;
    globalThis.fetch = other;

    uninstallEgressFetch();

    expect(globalThis.fetch).toBe(other);
  });
});
