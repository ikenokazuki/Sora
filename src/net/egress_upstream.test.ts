import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { type EgressUpstream, parseUpstreamProxyUrl } from './egress_gateway.js';
import { closedPort, closesWithin, connectHead, createEgressTestKit, fakeResolver, readBytes, waitUntil } from './egress_test_kit.js';

const kit = createEgressTestKit();
const { startTcpServer, startGateway, rawRequest } = kit;
afterEach(async () => {
  await kit.cleanup();
  resetSecurityMetrics();
});

describe('parseUpstreamProxyUrl: 運用者のプロキシの URL（SORA_PROXY_URL など）を、上流の設定に直す', () => {
  const parsed: Array<[string, EgressUpstream]> = [
    ['http://proxy.example:8080', { type: 'http', host: 'proxy.example', port: 8080 }],
    ['http://proxy.example', { type: 'http', host: 'proxy.example', port: 80 }],
    ['https://proxy.example', { type: 'https', host: 'proxy.example', port: 443 }],
    ['https://proxy.example:8443', { type: 'https', host: 'proxy.example', port: 8443 }],
    ['socks5://proxy.example:1081', { type: 'socks5', host: 'proxy.example', port: 1081 }],
    ['socks5://proxy.example', { type: 'socks5', host: 'proxy.example', port: 1080 }],
    // socks5h は、名前の解決をプロキシに任せる書き方。この上流の扱いは、どちらも、プロキシが解決する
    ['socks5h://proxy.example:1080', { type: 'socks5', host: 'proxy.example', port: 1080 }],
    // 資格情報（パーセントエンコードされた文字は、戻す）
    ['http://user:p%40ss%3Aword@proxy.example:3128', { type: 'http', host: 'proxy.example', port: 3128, username: 'user', password: 'p@ss:word' }],
    ['socks5://user:secret@proxy.example:1080', { type: 'socks5', host: 'proxy.example', port: 1080, username: 'user', password: 'secret' }],
    ['https://user@proxy.example', { type: 'https', host: 'proxy.example', port: 443, username: 'user' }],
    // スキームと名前は、大文字小文字を区別しない。IPv6 は、角括弧を外す
    ['HTTP://Proxy.Example:3128', { type: 'http', host: 'proxy.example', port: 3128 }],
    ['http://[2001:db8::1]:3128', { type: 'http', host: '2001:db8::1', port: 3128 }],
  ];
  test.each(parsed)('%s', (url, expected) => {
    expect(parseUpstreamProxyUrl(url)).toEqual(expected);
  });

  test.each([
    ['socks4://proxy.example:1080', 'socks4'],
    ['socks://proxy.example:1080', 'socks'],
    ['ftp://proxy.example', 'ftp'],
    ['proxy.example:8080', '読めない'],
    ['', '読めない'],
    ['http://', '読めない'],
    ['http://proxy.example:0', 'ポート'],
    ['http://proxy.example:65536', '読めない'],
  ])('%j は、理由を添えたエラー（%s）', (url, reason) => {
    expect(() => parseUpstreamProxyUrl(url)).toThrow(reason);
  });

  test('エラーの文に、資格情報（パスワード）を含めない', () => {
    expect(() => parseUpstreamProxyUrl('socks4://user:topsecret@proxy.example:1080')).toThrow(/^(?!.*topsecret)/s);
  });
});

// ---- 上流の socks5 プロキシ ----

interface SocksRequest {
  /** 宛先の書き方（名前なら domain。名前をプロキシに解決させる） */
  atyp: 'ipv4' | 'domain' | 'ipv6';
  host: string;
  port: number;
  /** 認証で受け取った資格情報 */
  user?: string;
  pass?: string;
}

interface FakeSocks {
  port: number;
  requests: SocksRequest[];
  connections: net.Socket[];
  /** 接続の確立のあとに受け取った、HTTP の要求の頭部 */
  httpHeads: string[];
  /** 接続の確立のあとに受け取った、全バイト */
  tunnelBytes: () => Buffer;
}

/**
 * SOCKS5 の最小のサーバー（RFC 1928・1929）。接続の要求を記録し、確立のあとは、受けたバイトをそのまま返す
 * （HTTP の要求の頭部を受けたときは、頭部を記録して、決まった応答を返す）。
 */
async function startFakeSocks5(
  options: {
    auth?: { user: string; pass: string };
    replyCode?: number;
    silent?: boolean;
    /** 確立のあと、最初のバイトを受けたら、送信を終える（FIN）。それ以降の受信は続ける（半閉じ） */
    endAfterFirstData?: boolean;
  } = {},
): Promise<FakeSocks> {
  const requests: SocksRequest[] = [];
  const httpHeads: string[] = [];
  let tunnel = Buffer.alloc(0);
  const server = await startTcpServer((socket) => {
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting';
    let buffered = Buffer.alloc(0);
    let credentials: { user?: string; pass?: string } = {};
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
          const methods = [...buffered.subarray(2, 2 + buffered[1])];
          buffered = buffered.subarray(2 + buffered[1]);
          if (options.auth) {
            if (!methods.includes(0x02)) return void socket.end(Buffer.from([5, 0xff]));
            socket.write(Buffer.from([5, 0x02]));
            stage = 'auth';
          } else {
            socket.write(Buffer.from([5, 0x00]));
            stage = 'request';
          }
        } else if (stage === 'auth') {
          if (buffered.length < 2) return;
          const userLength = buffered[1];
          if (buffered.length < 3 + userLength) return;
          const passLength = buffered[2 + userLength];
          if (buffered.length < 3 + userLength + passLength) return;
          const user = buffered.subarray(2, 2 + userLength).toString();
          const pass = buffered.subarray(3 + userLength, 3 + userLength + passLength).toString();
          buffered = buffered.subarray(3 + userLength + passLength);
          credentials = { user, pass };
          if (user !== options.auth?.user || pass !== options.auth?.pass) return void socket.end(Buffer.from([1, 1]));
          socket.write(Buffer.from([1, 0]));
          stage = 'request';
        } else if (stage === 'request') {
          if (buffered.length < 4) return;
          const atyp = buffered[3];
          let length: number;
          if (atyp === 1) length = 4 + 4 + 2;
          else if (atyp === 4) length = 4 + 16 + 2;
          else if (atyp === 3) {
            if (buffered.length < 5) return;
            length = 4 + 1 + buffered[4] + 2;
          } else return void socket.destroy();
          if (buffered.length < length) return;
          let kind: SocksRequest['atyp'];
          let host: string;
          if (atyp === 1) {
            kind = 'ipv4';
            host = [...buffered.subarray(4, 8)].join('.');
          } else if (atyp === 4) {
            kind = 'ipv6';
            host = Array.from({ length: 8 }, (_, i) => buffered.readUInt16BE(4 + i * 2).toString(16)).join(':');
          } else {
            kind = 'domain';
            host = buffered.subarray(5, 5 + buffered[4]).toString();
          }
          requests.push({ atyp: kind, host, port: buffered.readUInt16BE(length - 2), ...credentials });
          buffered = buffered.subarray(length);
          if (options.silent) return;
          const reply = options.replyCode ?? 0;
          socket.write(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (reply !== 0) return void socket.end();
          stage = 'tunnel';
        } else {
          if (buffered.length === 0) return;
          const data = buffered;
          buffered = Buffer.alloc(0);
          const firstData = tunnel.length === 0;
          tunnel = Buffer.concat([tunnel, data]);
          const text = data.toString('latin1');
          if (/^(GET|POST) /.test(text) && text.includes('\r\n\r\n')) {
            httpHeads.push(text.split('\r\n\r\n')[0]);
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nup');
          } else if (options.endAfterFirstData && firstData) socket.end('bye');
          else if (!options.endAfterFirstData) socket.write(data);
          return;
        }
      }
    });
  }, options.endAfterFirstData ? { allowHalfOpen: true } : {});
  return { port: server.port, requests, connections: server.connections, httpHeads, tunnelBytes: () => tunnel };
}

describe('上流の socks5 プロキシ: 名前・IP リテラル・ポートを検査し、解決は上流に任せる', () => {
  test('CONNECT は、宛先を名前のまま上流に渡す（名前は、プロキシが解決する）。確立のあとは、双方向に中継する', async () => {
    const socks = await startFakeSocks5();
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
    expect(socks.requests).toEqual([{ atyp: 'domain', host: 'target.test', port: 443 }]);
    expect(calls).toEqual([]);
  });

  test('IPv4・IPv6 のリテラルは、それぞれの書き方で渡す', async () => {
    const socks = await startFakeSocks5();
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    expect((await rawRequest(port, connectHead('8.8.8.8:443'))).status).toBe(200);
    expect((await rawRequest(port, connectHead('[2606:4700:4700::1111]:443'))).status).toBe(200);
    expect(socks.requests).toEqual([
      { atyp: 'ipv4', host: '8.8.8.8', port: 443 },
      { atyp: 'ipv6', host: '2606:4700:4700:0:0:0:0:1111', port: 443 },
    ]);
  });

  test('資格情報があれば、ユーザー名・パスワードで認証する', async () => {
    const socks = await startFakeSocks5({ auth: { user: 'user', pass: 'p@ss' } });
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'user', password: 'p@ss' } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(200);
    expect(socks.requests).toEqual([{ atyp: 'domain', host: 'target.test', port: 443, user: 'user', pass: 'p@ss' }]);
  });

  test('認証に失敗したら（パスワードの誤り）502。トンネルを作らない', async () => {
    const socks = await startFakeSocks5({ auth: { user: 'user', pass: 'right' } });
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'user', password: 'wrong' } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBeUndefined();
    expect(socks.requests).toEqual([]);
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
    const socks = await startFakeSocks5();
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    const reply = await rawRequest(port, connectHead(target));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe(reason);
    expect(socks.connections).toHaveLength(0);
  });

  test.each([
    ['接続が許されない（0x02）', 0x02],
    ['接続が拒否された（0x05）', 0x05],
    ['ホストに届かない（0x04）', 0x04],
  ])('上流が接続を断ったら（%s）、502。トンネルを作らない', async (_label, replyCode) => {
    const socks = await startFakeSocks5({ replyCode });
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBeUndefined();
    expect(getSecurityMetrics()).toEqual({});
  });

  test('上流に接続できなければ 502', async () => {
    const dead = await closedPort();
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: dead } });

    expect((await rawRequest(port, connectHead('target.test:443'))).status).toBe(502);
  });

  test('上流が応答しなければ、時間切れで 502', async () => {
    const socks = await startFakeSocks5({ silent: true });
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port }, connectTimeoutMs: 200 });

    expect((await rawRequest(port, connectHead('target.test:443'))).status).toBe(502);
  });

  test('http:// の転送は、確立した接続に、origin-form で送る（上流のプロキシ向けのヘッダーは付けない）', async () => {
    const socks = await startFakeSocks5({ auth: { user: 'u', pass: 'p' } });
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'u', password: 'p' } });

    const reply = await rawRequest(port, 'GET http://origin.test/path?x=1 HTTP/1.1\r\nHost: wrong\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\nX-Custom: a\r\n\r\n');
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 2, reply.rest)).toString()).toBe('up');
    expect(socks.requests).toEqual([{ atyp: 'domain', host: 'origin.test', port: 80, user: 'u', pass: 'p' }]);
    const lines = socks.httpHeads[0].split('\r\n');
    expect(lines[0]).toBe('GET /path?x=1 HTTP/1.1');
    expect(lines.slice(1).sort()).toEqual(['Connection: close', 'Host: origin.test', 'X-Custom: a']);
    expect(calls).toEqual([]);
  });

  test('大きなデータも、欠けなく往復する', async () => {
    const socks = await startFakeSocks5();
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });
    const payload = randomBytes(2 * 1024 * 1024);

    const reply = await rawRequest(port, connectHead('target.test:443'));
    reply.socket.write(payload);
    const echoed = await readBytes(reply.socket, payload.length, reply.rest, 15_000);
    expect(echoed.equals(payload)).toBe(true);
  });

  test('宛先が先に送信を終えても（半閉じ）、クライアントの続きの送信は、宛先に届く', async () => {
    const socks = await startFakeSocks5({ endAfterFirstData: true });
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    // 半閉じを受けても閉じ返さない、クライアント
    const client = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    kit.addCleanup(() => void client.destroy());
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write(connectHead('target.test:443'));
    const opened = await new Promise<Buffer>((resolve) => client.once('data', resolve));
    expect(opened.toString('latin1')).toContain('200');
    client.write('x');
    expect((await readBytes(client, 3)).toString()).toBe('bye'); // 宛先が、送信を終えた
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.write('later');

    expect(await waitUntil(() => socks.tunnelBytes().toString() === 'xlater')).toBe(true);
  });

  test('クライアントが送信を終えても、宛先からの応答を受け取れる（半閉じ）', async () => {
    const socks = await startFakeSocks5();
    const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: socks.port } });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    reply.socket.end('bye'); // クライアントが、送信を終える
    expect((await readBytes(reply.socket, 3, reply.rest)).toString()).toBe('bye'); // エコーは、返ってくる
    expect(await closesWithin(reply.socket, 2000)).toBe(true);
  });
});

// ---- 上流の https プロキシ（プロキシへの接続が TLS） ----

// テスト用の自己署名の証明書は、実行時に openssl で作る（鍵をリポジトリに置かない）。openssl が無い環境では、TLS のテストを飛ばす
const openssl = Bun.which('openssl') ?? process.env.OPENSSL_BIN;
const tlsTest = openssl ? test : test.skip;

function generateCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sora-egress-tls-'));
  try {
    const result = Bun.spawnSync([
      openssl as string,
      ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
      ...['-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '2', '-subj', '/CN=localhost'],
      ...['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    ]);
    if (result.exitCode !== 0) throw new Error(`openssl が失敗した: ${result.stderr.toString()}`);
    return { key: readFileSync(`${dir}/key.pem`, 'utf8'), cert: readFileSync(`${dir}/cert.pem`, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('上流の https プロキシ: プロキシへの接続が TLS', () => {
  const certificate = openssl ? generateCertificate() : { key: '', cert: '' };
  const httpsUpstream = (port: number, extra: Partial<EgressUpstream> = {}): EgressUpstream => ({
    type: 'https',
    host: '127.0.0.1',
    port,
    ca: certificate.cert,
    ...extra,
  });

  tlsTest('CONNECT は、TLS でプロキシに接続し、資格情報つきの CONNECT を送る。200 のあとは、双方向に中継する', async () => {
    const proxy = await kit.startFakeHttpProxy({ tls: certificate });
    const { resolve, calls } = fakeResolver({});
    const { port } = await startGateway({ resolve, upstream: httpsUpstream(proxy.port, { username: 'user', password: 'p@ss' }) });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
    const lines = proxy.heads[0].split('\r\n');
    expect(lines[0]).toBe('CONNECT target.test:443 HTTP/1.1');
    expect(lines).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    expect(calls).toEqual([]);
  });

  tlsTest('プロキシの証明書を検証できなければ（信頼していない自己署名）、502。プロキシには何も送らない', async () => {
    const proxy = await kit.startFakeHttpProxy({ tls: certificate });
    const { port } = await startGateway({ upstream: httpsUpstream(proxy.port, { ca: undefined }) });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
    expect(reply.headers['x-sora-egress-deny']).toBeUndefined();
    expect(proxy.heads).toEqual([]);
  });

  tlsTest('プロキシが TLS を話さなければ（平文のプロキシに、https として接続）、502', async () => {
    const plain = await kit.startFakeHttpProxy();
    const { port } = await startGateway({ upstream: httpsUpstream(plain.port), connectTimeoutMs: 500 });

    expect((await rawRequest(port, connectHead('target.test:443'))).status).toBe(502);
  });

  tlsTest('プロキシが CONNECT を断ったら 502', async () => {
    const proxy = await kit.startFakeHttpProxy({ tls: certificate, reply: () => 'HTTP/1.1 403 Forbidden\r\n\r\n' });
    const { port } = await startGateway({ upstream: httpsUpstream(proxy.port) });

    const reply = await rawRequest(port, connectHead('target.test:443'));
    expect(reply.status).toBe(502);
  });

  tlsTest('http:// の転送は、TLS のプロキシへ、絶対 URI・Proxy-Authorization つきで送る', async () => {
    const proxy = await kit.startFakeHttpProxy({ tls: certificate });
    const { port } = await startGateway({ upstream: httpsUpstream(proxy.port, { username: 'u', password: 'p' }) });

    const reply = await rawRequest(port, 'GET http://origin.test/path?x=1 HTTP/1.1\r\nHost: wrong\r\nX-Custom: a\r\n\r\n');
    expect(reply.status).toBe(200);
    expect((await readBytes(reply.socket, 2, reply.rest)).toString()).toBe('up');
    const lines = proxy.heads[0].split('\r\n');
    expect(lines[0]).toBe('GET http://origin.test/path?x=1 HTTP/1.1');
    expect(lines.slice(1).sort()).toEqual(
      ['Connection: close', 'Host: origin.test', `Proxy-Authorization: Basic ${Buffer.from('u:p').toString('base64')}`, 'X-Custom: a'].sort(),
    );
  });

  tlsTest('内部の宛先は、プロキシに接続せずに拒否する（403・private_ip）', async () => {
    const proxy = await kit.startFakeHttpProxy({ tls: certificate });
    const { port } = await startGateway({ upstream: httpsUpstream(proxy.port) });

    const reply = await rawRequest(port, connectHead('127.0.0.1:443'));
    expect(reply.status).toBe(403);
    expect(reply.headers['x-sora-egress-deny']).toBe('private_ip');
    expect(proxy.connections).toHaveLength(0);
  });
});

// ---- 上流の接続の失敗は、運用者が気づけるように、警告を出す ----

describe('上流の接続の失敗: 設定の誤りに気づけるよう、同じ理由の警告は 1 回だけ出す', () => {
  const withWarnings = async (run: (warn: ReturnType<typeof spyOn<Console, 'warn'>>) => Promise<void>) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(warn);
    } finally {
      warn.mockRestore();
    }
  };

  test('socks5 の上流に接続できない: 要求のたびには出さず、1 回だけ。上流の種類と宛先が分かる', async () => {
    await withWarnings(async (warn) => {
      const dead = await closedPort();
      const { port } = await startGateway({ upstream: { type: 'socks5', host: '127.0.0.1', port: dead } });
      for (let i = 0; i < 3; i++) expect((await rawRequest(port, connectHead('target.test:443'))).status).toBe(502);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('上流の socks5 プロキシ');
    });
  });

  test('http の上流に接続できない: 上流の種類と宛先が分かる。資格情報は出さない', async () => {
    await withWarnings(async (warn) => {
      const dead = await closedPort();
      const { port } = await startGateway({ upstream: { type: 'http', host: '127.0.0.1', port: dead, username: 'user', password: 'topsecret' } });
      expect((await rawRequest(port, connectHead('target.test:443'))).status).toBe(502);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain(`127.0.0.1:${dead}`);
      expect(message).not.toContain('topsecret');
    });
  });

  test('上流が CONNECT を断った理由（407 など）が分かる。別の理由なら、別に 1 回', async () => {
    await withWarnings(async (warn) => {
      const proxy407 = await kit.startFakeHttpProxy({ reply: () => 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n' });
      const { port: port407 } = await startGateway({ upstream: { host: '127.0.0.1', port: proxy407.port } });
      expect((await rawRequest(port407, connectHead('target.test:443'))).status).toBe(502);
      expect(String(warn.mock.calls[0][0])).toContain('407');

      const proxy403 = await kit.startFakeHttpProxy({ reply: () => 'HTTP/1.1 403 Forbidden\r\n\r\n' });
      const { port: port403 } = await startGateway({ upstream: { host: '127.0.0.1', port: proxy403.port } });
      expect((await rawRequest(port403, connectHead('target.test:443'))).status).toBe(502);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1][0])).toContain('403');
    });
  });

  test('方針による拒否（403）と、直接つなぐときの接続の失敗では、警告を出さない', async () => {
    await withWarnings(async (warn) => {
      const dead = await closedPort();
      const { resolve } = fakeResolver({ 'down.test': ['127.0.0.1'] });
      const { port } = await startGateway({ resolve, allowedPorts: [dead], isPrivateIp: () => false });
      expect((await rawRequest(port, connectHead('127.0.0.1:22'))).status).toBe(403);
      expect((await rawRequest(port, connectHead(`down.test:${dead}`))).status).toBe(502);

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
