import { describe, expect, test, afterEach } from 'bun:test';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { fetchWithSafeRedirects } from './http_fetcher.js';

let prevAllow: string | undefined;
function allowLocal(on: boolean) {
  if (on) { prevAllow = process.env.ALLOW_LOCAL_FETCH; process.env.ALLOW_LOCAL_FETCH = 'true'; }
  else { if (prevAllow !== undefined) process.env.ALLOW_LOCAL_FETCH = prevAllow; else delete process.env.ALLOW_LOCAL_FETCH; }
}
function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('NativeFetchSession domain-scoped jar', () => {
  test('cookies never cross origins', async () => {
    const { NativeFetchSession } = await import('./http_fetcher.js');
    const seen: Record<string, string | undefined> = {};
    const { createServer } = await import('node:http');
    const mk = (tag: string, set?: string) => createServer((req: any, res: any) => {
      seen[tag] = req.headers.cookie as string | undefined;
      const h: any = { 'content-type': 'text/plain' };
      if (set) h['Set-Cookie'] = set;
      res.writeHead(200, h);
      res.end('ok');
    });
    const sA = mk('a', 'sess=A1; Path=/');
    const sB = mk('b');
    await new Promise<void>((r) => sA.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => sB.listen(0, '127.0.0.2', () => r()));
    const portA = (sA.address() as AddressInfo).port;
    const portB = (sB.address() as AddressInfo).port;
    const sess: any = new NativeFetchSession();
    try {
      await sess.fetch('http://127.0.0.1:' + portA + '/a');
      expect(seen.a).toBeUndefined();
      await sess.fetch('http://127.0.0.2:' + portB + '/b');
      expect(seen.b).toBeUndefined();
      await sess.fetch('http://127.0.0.1:' + portA + '/a2');
      expect(seen.a).toContain('sess=A1');
      const all = sess.getAllCookies();
      expect(all.length).toBe(1);
      expect(all[0].domain).toBe('127.0.0.1');
    } finally {
      sA.close();
      sB.close();
    }
  });
});
describe('fetchWithSafeRedirects auth stripping', () => {
  afterEach(() => { allowLocal(false); });
  test('strips authorization on origin change, keeps it same-origin', async () => {
    allowLocal(true);
    const seenB: Record<string, string | undefined> = {};
    const { server: serverB, port: portB } = await listen();
    serverB.on('request', (req: IncomingMessage, res: ServerResponse) => {
      seenB.authorization = req.headers.authorization as string | undefined;
      seenB.xcustom = req.headers['x-custom'] as string | undefined;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok-b');
    });
    const seenA2: Record<string, string | undefined> = {};
    const { server: serverA, port: portA } = await listen();
    serverA.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/go-cross') {
        res.writeHead(302, { location: `http://127.0.0.1:${portB}/landed` });
        res.end();
        return;
      }
      if (req.url === '/go-same') {
        res.writeHead(302, { location: `http://127.0.0.1:${portA}/landed-same` });
        res.end();
        return;
      }
      if (req.url === '/landed-same') {
        seenA2.authorization = req.headers.authorization as string | undefined;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok-a');
        return;
      }
      res.writeHead(404); res.end();
    });
    try {
      await fetchWithSafeRedirects(`http://127.0.0.1:${portA}/go-cross`, 10000, 5, {
        Authorization: 'Bearer secret',
        'X-Custom': 'keep-me',
      });
      expect(seenB.authorization).toBeUndefined();
      expect(seenB.xcustom).toBe('keep-me');
      await fetchWithSafeRedirects(`http://127.0.0.1:${portA}/go-same`, 10000, 5, {
        Authorization: 'Bearer secret',
      });
      expect(seenA2.authorization).toBe('Bearer secret');
    } finally {
      serverA.close();
      serverB.close();
    }
  });
});
