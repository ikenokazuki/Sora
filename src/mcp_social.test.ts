import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb } from './db.js';
import { createMcpServer } from './mcp.js';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'mcp-social-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('social mcp tools', () => {
  test('search_social_posts and fetch_social_post are listed and discoverable', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['web', 'yahoo'], deferTools: false });
    const client = new Client({ name: 'social-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t: any) => t.name);
      expect(names).toContain('search_social_posts');
      expect(names).toContain('fetch_social_post');
      expect(names).toContain('search_realtime');
      const search = tools.tools.find((t: any) => t.name === 'search_social_posts') as any;
      expect(search.inputSchema.properties.platform.enum).toEqual(['weibo', 'threads', 'instagram', 'facebook']);
      expect(search.inputSchema.properties.platform.enum).not.toContain('x');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: 'Weibo 投稿' } });
      expect(JSON.stringify(found)).toContain('search_social_posts');
    } finally {
      await client.close();
      await server.close();
    }
  });
  test('unsupported urls fail without network use', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['web'], deferTools: false });
    const client = new Client({ name: 'social-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name: 'fetch_social_post', arguments: { url: 'https://example.org/article', commentLimit: 0 } })) as any;
      const text = result.content.find((c: any) => c.type === 'text')?.text ?? '';
      expect(text).toContain('unavailable');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
