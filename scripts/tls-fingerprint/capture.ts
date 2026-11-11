import { createServer, type Socket } from 'node:net';
import { type ClientHello, parseClientHello } from './client_hello.js';

export interface CaptureServer {
  port: number;
  /** 最初に接続してきたクライアントの ClientHello。timeoutMs 待っても来なければ例外 */
  next(timeoutMs?: number): Promise<ClientHello>;
  close(): Promise<void>;
}

/**
 * ClientHello だけを受け取る TCP サーバー。最初の TLS レコードを読んで解析し、すぐ接続を切る（ハンドシェイクは続けない）。
 * 外部の通信は無い。クライアントは接続に失敗するが、それが狙い。
 * IPv4 と IPv6 の両方で受ける（localhost がどちらに解決されても届くように）。
 */
export async function startCaptureServer(): Promise<CaptureServer> {
  const queue: ClientHello[] = [];
  const waiters: Array<(hello: ClientHello) => void> = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let received = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      let hello: ClientHello | null;
      try {
        hello = parseClientHello(received);
      } catch {
        socket.destroy();
        return;
      }
      if (!hello) return;
      socket.destroy();
      const waiter = waiters.shift();
      if (waiter) waiter(hello);
      else queue.push(hello);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '::', ipv6Only: false }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('capture server has no port');

  return {
    port: address.port,
    next(timeoutMs = 15_000) {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<ClientHello>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onHello);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`no ClientHello within ${timeoutMs}ms`));
        }, timeoutMs);
        const onHello = (hello: ClientHello) => {
          clearTimeout(timer);
          resolve(hello);
        };
        waiters.push(onHello);
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
