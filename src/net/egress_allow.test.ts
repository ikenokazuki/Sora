import { afterEach, describe, expect, test } from 'bun:test';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { closedPort, connectHead, createEgressTestKit, fakeResolver, readBytes } from './egress_test_kit.js';

// 運用者が、出口のゲートウェイの許す宛先（SORA_EGRESS_ALLOW_HOSTS）に挙げた `host:port` は、内部の IP・許していないポートにも通す。
// 挙げていない宛先は、これまでどおり断る。挙げた宛先でも、名前の解決は 1 回・接続は検査した IP に固定、は同じに受け、
// クラウドのメタデータなど、挙げても通さない宛先は、通さない。
// 判定は、既定（本物の IP の方針）のまま。127.0.0.1 の自前のサーバーが、内部の宛先の代わり。
const kit = createEgressTestKit();
const { startGateway, startOrigin, startEchoServer, startFakeHttpProxy, rawRequest } = kit;
afterEach(async () => {
  await kit.cleanup();
  resetSecurityMetrics();
});

const get = (port: number, url: string) => rawRequest(port, `GET ${url} HTTP/1.1\r\nHost: x\r\n\r\n`);

describe('許す宛先に挙げた host:port', () => {
  test('名前が内部の IP に解決しても、許していないポートでも、通る（http の転送）。拒否は数えない', async () => {
    const origin = await startOrigin('svc-ok');
    const { resolve, calls } = fakeResolver({ 'svc.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'svc.test', port: origin.port }] });

    const reply = await get(port, `http://svc.test:${origin.port}/p`);

    expect(reply.status).toBe(200);
    expect(origin.requests).toHaveLength(1);
    expect(origin.requests[0].head.split('\r\n')[0]).toBe('GET /p HTTP/1.1');
    expect(calls).toEqual(['svc.test']); // 名前は、ゲートウェイが 1 回だけ解決する
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total ?? 0).toBe(0);
    expect(getSecurityMetrics().sora_egress_denied_port_total ?? 0).toBe(0);
  });

  test('トンネル（CONNECT）も通る', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'svc.test', port: echo.port }] });

    const reply = await rawRequest(port, connectHead(`svc.test:${echo.port}`));

    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
  });

  test('IP リテラルでも、名前（localhost）でも、挙げたものは通る', async () => {
    const origin = await startOrigin('lit-ok');
    const { resolve } = fakeResolver({ localhost: ['127.0.0.1'] });
    const { port } = await startGateway({
      resolve,
      allowedPorts: [443],
      allowDestinations: [
        { host: '127.0.0.1', port: origin.port },
        { host: 'localhost', port: origin.port },
      ],
    });

    expect((await get(port, `http://127.0.0.1:${origin.port}/`)).status).toBe(200);
    expect((await get(port, `http://localhost:${origin.port}/`)).status).toBe(200);
    expect(origin.requests).toHaveLength(2);
  });

  test('挙げていない名前は、同じ IP に解決しても、断る（403・private_ip）', async () => {
    const origin = await startOrigin('secret');
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], allowDestinations: [{ host: 'svc.test', port: origin.port }] });

    const reply = await get(port, `http://other.test:${origin.port}/`);

    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(origin.requests).toHaveLength(0);
  });

  test('同じ名前でも、挙げていないポートは、断る（許していないポート）', async () => {
    const listed = await startOrigin('listed');
    const unlisted = await startOrigin('unlisted');
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'svc.test', port: listed.port }] });

    const reply = await get(port, `http://svc.test:${unlisted.port}/`);

    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('port');
    expect(unlisted.requests).toHaveLength(0);
  });

  test('挙げた名前の書き方（大文字・末尾のドット）が違っても、同じ宛先として扱う', async () => {
    const origin = await startOrigin('svc-ok');
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'SVC.Test.', port: origin.port }] });

    expect((await get(port, `http://svc.test:${origin.port}/`)).status).toBe(200);
  });

  test('挙げた名前が解決できなければ、閉じる（502・dns）', async () => {
    const { resolve } = fakeResolver({});
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'svc.test', port: 8080 }] });

    const reply = await get(port, 'http://svc.test:8080/');

    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBe('dns');
  });
});

describe('照合の整え方', () => {
  test('IPv6 は、書き方（0 の省略・大文字）が違っても、同じ宛先として一致する（一致すれば通り、接続の失敗は 502。一致しなければ 403）', async () => {
    const closed = await closedPort(); // 誰も待ち受けていない（::1 の IPv6 のループバックは、接続を断られる）
    const { resolve } = fakeResolver({});
    const listed = await startGateway({ resolve, allowDestinations: [{ host: '0:0:0:0:0:0:0:1', port: closed }] });
    const unlisted = await startGateway({ resolve });

    expect((await get(listed.port, `http://[::1]:${closed}/`)).status).toBe(502);
    expect((await get(unlisted.port, `http://[::1]:${closed}/`)).status).toBe(403);
  });

  test('挙げていない書き方の IPv4（16 進など）は、一致しない（断る）', async () => {
    const origin = await startOrigin('secret');
    const { port } = await startGateway({ allowedPorts: [origin.port], allowDestinations: [{ host: '127.0.0.1', port: origin.port }] });

    const reply = await get(port, `http://0x7f.1:${origin.port}/`);

    expect(reply.status).toBe(403);
    expect(origin.requests).toHaveLength(0);
  });
});

describe('挙げても通さない宛先（クラウドのメタデータ・リンクローカルなど）', () => {
  test('メタデータの名前は、挙げても、解決の前に断る', async () => {
    const { resolve, calls } = fakeResolver({ 'metadata.google.internal': ['169.254.169.254'] });
    const { port } = await startGateway({ resolve, allowDestinations: [{ host: 'metadata.google.internal', port: 80 }] });

    const reply = await get(port, 'http://metadata.google.internal/computeMetadata/v1/');

    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('blocked_host');
    expect(calls).toEqual([]);
  });

  test('メタデータの IP リテラルは、挙げても、断る（メタデータの名前として）。ほかのリンクローカルの IP リテラルも、断る', async () => {
    const { resolve } = fakeResolver({});
    const { port } = await startGateway({
      resolve,
      allowDestinations: [
        { host: '169.254.169.254', port: 80 },
        { host: '169.254.0.1', port: 80 },
        { host: 'fe80::1', port: 80 },
      ],
    });

    const metadata = await get(port, 'http://169.254.169.254/latest/meta-data/');
    const linkLocal = await get(port, 'http://169.254.0.1/');
    const linkLocalV6 = await get(port, 'http://[fe80::1]/');

    expect(metadata.status).toBe(403);
    expect(metadata.headers['x-sora-egress-deny']).toBe('blocked_host');
    expect(linkLocal.status).toBe(403);
    expect(linkLocal.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(linkLocalV6.status).toBe(403);
    expect(linkLocalV6.headers['x-sora-egress-deny']).toBe('private_ip');
  });

  test('挙げた名前が、リンクローカル（メタデータ）の IP に解決されても、断る（内部の DNS を書き換えられても、メタデータには届かない）', async () => {
    const { resolve } = fakeResolver({ 'svc.test': ['169.254.169.254'] });
    const { port } = await startGateway({ resolve, allowDestinations: [{ host: 'svc.test', port: 80 }] });

    const reply = await get(port, 'http://svc.test/');

    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
  });

  test('通す範囲（CGNAT・ULA）の中にある、Alibaba Cloud・AWS の IPv6 のメタデータの IP も、挙げても断る（リテラル・名前の解決の答え）', async () => {
    const { resolve } = fakeResolver({ 'svc.test': ['100.100.100.200'], 'svc6.test': ['fd00:ec2::254'] });
    const { port } = await startGateway({
      resolve,
      allowDestinations: [
        { host: '100.100.100.200', port: 80 },
        { host: 'svc.test', port: 80 },
        { host: 'svc6.test', port: 80 },
      ],
    });

    const literal = await get(port, 'http://100.100.100.200/latest/meta-data/');
    const viaName = await get(port, 'http://svc.test/');
    const viaName6 = await get(port, 'http://svc6.test/');

    expect([literal.status, viaName.status, viaName6.status]).toEqual([403, 403, 403]);
    expect([literal.headers['x-sora-egress-deny'], viaName.headers['x-sora-egress-deny'], viaName6.headers['x-sora-egress-deny']]).toEqual(['blocked_host', 'private_ip', 'private_ip']);
  });

  test('答えに、通してよい内部の IP と、通さない IP が混じっていたら、全体を断る', async () => {
    const origin = await startOrigin('secret');
    const { resolve } = fakeResolver({ 'svc.test': ['127.0.0.1', '169.254.169.254'] });
    const { port } = await startGateway({ resolve, allowedPorts: [443], allowDestinations: [{ host: 'svc.test', port: origin.port }] });

    const reply = await get(port, `http://svc.test:${origin.port}/`);

    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(origin.requests).toHaveLength(0);
  });
});

describe('運用者の上流のプロキシがあるとき', () => {
  test('NO_PROXY の宛先（上流を通さず直接つなぐ）に、挙げた内部の名前があれば、ゲートウェイが直接つなぐ。内部の IP の検査は、挙げた宛先でも同じに受ける', async () => {
    const origin = await startOrigin('direct-ok');
    const upstream = await startFakeHttpProxy();
    const { resolve } = fakeResolver({ 'svc.internal': ['127.0.0.1'], 'meta.internal': ['169.254.169.254'] });
    const { port } = await startGateway({
      resolve,
      upstream: { host: '127.0.0.1', port: upstream.port },
      bypassUpstream: (host) => host.endsWith('.internal'),
      allowDestinations: [
        { host: 'svc.internal', port: origin.port },
        { host: 'meta.internal', port: 80 },
      ],
    });

    const direct = await get(port, `http://svc.internal:${origin.port}/d`);
    const denied = await get(port, 'http://meta.internal/');

    expect(direct.status).toBe(200);
    expect(origin.requests).toHaveLength(1);
    expect(upstream.heads).toHaveLength(0); // 上流には、回らない
    expect(denied.status).toBe(403);
    expect(denied.headers['x-sora-egress-deny']).toBe('private_ip');
  });

  test('上流があっても、挙げたものが、通さない範囲（リンクローカル・メタデータの名前）なら、上流に回さず断る（上流の経路では、解決した IP を見られないので、事前の検査が唯一の検査）', async () => {
    const upstream = await startFakeHttpProxy();
    const { port } = await startGateway({
      upstream: { host: '127.0.0.1', port: upstream.port },
      allowDestinations: [
        { host: '169.254.0.1', port: 80 },
        { host: 'fe80::1', port: 80 },
        { host: 'metadata.google.internal', port: 80 },
      ],
    });

    const v4 = await get(port, 'http://169.254.0.1/');
    const v6 = await get(port, 'http://[fe80::1]/');
    const name = await get(port, 'http://metadata.google.internal/');

    expect([v4.status, v6.status, name.status]).toEqual([403, 403, 403]);
    expect([v4.headers['x-sora-egress-deny'], v6.headers['x-sora-egress-deny'], name.headers['x-sora-egress-deny']]).toEqual(['private_ip', 'private_ip', 'blocked_host']);
    expect(upstream.heads).toHaveLength(0);
  });

  test('挙げた宛先は、名前・ポートの検査を通って、上流に回る。挙げていない内部の名前は、これまでどおり断る', async () => {
    const upstream = await startFakeHttpProxy();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port }, allowDestinations: [{ host: 'svc.internal', port: 8080 }] });

    const listed = await get(port, 'http://svc.internal:8080/x');
    const unlisted = await get(port, 'http://other.internal/x');

    expect(listed.status).toBe(200);
    expect(upstream.heads).toHaveLength(1);
    expect(upstream.heads[0].split('\r\n')[0]).toBe('GET http://svc.internal:8080/x HTTP/1.1');
    expect(unlisted.status).toBe(403);
    expect(unlisted.headers['x-sora-egress-deny']).toBe('blocked_host');
  });
});
