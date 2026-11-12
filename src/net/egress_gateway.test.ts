import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import {
  closedPort,
  closesWithin,
  connectHead,
  createEgressTestKit,
  fakeResolver,
  type ProxyReply,
  readBytes,
  treatLoopbackAsPublic,
  waitUntil,
} from './egress_test_kit.js';

// ---- テスト用の道具（egress_test_kit.ts。ファイルごとに 1 つ作り、afterEach で後始末する） ----

const kit = createEgressTestKit();
const { startTcpServer, startEchoServer, startGateway, rawRequest, startOrigin } = kit;
afterEach(async () => {
  await kit.cleanup();
  resetSecurityMetrics();
});

// ---- CONNECT ----

describe('CONNECT: 検査した IP に固定して、中継する', () => {
  test('解決した IP に接続し（名前では接続しない）、双方向に中継する', async () => {
    const echo = await startEchoServer();
    // echo.test は OS では解決できない名前。名前で接続しようとすると失敗する
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
  });

  test('名前の解決は、1 回だけ（rebinding の 2 回目の答えは使わない）', async () => {
    const echo = await startEchoServer();
    const answers = [['127.0.0.1'], ['10.0.0.1']];
    const calls: string[] = [];
    const resolve = async (host: string) => {
      calls.push(host);
      return answers[Math.min(calls.length - 1, answers.length - 1)];
    };
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], isPrivateIp: (ip) => ip.startsWith('10.') });

    const reply = await rawRequest(port, connectHead(`rebind.test:${echo.port}`));
    expect(reply.status).toBe(200);
    reply.socket.write('ok');
    expect((await readBytes(reply.socket, 2, reply.rest)).toString()).toBe('ok');
    expect(calls).toEqual(['rebind.test']);
  });

  test('大きなデータも、欠けも並び替えもなく往復する（背圧を扱えている）', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });
    const payload = randomBytes(3 * 1024 * 1024);

    const reply = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    reply.socket.write(payload);
    const echoed = await readBytes(reply.socket, payload.length, reply.rest, 15_000);
    expect(echoed.length).toBe(payload.length);
    expect(echoed.equals(payload)).toBe(true);
  });
});

describe('CONNECT: 中継の作法', () => {
  test('クライアントが送信を終えても（半閉じ）、宛先からの応答を受け取れる', async () => {
    const server = await startTcpServer(
      (socket) => {
        socket.on('end', () => socket.end('bye')); // 要求を読み終えてから応答する
        socket.resume();
      },
      { allowHalfOpen: true },
    );
    const { resolve } = fakeResolver({ 'half.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [server.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`half.test:${server.port}`));
    reply.socket.end('request');
    expect((await readBytes(reply.socket, 3, reply.rest)).toString()).toBe('bye');
  });

  test('頭部と同じ送信に混じって届いた、続きのバイトも、宛先へ渡す', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `${connectHead(`echo.test:${echo.port}`)}early`);
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 5, reply.rest)).toString()).toBe('early');
  });

  test('宛先への接続を待っている間に、クライアントが送ったバイトも、失わずに宛先へ渡す', async () => {
    const echo = await startEchoServer();
    // 名前の解決に 200ms かかる。その間（50ms 後）に、クライアントが続きのバイトを送る
    const resolve = async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      return ['127.0.0.1'];
    };
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`slow.test:${echo.port}`), 'early-bytes');
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 11, reply.rest)).toString()).toBe('early-bytes');
  });

  test('宛先が接続を閉じたら、クライアント側も閉じる（接続を残さない）', async () => {
    const server = await startTcpServer((socket) => socket.destroy());
    const { resolve } = fakeResolver({ 'gone.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [server.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`gone.test:${server.port}`));
    expect(await closesWithin(reply.socket, 2000)).toBe(true);
  });

  test('名前を解決している間にクライアントが切れたら、宛先への接続を残さない', async () => {
    const echo = await startEchoServer();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve = async () => {
      await released;
      return ['127.0.0.1'];
    };
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const client = net.connect({ host: '127.0.0.1', port });
    kit.addCleanup(() => void client.destroy());
    await new Promise<void>((resolveConnect) => client.once('connect', () => resolveConnect()));
    client.write(connectHead(`slow.test:${echo.port}`));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50)); // ゲートウェイが、名前の解決を待っている
    client.destroy();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    release();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    // 宛先に接続していないか、接続していても閉じている
    expect(echo.connections.every((connection) => connection.destroyed)).toBe(true);
  });

  test('クライアントが接続を切ったら、宛先への接続も閉じる（接続を残さない）', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    expect(echo.connections).toHaveLength(1);
    reply.socket.destroy();
    expect(await waitUntil(() => echo.connections[0].destroyed)).toBe(true);
  });
});

describe('CONNECT: 拒否する宛先（閉じる側に倒す）', () => {
  test('解決した IP の 1 つでも非公開なら、全体を拒否する（403・private_ip）。公開の IP にも接続しない', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'mixed.test': ['127.0.0.1', '10.0.0.5'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], isPrivateIp: (ip) => ip.startsWith('10.') });

    const reply = await rawRequest(port, connectHead(`mixed.test:${echo.port}`));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(echo.connections).toHaveLength(0);
    expect(getSecurityMetrics().sora_egress_denied_private_ip_total).toBe(1);
  });

  test('既定の判定では、ループバックに解決される名前（rebinding）を拒否する', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'evil.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port] });

    const reply = await rawRequest(port, connectHead(`evil.test:${echo.port}`));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(echo.connections).toHaveLength(0);
  });

  test.each([
    ['解決に失敗する名前', undefined],
    ['答えが空の名前', [] as string[]],
  ])('DNS の失敗は閉じる（502・dns）: %s', async (_label, answer) => {
    const resolve = async () => {
      if (!answer) throw new Error('ENOTFOUND');
      return answer;
    };
    const { port } = await startGateway({ resolve });

    const reply = await rawRequest(port, connectHead('nx.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBe('dns');
    expect(getSecurityMetrics().sora_egress_denied_dns_total).toBe(1);
  });

  test('解決が終わらない名前は、時間切れで閉じる（502・dns）', async () => {
    const resolve = () => new Promise<string[]>(() => {});
    const { port } = await startGateway({ resolve, resolveTimeoutMs: 50 });

    const reply = await rawRequest(port, connectHead('slow.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBe('dns');
  });

  test.each([22, 25, 3306, 6379, 8000, 9222])('許していないポート %d は、名前を解決せずに拒否する（403・port）', async (target) => {
    const { resolve, calls } = fakeResolver({ 'public.test': ['93.184.216.34'] });
    const { port } = await startGateway({ resolve });

    const reply = await rawRequest(port, connectHead(`public.test:${target}`));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('port');
    expect(calls).toEqual([]);
    expect(getSecurityMetrics().sora_egress_denied_port_total).toBe(1);
  });

  test.each([
    ['127.0.0.1:443', 'private_ip'],
    ['0x7f.1:443', 'private_ip'],
    ['2130706433:443', 'private_ip'],
    ['0177.0.0.1:443', 'private_ip'],
    ['10.0.0.1:443', 'private_ip'],
    ['169.254.169.254:80', 'private_ip'],
    ['[::1]:443', 'private_ip'],
    ['[::ffff:7f00:1]:443', 'private_ip'],
    ['[fd00::1]:443', 'private_ip'],
    ['localhost:443', 'blocked_host'],
    ['LOCALHOST.:443', 'blocked_host'],
    ['metadata.google.internal:80', 'blocked_host'],
    ['db.internal:443', 'blocked_host'],
    ['printer.local:443', 'blocked_host'],
  ])('内部の宛先 %s は、名前を解決せずに拒否する（403・%s）', async (target, reason) => {
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve });

    const reply = await rawRequest(port, connectHead(target));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe(reason);
    expect(calls).toEqual([]);
  });

  test.each([
    ['ポートがない', 'CONNECT example.test HTTP/1.1\r\n\r\n'],
    ['ホストがない', 'CONNECT :443 HTTP/1.1\r\n\r\n'],
    ['ポートが 0', 'CONNECT example.test:0 HTTP/1.1\r\n\r\n'],
    ['ポートが大きすぎる', 'CONNECT example.test:65536 HTTP/1.1\r\n\r\n'],
    ['ポートが数でない', 'CONNECT example.test:abc HTTP/1.1\r\n\r\n'],
    ['要求行に空白が混じる', 'CONNECT exa mple.test:443 HTTP/1.1\r\n\r\n'],
    ['HTTP/1.x でない', 'CONNECT example.test:443 SPDY/3\r\n\r\n'],
    ['http でも CONNECT でもない', 'EHLO example.test\r\n\r\n'],
  ])('書式の誤り（%s）は 400 で拒否する', async (_label, head) => {
    const { resolve, calls } = fakeResolver({ 'example.test': ['93.184.216.34'] });
    const { port } = await startGateway({ resolve });

    const reply = await rawRequest(port, head);
    expect(reply.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('接続できない宛先は、502 で返し、トンネルを作らない（方針の拒否ではないので、拒否の数には入れない）', async () => {
    const dead = await closedPort();
    const { resolve } = fakeResolver({ 'down.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [dead], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, connectHead(`down.test:${dead}`));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBeUndefined();
    expect(Object.keys(getSecurityMetrics()).filter((name) => name.startsWith('sora_egress_denied'))).toEqual([]);
  });
});

describe('入口の頑丈さ', () => {
  test('終わらない頭部（16KB を超える）は、431 で閉じる', async () => {
    const { port } = await startGateway();
    const reply = await rawRequest(port, `CONNECT example.test:443 HTTP/1.1\r\nX-Junk: ${'a'.repeat(20 * 1024)}`);
    expect(reply.status).toBe(431);
  });

  test('拒否の応答を返したあと、クライアントが接続を閉じてこなくても、一定の時間で切る（接続を溜めさせない）', async () => {
    const { port } = await startGateway({ denyLingerMs: 100 });
    // 自分からは閉じないクライアント（こちらの送信終了を受けても、閉じ返さない）
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.on('error', () => {}); // 切られたあとに送ると、RST を受ける
    kit.addCleanup(() => void socket.destroy());
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('EHLO example.test\r\n\r\n'); // 400 になる要求
    socket.resume(); // 読み出さないと、end が発生しない
    await new Promise<void>((resolve) => socket.once('end', () => resolve())); // 応答と、こちらへの送信終了（FIN）を受けた
    await new Promise((resolve) => setTimeout(resolve, 300)); // 100ms を過ぎるのを待つ

    // ゲートウェイが切っていれば、いま送ると RST が返り、こちらの接続も閉じる（切っていなければ、閉じない）
    socket.write('x');
    expect(await closesWithin(socket, 2000)).toBe(true);
  });

  test('閉じてこないクライアントに、接続数の枠を取られ続けない（拒否したあとの接続は、数から外れる）', async () => {
    const { port } = await startGateway({ denyLingerMs: 100, maxConnections: 2 });
    const hostile: net.Socket[] = [];
    for (let i = 0; i < 2; i++) {
      const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      kit.addCleanup(() => void socket.destroy());
      hostile.push(socket);
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      socket.write('EHLO example.test\r\n\r\n');
    }
    await Promise.all(hostile.map((socket) => closesWithin(socket, 2000)));

    // 枠が空いている: 正常な（書式の誤りで 400 になるだけの）要求が、503 でなく処理される
    const reply = await rawRequest(port, 'EHLO example.test\r\n\r\n');
    expect(reply.status).toBe(400);
  });

  test('拒否のあと、クライアントがすぐ閉じれば、接続数の枠もすぐ空く（待たされない）', async () => {
    // 切る時間は長くしておく（それを待たずに、枠が空くことを見る）
    const { port } = await startGateway({ maxConnections: 1, denyLingerMs: 60_000 });
    const first = await rawRequest(port, 'EHLO example.test\r\n\r\n');
    expect(first.status).toBe(400);
    expect(await closesWithin(first.socket, 2000)).toBe(true); // クライアントが閉じた

    let status = 0;
    expect(
      await waitUntil(() => {
        void rawRequest(port, 'EHLO example.test\r\n\r\n').then((reply) => {
          status = reply.status;
        }, () => {});
        return status === 400;
      }, 3000),
    ).toBe(true); // 503（枠が空いていない）でなく、400（処理された）
  });

  test('頭部が来ない接続は、時間切れで閉じる（接続を溜めさせない）', async () => {
    const { port } = await startGateway({ headTimeoutMs: 50 });
    const socket = net.connect({ host: '127.0.0.1', port });
    kit.addCleanup(() => void socket.destroy());
    expect(await closesWithin(socket, 2000)).toBe(true);
  });
});

// ---- http:// の転送（絶対 URI の要求） ----

describe('http:// の転送: 検査した IP に、宛先の形（origin-form）で送る', () => {
  test('要求行を origin-form にし、Host を宛先に直し、プロキシ向けのヘッダーを外し、Connection: close にして転送する', async () => {
    const origin = await startOrigin('hello');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(
      port,
      `GET http://origin.test:${origin.port}/path?x=1 HTTP/1.1\r\nHost: wrong.example\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\nAccept: text/html\r\nX-Custom: a\r\n\r\n`,
    );

    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 5, reply.rest)).toString()).toBe('hello');
    expect(origin.requests).toHaveLength(1);
    const lines = origin.requests[0].head.split('\r\n');
    expect(lines[0]).toBe('GET /path?x=1 HTTP/1.1');
    expect(lines.slice(1).sort()).toEqual(['Accept: text/html', 'Connection: close', `Host: origin.test:${origin.port}`, 'X-Custom: a']);
  });

  test('応答のあと、接続は閉じる（1 つの接続で 1 つの要求。続きの要求を、別の宛先へ向けさせない）', async () => {
    const origin = await startOrigin('hello');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `GET http://origin.test:${origin.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
    await readBytes(reply.socket, 5, reply.rest);
    expect(await closesWithin(reply.socket, 2000)).toBe(true);
  });

  test('本文つきの要求（POST）は、本文も転送する。頭部と同じ送信に混じった分も、後から届く分も', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    // 頭部と本文の最初の 6 バイトを送り、50ms 後に残りを送る（宛先は、本文がそろってから応答する）
    const reply = await rawRequest(
      port,
      `POST http://origin.test:${origin.port}/submit HTTP/1.1\r\nContent-Length: 11\r\nContent-Type: text/plain\r\n\r\nhello `,
      'world',
    );
    expect(reply.status).toBe(200);
    expect(await waitUntil(() => origin.requests.length === 1)).toBe(true);
    expect(origin.requests[0].body.toString()).toBe('hello world');
    expect(origin.requests[0].head.split('\r\n')[0]).toBe('POST /submit HTTP/1.1');
  });

  test('パスのない URI（http://host:port）は、/ にして転送する。クエリだけでも、/ をつける', async () => {
    const origin = await startOrigin();
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    await rawRequest(port, `GET http://origin.test:${origin.port} HTTP/1.1\r\n\r\n`);
    await rawRequest(port, `GET http://origin.test:${origin.port}?q=1 HTTP/1.1\r\n\r\n`);
    expect(await waitUntil(() => origin.requests.length === 2)).toBe(true);
    expect(origin.requests.map((request) => request.head.split('\r\n')[0])).toEqual(['GET / HTTP/1.1', 'GET /?q=1 HTTP/1.1']);
  });

  test('解決は 1 回だけで、解決した IP に接続する（CONNECT と同じ）', async () => {
    const origin = await startOrigin();
    const { resolve, calls } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `GET http://origin.test:${origin.port}/ HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(200);
    expect(calls).toEqual(['origin.test']);
  });

  test('実際の HTTP クライアント（Bun の fetch の proxy）で、本文が欠けずに届く', async () => {
    const body = randomBytes(2 * 1024 * 1024);
    const origin = await startOrigin(body);
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const response = await fetch(`http://origin.test:${origin.port}/big?a=b`, { proxy: `http://127.0.0.1:${port}` } as RequestInit);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    expect(origin.requests[0].head.split('\r\n')[0]).toBe('GET /big?a=b HTTP/1.1');
  });
});

describe('http:// の転送: 拒否する要求', () => {
  test('ポートを書かない URI は 80 番として、方針を通る（解決まで進む）。許していないポートは、名前を解決せずに拒否する（403・port）', async () => {
    // 80 番に接続はしない（宛先は、接続できないアドレス。ホストの 80 番の状態に、結果が左右されないように）
    const { resolve, calls } = fakeResolver({ 'public.test': ['192.0.2.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [80], connectTimeoutMs: 100, ...treatLoopbackAsPublic });

    const open = await rawRequest(port, 'GET http://public.test/ HTTP/1.1\r\n\r\n');
    expect(open.status).toBe(502); // 方針は通り、接続に失敗した
    expect(open.headers['x-sora-egress-deny']).toBeUndefined();
    expect(calls).toEqual(['public.test']);

    calls.length = 0;
    const denied = await rawRequest(port, 'GET http://public.test:8080/ HTTP/1.1\r\n\r\n');
    expect(denied.status).toBe(403);
    expect(denied.headers['x-sora-egress-deny']).toBe('port');
    expect(calls).toEqual([]);
  });

  test.each([
    ['127.0.0.1', 'private_ip'],
    ['0x7f.1', 'private_ip'],
    ['[::1]', 'private_ip'],
    ['169.254.169.254', 'private_ip'],
    ['localhost', 'blocked_host'],
    ['metadata.google.internal', 'blocked_host'],
  ])('内部の宛先 %s は、名前を解決せず、宛先にも送らずに拒否する（403・%s）', async (host, reason) => {
    const origin = await startOrigin();
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port] });

    const reply = await rawRequest(port, `GET http://${host}:${origin.port}/ HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe(reason);
    expect(calls).toEqual([]);
    expect(origin.requests).toHaveLength(0);
  });

  test('ループバックに解決される名前（rebinding）は、拒否して、宛先に送らない（403・private_ip）', async () => {
    const origin = await startOrigin();
    const { resolve } = fakeResolver({ 'evil.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port] });

    const reply = await rawRequest(port, `GET http://evil.test:${origin.port}/ HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(origin.requests).toHaveLength(0);
  });

  test.each([
    ['https の絶対 URI（TLS は CONNECT で）', 'GET https://origin.test/ HTTP/1.1\r\n\r\n'],
    ['http でない絶対 URI', 'GET ftp://origin.test/ HTTP/1.1\r\n\r\n'],
    ['origin-form（プロキシへの要求ではない）', 'GET /path HTTP/1.1\r\nHost: origin.test\r\n\r\n'],
    ['URI に資格情報が入っている', 'GET http://user:pw@origin.test/ HTTP/1.1\r\n\r\n'],
    ['ホストの後ろに余計な文字', 'GET http://origin.test:80x/ HTTP/1.1\r\n\r\n'],
    ['Upgrade（WebSocket は CONNECT で）', 'GET http://origin.test/ HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'],
    ['頭部の行にコロンがない', 'GET http://origin.test/ HTTP/1.1\r\nbroken header line\r\n\r\n'],
    ['頭部の折り返し（obs-fold）', 'GET http://origin.test/ HTTP/1.1\r\nX-A: 1\r\n  continued: 2\r\n\r\n'],
    ['頭部の名前の後ろ（コロンの前）に空白', 'GET http://origin.test/ HTTP/1.1\r\nX-A : 1\r\n\r\n'],
    ['頭部の名前に使えない文字', 'GET http://origin.test/ HTTP/1.1\r\nX(A): 1\r\n\r\n'],
    ['頭部の値に制御文字（NUL）', 'GET http://origin.test/ HTTP/1.1\r\nX-A: a\u0000b\r\n\r\n'],
  ])('書式・方針の誤り（%s）は 400 で拒否する', async (_label, head) => {
    const { resolve, calls } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, head);
    expect(reply.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// ---- 上流のプロキシ（運用者の SORA_PROXY_*）への連鎖 ----

const startFakeUpstream = (reply?: (head: string) => string | Buffer) => kit.startFakeHttpProxy({ reply });

describe('上流のプロキシ: 名前・IP リテラル・ポートを検査し、解決は上流に任せる', () => {
  test('CONNECT は、上流に CONNECT を送り、資格情報を付ける。名前は解決しない。200 のあとは、双方向に中継する', async () => {
    const upstream = await startFakeUpstream();
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, upstream: { host: '127.0.0.1', port: upstream.port, username: 'user', password: 'p@ss' } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
    expect(upstream.heads).toHaveLength(1);
    const lines = upstream.heads[0].split('\r\n');
    expect(lines[0]).toBe('CONNECT target.test:443 HTTP/1.1');
    expect(lines).toContain('Host: target.test:443');
    expect(lines).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    expect(calls).toEqual([]);
  });

  test('公開の IPv6 リテラルの宛先は、角括弧つきで上流に渡す', async () => {
    const upstream = await startFakeUpstream();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, connectHead('[2606:4700:4700::1111]:443'));
    expect(reply.status).toBe(200);
    expect(upstream.heads[0].split('\r\n')[0]).toBe('CONNECT [2606:4700:4700::1111]:443 HTTP/1.1');
  });

  test('資格情報がなければ、Proxy-Authorization は付けない', async () => {
    const upstream = await startFakeUpstream();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    await rawRequest(port, connectHead('target.test:443'));
    expect(upstream.heads[0].toLowerCase()).not.toContain('proxy-authorization');
  });

  test('上流の 200 の頭部と同じ送信に混じっていたトンネルのバイトも、クライアントへ渡す', async () => {
    const upstream = await startFakeUpstream(() => 'HTTP/1.1 200 Connection Established\r\n\r\nhi');
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 2, reply.rest)).toString()).toBe('hi');
  });

  test.each([
    ['127.0.0.1:443', 'private_ip'],
    ['0x7f.1:443', 'private_ip'],
    ['[::1]:443', 'private_ip'],
    ['169.254.169.254:80', 'private_ip'],
    ['localhost:443', 'blocked_host'],
    ['metadata.google.internal:80', 'blocked_host'],
    ['public.test:22', 'port'],
  ])('上流を使っても、%s は拒否する（403・%s）。上流には何も送らない', async (target, reason) => {
    const upstream = await startFakeUpstream();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, connectHead(target));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe(reason);
    expect(upstream.connections).toHaveLength(0);
  });

  test.each([
    ['403 Forbidden', 'HTTP/1.1 403 Forbidden\r\n\r\n'],
    ['407 Proxy Authentication Required', 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'],
    ['502 Bad Gateway', 'HTTP/1.1 502 Bad Gateway\r\n\r\n'],
    ['読めない応答', 'garbage\r\n\r\n'],
  ])('上流が CONNECT を断ったら（%s）、クライアントには 502 を返し、トンネルを作らない', async (_label, response) => {
    const upstream = await startFakeUpstream(() => response);
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBeUndefined();
  });

  test('上流に接続できなければ 502', async () => {
    const dead = await closedPort();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: dead } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
  });

  test('上流が頭部を返さなければ、時間切れで 502', async () => {
    const silent = await startTcpServer(() => {});
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: silent.port }, connectTimeoutMs: 100 });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
  });

  test('http:// の転送は、絶対 URI のまま上流に送り、資格情報を付け、Connection: close にする。名前は解決しない', async () => {
    const upstream = await startFakeUpstream();
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, upstream: { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' } });

    const reply = await rawRequest(port, 'GET http://origin.test/path?x=1 HTTP/1.1\r\nHost: wrong\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\nX-Custom: a\r\n\r\n');
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 2, reply.rest)).toString()).toBe('up');
    const lines = upstream.heads[0].split('\r\n');
    expect(lines[0]).toBe('GET http://origin.test/path?x=1 HTTP/1.1');
    expect(lines.slice(1).sort()).toEqual(
      ['Connection: close', 'Host: origin.test', `Proxy-Authorization: Basic ${Buffer.from('u:p').toString('base64')}`, 'X-Custom: a'].sort(),
    );
    expect(calls).toEqual([]);
  });

  test('http:// の転送でも、内部の宛先は上流に送らずに拒否する（403・private_ip）', async () => {
    const upstream = await startFakeUpstream();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, 'GET http://127.0.0.1/ HTTP/1.1\r\n\r\n');
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(upstream.connections).toHaveLength(0);
  });
});

// ---- 資源と後始末 ----

describe('資源の上限と後始末', () => {
  test('同時の接続数の上限を超えた要求は、503 で断る（理由は limit）。空けば、また受ける', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], maxConnections: 2, ...treatLoopbackAsPublic });

    const first = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    const second = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    expect([first.status, second.status]).toEqual([200, 200]);

    const third = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    expect(third.status).toBe(503);
    expect(third.headers['x-sora-egress-deny']).toBe('limit');
    expect(getSecurityMetrics().sora_egress_denied_limit_total).toBe(1);

    first.socket.destroy();
    // 空いたあとは、受ける（接続の後始末が済むのを待つ）
    let again: ProxyReply | undefined;
    expect(
      await waitUntil(() => {
        void rawRequest(port, connectHead(`echo.test:${echo.port}`)).then((reply) => {
          if (reply.status === 200) again = reply;
        }, () => {});
        return again !== undefined;
      }, 3000),
    ).toBe(true);
  });

  test('無通信の接続は、時間切れで両側とも閉じる。通信が続いている間は、閉じない', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [echo.port], idleTimeoutMs: 150, ...treatLoopbackAsPublic });

    // 通信が続いている接続は、無通信の時間（150ms）を超えても、閉じない
    const busy = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    for (let i = 0; i < 6; i++) {
      busy.socket.write('x');
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(busy.socket.destroyed).toBe(false);

    // 何も送らない接続は、閉じる。宛先側の接続も、閉じる
    const idle = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    expect(await closesWithin(idle.socket, 2000)).toBe(true);
    expect(await waitUntil(() => echo.connections[1].destroyed, 2000)).toBe(true); // 2 本目（何も送らなかった接続）の宛先側
  });

  test('stop() は、中継中の接続（クライアント側も宛先側も）を切り、待ち受けを閉じる', async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    const { gateway, port } = await startGateway({ resolve, allowedPorts: [echo.port], ...treatLoopbackAsPublic });

    const tunnel = await rawRequest(port, connectHead(`echo.test:${echo.port}`));
    await gateway.stop();

    expect(await closesWithin(tunnel.socket, 2000)).toBe(true);
    expect(await waitUntil(() => echo.connections.every((connection) => connection.destroyed))).toBe(true);
    // 待ち受けは閉じている
    await expect(
      new Promise<void>((resolveConnect, rejectConnect) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolveConnect();
        });
        socket.once('error', rejectConnect);
      }),
    ).rejects.toThrow();
  });

  test('想定外の例外（実装の誤り）では、応答を返さずに接続を切り、警告を 1 行出す（黙って落とさない）', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { port } = await startGateway({
        isPrivateIp: () => {
          throw new Error('boom');
        },
      });
      const socket = net.connect({ host: '127.0.0.1', port });
      kit.addCleanup(() => void socket.destroy());
      socket.write(connectHead('example.test:443'));
      expect(await closesWithin(socket, 2000)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('boom');
    } finally {
      warn.mockRestore();
    }
  });

  test('start() を 2 回呼ぶと、エラー（待ち受けを重ねない）', async () => {
    const { gateway } = await startGateway();
    await expect(gateway.start()).rejects.toThrow('すでに始まっている');
  });
});

// ---- http:// の転送: 1 つの接続で、1 つの要求だけを通す ----

describe('http:// の転送: 要求の枠（Content-Length）を超えたバイトは、宛先へ流さない', () => {
  const smuggled = 'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n';

  test('頭部と同じ送信に、続けて 2 つ目の要求が混じっていたら、何も転送せずに 400 で断る', async () => {
    const origin = await startOrigin();
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `GET http://origin.test:${origin.port}/a HTTP/1.1\r\n\r\n${smuggled}`);
    expect(reply.status).toBe(400);
    expect(origin.received).toEqual([]); // 宛先には、接続もしていない
    expect(getSecurityMetrics().sora_egress_denied_bad_request_total).toBe(1);
  });

  test('上流のプロキシにも、続けて送られた 2 つ目の要求は届かない（上流には接続もしない）', async () => {
    const upstream = await startFakeUpstream();
    const { port } = await startGateway({ upstream: { host: '127.0.0.1', port: upstream.port } });

    const reply = await rawRequest(port, `GET http://origin.test/a HTTP/1.1\r\n\r\n${smuggled}`);
    expect(reply.status).toBe(400);
    expect(upstream.connections).toHaveLength(0);
  });

  test('本文の後ろに余計なバイトが混じっていたら（Content-Length を超える）、何も転送せずに 400 で断る', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `POST http://origin.test:${origin.port}/p HTTP/1.1\r\nContent-Length: 5\r\n\r\nhelloEXTRA`);
    expect(reply.status).toBe(400);
    expect(origin.received).toEqual([]);
  });

  test('本文が分かれて届き、そのあとに余計なバイトが続いたら、枠までを転送し、余計な分は流さずに切る', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = rawRequest(port, `POST http://origin.test:${origin.port}/p HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc`, 'defghijJUNK');
    // 応答は来ない（余計なバイトで、接続を切る）。宛先が受け取った本文を見る
    void reply.catch(() => {});
    expect(await waitUntil(() => origin.requests.length === 1)).toBe(true);
    expect(origin.requests[0].body.toString()).toBe('abcdefghij');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(origin.received.map((bytes) => bytes.toString('latin1')).join('')).not.toContain('JUNK');
    expect(getSecurityMetrics().sora_egress_denied_bad_request_total).toBe(1);
  });

  test('本文が分かれて届いても、Content-Length の長さまでは、すべて転送する', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `POST http://origin.test:${origin.port}/p HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc`, 'defghij');
    expect(reply.status).toBe(200);
    expect(origin.requests[0].body.toString()).toBe('abcdefghij');
  });

  test('大きな本文（3MB）も、数え違いなく、欠けも超過もなく転送する', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });
    const body = randomBytes(3 * 1024 * 1024);

    // 頭部と本文の最初の 1000 バイトを送り、50ms 後に残りを送る（宛先は、本文がそろってから応答する）
    const head = Buffer.from(`POST http://origin.test:${origin.port}/upload HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1');
    const reply = await rawRequest(port, Buffer.concat([head, body.subarray(0, 1000)]), body.subarray(1000));
    expect(reply.status).toBe(200);
    expect(origin.requests[0].body.equals(body)).toBe(true);
  });

  test('応答のあとに、クライアントが余計なバイトを送ったら、接続を切る', async () => {
    const origin = await startOrigin('hello');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `GET http://origin.test:${origin.port}/a HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(200);
    reply.socket.write(smuggled);
    expect(await closesWithin(reply.socket, 2000)).toBe(true);
    expect(origin.received.map((bytes) => bytes.toString('latin1')).join('')).not.toContain('169.254.169.254');
  });

  test.each([
    ['Transfer-Encoding（chunked）の要求本文', 'POST http://origin.test/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'],
    ['Content-Length が数でない', 'POST http://origin.test/ HTTP/1.1\r\nContent-Length: abc\r\n\r\n'],
    ['Content-Length が負', 'POST http://origin.test/ HTTP/1.1\r\nContent-Length: -1\r\n\r\n'],
    ['Content-Length が 2 つで食い違う', 'POST http://origin.test/ HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab'],
  ])('枠を決められない要求（%s）は 400 で拒否する', async (_label, head) => {
    const { resolve, calls } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, head);
    expect(reply.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('宛先への接続を待っている間に届いた本文も、失わずに転送する', async () => {
    const origin = await startOrigin('ok');
    const resolve = async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      return ['127.0.0.1'];
    };
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    // 頭部と本文の最初の 3 バイトを送り、50ms 後に残りを送る。名前の解決の途中に、残りが届く
    const reply = await rawRequest(port, `POST http://slow.test:${origin.port}/p HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc`, 'defghij');
    expect(reply.status).toBe(200);
    expect(origin.requests[0].body.toString()).toBe('abcdefghij');
  });

  test('Content-Length が同じ値で重なっていれば、受け付ける', async () => {
    const origin = await startOrigin('ok');
    const { resolve } = fakeResolver({ 'origin.test': ['127.0.0.1'] });
    const { port } = await startGateway({ resolve, allowedPorts: [origin.port], ...treatLoopbackAsPublic });

    const reply = await rawRequest(port, `POST http://origin.test:${origin.port}/ HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab`);
    expect(reply.status).toBe(200);
    expect(origin.requests[0].body.toString()).toBe('ab');
  });
});
