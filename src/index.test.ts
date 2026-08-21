import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { app } from './index.js';
import { createAuthMiddleware } from './auth.js';
import { createMcpServer, createMcpTransport } from './mcp.js';
import { isBlockedHostname, convertHtmlToMarkdown } from './scraper.js';

describe('web-fetcher Core Functions', () => {
  it('isBlockedHostname should block local and private IPs/hostnames', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('10.0.0.1')).toBe(true);
    expect(isBlockedHostname('192.168.1.1')).toBe(true);
    expect(isBlockedHostname('172.16.0.1')).toBe(true);
    expect(isBlockedHostname('169.254.169.254')).toBe(true);
    expect(isBlockedHostname('::1')).toBe(true);
    expect(isBlockedHostname('service.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('yahoo.co.jp')).toBe(false);
  });

  it('convertHtmlToMarkdown should extract title, ogImage, and markdown body', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta property="og:title" content="Test Page OG" />
          <meta property="og:image" content="https://example.com/image.jpg" />
          <meta name="description" content="A test page description" />
        </head>
        <body>
          <header>Header content</header>
          <main>
            <h1>Article Title</h1>
            <p>This is the main article content.</p>
          </main>
          <footer>Footer content</footer>
        </body>
      </html>
    `;
    const result = convertHtmlToMarkdown(sampleHtml, 'https://example.com/article', 10000);
    expect(result.title).toBe('Test Page');
    expect(result.ogImage).toBe('https://example.com/image.jpg');
    expect(result.description).toBe('A test page description');
    expect(result.markdown).toContain('Article Title');
    expect(result.markdown).toContain('This is the main article content');
    expect(result.markdown).not.toContain('Header content');
    expect(result.markdown).not.toContain('Footer content');
  });
});

describe('web-fetcher Auth Middleware', () => {
  const testApp = new Hono();
  testApp.use('*', createAuthMiddleware('secret-test-key'));
  testApp.get('/health', (c) => c.json({ status: 'ok' }));
  testApp.get('/protected', (c) => c.json({ status: 'authenticated' }));

  it('should allow /health without auth', async () => {
    const res = await testApp.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
  });

  it('should allow direct local access (no proxy headers)', async () => {
    const res = await testApp.fetch(new Request('http://localhost/protected'));
    expect(res.status).toBe(200);
  });

  it('should reject proxied request without API key', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(401);
  });

  it('should allow proxied request with valid Bearer token', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
        authorization: 'Bearer secret-test-key',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('authenticated');
  });

  it('should allow proxied request with valid X-API-Key header', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'x-forwarded-for': '203.0.113.195',
        'x-api-key': 'secret-test-key',
      },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('authenticated');
  });
});

describe('web-fetcher REST & MCP Endpoints', () => {
  it('GET /health should return 200 OK with service details', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.service).toBe('web-fetcher');
    expect(data.status).toBe('ok');
  });

  it('POST /scrape should return 400 when url is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /mcp should respond to JSON-RPC tools/list', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result).toBeDefined();
    expect(Array.isArray(body.result.tools)).toBe(true);

    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('scrape');
    expect(toolNames).toContain('search_web');
    expect(toolNames).toContain('search_realtime');
    expect(toolNames).toContain('search_deep');
  });
});
