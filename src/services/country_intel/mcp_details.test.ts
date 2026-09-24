import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb } from '../../db.js';
import { createMcpServer } from '../../mcp.js';
import { normalizeEvidence } from './evidence.js';
import { researchCountryContext } from './report.js';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-mcp-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('intel mcp details', () => {
  test('MCP text and structured result expose the same evidence', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      modules: ['intel'],
      deferTools: false,
      intelResearch: ((request: any) => researchCountryContext(request, {
        cache: null,
        providers: [{
          id: 'fixture', areas: ['current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
          async run(input) {
            const evidence = normalizeEvidence({ url: 'https://example.org/notice', title: 'An official update', excerpt: 'Opening times have changed.', sourceType: 'official', primarySource: true, latencyClass: 'near_realtime' }, input.region, new Date('2026-09-22T00:00:00Z'));
            return { items: [{ evidence, detail: { evidenceId: evidence.id, providerId: 'fixture', providerItemId: '1', sourceRecordUrl: 'https://example.org/notice', contentKind: 'excerpt', blocks: [{ index: 0, text: 'Opening times have changed.' }], retrievedAt: '2026-09-22T00:00:00.000Z', timeBasis: 'retrieved', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false } }], coverage: ['current_events'] };
          },
        }],
      })) as never,
    });
    const client = new Client({ name: 'intel-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name: 'research_country_context', arguments: { region: 'CN' } })) as unknown as { content: { type: string; text: string }[]; structuredContent: { contextId: string; evidence: unknown[] } };
      const text = result.content.find((item) => item.type === 'text');
      expect(JSON.parse(text!.text)).toEqual(result.structuredContent);
      expect(result.structuredContent.evidence.length).toBeGreaterThan(0);
      const contextId = result.structuredContent.contextId;
      const resources = await client.listResources();
      expect(resources.resources.map((item: any) => item.uri)).toContain('sora-skill://sora-deep-research');
      const skill = await client.readResource({ uri: 'sora-skill://sora-deep-research' });
      const skillText = (skill.contents[0] as any)?.text ?? '';
      expect(skillText).toContain('sora-deep-research');
      const page = (await client.callTool({ name: 'get_country_context_evidence', arguments: { contextId, limit: 10 } })) as unknown as { structuredContent: { items: unknown[]; totalStored: number } };
      expect(page.structuredContent.totalStored).toBe(1);
      expect(page.structuredContent.items).toHaveLength(1);
      const snapshot = (await client.callTool({ name: 'get_country_context', arguments: { contextId } })) as unknown as { structuredContent: { contextId: string } };
      expect(snapshot.structuredContent.contextId).toBe(contextId);
      const updates = (await client.callTool({ name: 'get_country_context_updates', arguments: { contextId } })) as unknown as { structuredContent: { changes: unknown[] } };
      expect(updates.structuredContent.changes).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
