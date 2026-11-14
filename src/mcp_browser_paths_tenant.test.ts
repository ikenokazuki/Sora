import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as songRecognition from './services/song_recognition.js';
import * as tracking from './services/tracking/index.js';

/**
 * 荷物追跡（track_package）と楽曲認識（recognize_song）の MCP ツールが、サーバーの利用者（tenant）を、ブラウザの枠まで渡す（設計 6。穴 22・25）。
 * 以前は、利用者を渡さず、全員が legacy の 1 人として数えられた。SNS（search_social_posts・fetch_social_post）は social_tenant_wiring.test.ts。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function withClient<T>(fn: (client: Client) => Promise<T>, tenantId = 'name:alice'): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer({ deferTools: false, modules: ['all', 'shazam'], sessionState: { activatedTools: new Set(), tenantId } });
  const client = new Client({ name: 'browser-paths-tenant', version: '1.0.0' });
  await mcp.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe('MCP のツールは、サーバーの利用者を渡す', () => {
  test('track_package', async () => {
    const spy = spyOn(tracking, 'trackPackage').mockResolvedValue({ carrier: 'ups', carrierName: 'UPS', trackingNumber: '1Z999AA10123456784', status: 'unknown', statusText: 'x', events: [], trackingUrl: 'https://www.ups.com/' } as never);
    spies.push(spy);
    await withClient((client) => client.callTool({ name: 'track_package', arguments: { trackingNumber: '1Z999AA10123456784', carrier: 'ups' } }));
    expect(spy.mock.calls[0][1]).toEqual({ tenantId: 'name:alice' });
  });

  test('recognize_song', async () => {
    const spy = spyOn(songRecognition, 'recognizeSong').mockResolvedValue({ found: false, reason: 'no-match', message: 'x', itunes: null, itunesMatch: null, attempts: [] } as never);
    spies.push(spy);
    await withClient((client) => client.callTool({ name: 'recognize_song', arguments: { url: 'https://example.com/a.mp3' } }));
    expect(spy.mock.calls[0][0]).toMatchObject({ url: 'https://example.com/a.mp3', tenantId: 'name:alice' });
  });

  test('利用者の決まっていないサーバー（stdio など）は legacy', async () => {
    const spy = spyOn(tracking, 'trackPackage').mockResolvedValue({ carrier: 'ups', carrierName: 'UPS', trackingNumber: '1Z999AA10123456784', status: 'unknown', statusText: 'x', events: [], trackingUrl: 'https://www.ups.com/' } as never);
    spies.push(spy);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'browser-paths-legacy', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'track_package', arguments: { trackingNumber: '1Z999AA10123456784', carrier: 'ups' } });
    } finally {
      await client.close();
      await mcp.close();
    }
    expect(spy.mock.calls[0][1]).toEqual({ tenantId: 'legacy' });
  });
});
