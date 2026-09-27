import { describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { readBodyWithLimit, safeFetch } from './safe_transport.js';
import { resetSecurityMetrics, getSecurityMetrics } from '../security/metrics.js';

function chunkedResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  });
  return new Response(stream, { headers: {} });
}

describe('safe_transport (P0-SEC-03/04)', () => {
  test('readBodyWithLimit aborts oversized chunked bodies', async () => {
    resetSecurityMetrics();
    const big = new Uint8Array(100);
    await expect(readBodyWithLimit(chunkedResponse([big, big]), 150)).rejects.toThrow();
    expect(getSecurityMetrics()['sora_response_size_abort_total'] ?? 0).toBeGreaterThanOrEqual(1);
    const ok = await readBodyWithLimit(chunkedResponse([big]), 150);
    expect(ok.byteLength).toBe(100);
  });
  test('safeFetch revalidates redirect targets and strips cross-origin auth', async () => {
    const seen: Record<string, string | undefined> = {};
    const serverB: Server = createServer((req: any, res: any) => {
      seen.auth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
    });
    await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', () => r()));
    const portB = (serverB.address() as AddressInfo).port;
    const serverA: Server = createServer((req: any, res: any) => {
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/x` });
      res.end();
    });
    await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', () => r()));
    const portA = (serverA.address() as AddressInfo).port;
    try {
      const r = await safeFetch(`http://127.0.0.1:${portA}/go`, {
        headers: { Authorization: 'Bearer s3cr3t', 'X-Keep': 'yes' },
        validate: () => {},
      });
      expect(r.finalUrl).toContain(String(portB));
      expect(seen.auth).toBeUndefined();
      const body = new TextDecoder().decode(r.body);
      expect(body).toBe('landed');
    } finally {
      serverA.close(); serverB.close();
    }
  });
  test('safeFetch rejects redirect to unvalidated target', async () => {
    const server: Server = createServer((req: any, res: any) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/go`, {
        validate: (u: URL) => {
          if (u.hostname === '169.254.169.254') throw new Error('blocked');
        },
      })).rejects.toThrow('blocked');
    } finally {
      server.close();
    }
  });
});
