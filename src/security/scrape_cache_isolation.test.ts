import { describe, expect, test, afterEach } from 'bun:test';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { scrapeUrl } from '../scraper.js';
import { clearCache } from '../cache.js';

let prevAllow: string | undefined;

describe('scrape shared-cache isolation (P0-SEC-01)', () => {
  afterEach(() => {
    if (prevAllow !== undefined) process.env.ALLOW_LOCAL_FETCH = prevAllow;
    else delete process.env.ALLOW_LOCAL_FETCH;
    clearCache();
  });
  test('authenticated scrapes bypass shared cache on read and write', async () => {
    prevAllow = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    let hits = 0;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>t</title></head><body><p>hello world content here</p></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/page`;
    try {
      // Authenticated: two identical requests must both hit origin (no read, no write).
      await scrapeUrl({ url, headers: { Authorization: 'Bearer A' }, mode: 'fast', formats: ['markdown'] });
      await scrapeUrl({ url, headers: { Authorization: 'Bearer A' }, mode: 'fast', formats: ['markdown'] });
      expect(hits).toBe(2);
      // Different credential must not receive the other tenant result.
      await scrapeUrl({ url, headers: { Authorization: 'Bearer B' }, mode: 'fast', formats: ['markdown'] });
      expect(hits).toBe(3);
      // Unauthenticated requests still share cache.
      await scrapeUrl({ url, mode: 'fast', formats: ['markdown'] });
      await scrapeUrl({ url, mode: 'fast', formats: ['markdown'] });
      expect(hits).toBe(4);
    } finally {
      server.close();
    }
  });
});
