/**
 * 出口のゲートウェイのテスト（egress_gateway.test.ts・egress_upstream.test.ts）が共有する、テスト用の道具。
 * 本番のコードからは使わない。テストのファイルごとに createEgressTestKit() を 1 つ作り、afterEach で cleanup() を呼ぶ
 * （作ったサーバー・接続・ゲートウェイを、後始末する）。
 */
import net from 'node:net';
import tls from 'node:tls';
import { EgressGateway, type EgressGatewayOptions } from './egress_gateway.js';

export interface ProxyReply {
  status: number;
  headers: Record<string, string>;
  socket: net.Socket;
  /** 頭部の後ろに、すでに届いていたバイト */
  rest: Buffer;
}

export interface RecordedRequest {
  /** 要求行と頭部（空行の前まで） */
  head: string;
  body: Buffer;
}

/** 運用者の（HTTP の）プロキシの代役 */
export interface FakeHttpProxy {
  port: number;
  /** 受け取った、最初の要求の頭部（空行の前まで） */
  heads: string[];
  connections: net.Socket[];
  /** 接続ごとに、プロキシが受け取った全バイト */
  received: Buffer[];
}

export interface Origin {
  port: number;
  requests: RecordedRequest[];
  /** 接続ごとに、宛先が受け取った全バイト（頭部・本文のほか、余計なバイトが届いていないかを見るため） */
  received: Buffer[];
}

/** 誰も待ち受けていないポート（接続できない宛先） */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 名前の表から解決する偽のリゾルバー。表に無い名前は、解決に失敗する。呼ばれた名前を記録する */
export function fakeResolver(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    const addresses = table[host];
    if (!addresses) throw new Error(`ENOTFOUND ${host}`);
    return addresses;
  };
  return { resolve, calls };
}

export const connectHead = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

/** ソケットから、ちょうど n バイトを読む（すでに読んだ分は prefix で渡す）。時間内に揃わなければ、そこまでを返す */
export function readBytes(socket: net.Socket, n: number, prefix: Buffer = Buffer.alloc(0), timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve) => {
    let received = prefix;
    const finish = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(received);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= n) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (received.length >= n) return finish();
    socket.on('data', onData);
  });
}

/** 接続が閉じるのを待つ。閉じたら true、時間内に閉じなければ false */
export function closesWithin(socket: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** 条件が成り立つまで待つ（時間内に成り立てば true） */
export async function waitUntil(predicate: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** テストの接続先（127.0.0.1 の自前のサーバー）を、「公開」とみなす判定 */
export const treatLoopbackAsPublic = { isPrivateIp: () => false };

/** サーバー・接続・ゲートウェイを作る道具。作ったものは、cleanup() で後始末する（ファイルごとに 1 つ作る） */
export function createEgressTestKit() {
  const cleanups: Array<() => void | Promise<void>> = [];

  const addCleanup = (action: () => void | Promise<void>) => void cleanups.push(action);
  const cleanup = async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  };

  /**
   * 接続を受ける TCP サーバーを立てる（tls を渡すと、TLS のサーバー）。閉じるときは、残っている接続も切る。
   * onConnection には、確立した接続（TLS なら、ハンドシェイクのあと）が渡る
   */
  async function startTcpServer(
    onConnection: (socket: net.Socket) => void,
    options: net.ServerOpts & { tls?: { key: string | Buffer; cert: string | Buffer } } = {},
  ): Promise<{ port: number; connections: net.Socket[] }> {
    const connections: net.Socket[] = [];
    const handler = (socket: net.Socket) => {
      connections.push(socket);
      socket.on('error', () => {}); // ゲートウェイが接続を切った後に書いても、テストを落とさない（切るのが、期待する動作の場合がある）
      onConnection(socket);
    };
    const { tls: tlsOptions, ...netOptions } = options;
    const server: net.Server = tlsOptions ? tls.createServer({ ...tlsOptions, ...netOptions }, handler) : net.createServer(netOptions, handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    addCleanup(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port: (server.address() as net.AddressInfo).port, connections };
  }

  const startEchoServer = () => startTcpServer((socket) => socket.pipe(socket));

  async function startGateway(options: EgressGatewayOptions = {}): Promise<{ gateway: EgressGateway; port: number }> {
    const gateway = new EgressGateway(options);
    const port = await gateway.start();
    addCleanup(() => gateway.stop());
    return { gateway, port };
  }

  /** ゲートウェイに、生の要求の頭部を送り、応答の頭部（空行まで）を読む */
  function rawRequest(port: number, head: string | Buffer, later?: string | Buffer): Promise<ProxyReply> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      addCleanup(() => void socket.destroy());
      let received = Buffer.alloc(0);
      socket.on('error', reject);
      socket.on('close', () => reject(new Error('応答の頭部の前に、接続が閉じた')));
      socket.on('data', function onData(chunk: Buffer) {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        const [statusLine, ...lines] = received.subarray(0, end).toString('latin1').split('\r\n');
        const headers = Object.fromEntries(
          lines.map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        resolve({ status: Number(statusLine.split(' ')[1]), headers, socket, rest: received.subarray(end + 4) });
      });
      socket.write(head);
      // 応答の頭部を待たずに、続き（本文の残りなど）を送る
      if (later !== undefined) setTimeout(() => socket.write(later), 50);
    });
  }

  /**
   * 1 つの要求を読んで記録し、決まった応答を返す、HTTP の宛先。
   * 要求に `Connection: close` が無ければ、応答のあとも接続を開けておく（keep-alive）。閉じるのは、ゲートウェイが付けさせたときだけ
   */
  async function startOrigin(responseBody: Buffer | string = 'hello'): Promise<Origin> {
    const requests: RecordedRequest[] = [];
    const everything: Buffer[] = [];
    const server = await startTcpServer((socket) => {
      let received = Buffer.alloc(0);
      let handled = false;
      const index = everything.push(Buffer.alloc(0)) - 1;
      socket.on('data', (chunk: Buffer) => {
        everything[index] = Buffer.concat([everything[index], chunk]);
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf('\r\n\r\n');
        if (end < 0 || handled) return;
        const head = received.subarray(0, end).toString('latin1');
        const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
        if (received.length < end + 4 + length) return;
        handled = true;
        requests.push({ head, body: received.subarray(end + 4, end + 4 + length) });
        const payload = Buffer.from(responseBody);
        const closing = /^connection:\s*close/im.test(head);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\nConnection: ${closing ? 'close' : 'keep-alive'}\r\n\r\n`);
        socket.write(payload);
        if (closing) socket.end();
      });
    });
    return { port: server.port, requests, received: everything };
  }

  /**
   * 運用者のプロキシの代わり。最初の要求の頭部を記録し、CONNECT には reply で答える（200 のあとは、受けたバイトをそのまま返す）。
   * CONNECT 以外（絶対 URI の要求）には、決まった本文の 200 で答えて閉じる。tls を渡すと、プロキシへの接続が TLS（https:// のプロキシ）
   */
  async function startFakeHttpProxy(
    options: { reply?: (head: string) => string | Buffer; tls?: { key: string | Buffer; cert: string | Buffer } } = {},
  ): Promise<FakeHttpProxy> {
    const reply = options.reply ?? (() => 'HTTP/1.1 200 Connection Established\r\n\r\n');
    const heads: string[] = [];
    const everything: Buffer[] = [];
    const server = await startTcpServer(
      (socket) => {
        let received = Buffer.alloc(0);
        let headDone = false;
        const index = everything.push(Buffer.alloc(0)) - 1;
        socket.on('data', (chunk: Buffer) => {
          everything[index] = Buffer.concat([everything[index], chunk]);
          if (headDone) return void socket.write(chunk); // トンネルの中は、エコー
          received = Buffer.concat([received, chunk]);
          const end = received.indexOf('\r\n\r\n');
          if (end < 0) return;
          headDone = true;
          const head = received.subarray(0, end).toString('latin1');
          heads.push(head);
          if (head.startsWith('CONNECT ')) {
            socket.write(reply(head));
            const after = received.subarray(end + 4);
            if (after.length > 0) socket.write(after);
          } else {
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nup');
          }
        });
      },
      options.tls ? { tls: options.tls } : {},
    );
    return { port: server.port, heads, connections: server.connections, received: everything };
  }

  return { addCleanup, cleanup, startTcpServer, startEchoServer, startGateway, rawRequest, startOrigin, startFakeHttpProxy };
}
