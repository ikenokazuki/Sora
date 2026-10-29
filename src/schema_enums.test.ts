import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import { ChiebukuroSearchRequestSchema, EarthquakeRequestSchema, generateOpenApiDocument } from './types.js';

describe('enumerated inputs', () => {
  test('MCP tool schemas use string enums only (Gemini rejects other enum values)', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'schema-enums', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      const bad: string[] = [];
      const walk = (s: any, path: string) => {
        if (!s || typeof s !== 'object') return;
        if (Array.isArray(s.enum) && s.enum.some((v: unknown) => typeof v !== 'string')) bad.push(path);
        for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${path}.${k}`);
        if (s.items) walk(s.items, `${path}[]`);
        for (const v of s.anyOf ?? []) walk(v, path);
      };
      for (const t of tools) walk(t.inputSchema, t.name);
      expect(bad).toEqual([]);
      const eq = await client.callTool({ name: 'search_earthquake', arguments: { minIntensity: 35 } });
      expect(eq.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('minIntensity accepts JMA scale codes only', () => {
    for (const code of [10, 20, 30, 40, 45, 50, 55, 60, 70]) expect(EarthquakeRequestSchema.safeParse({ minIntensity: code }).success).toBe(true);
    expect(EarthquakeRequestSchema.safeParse({ minIntensity: 35 }).success).toBe(false);
  });

  test('chiebukuro status is documented', () => {
    expect(ChiebukuroSearchRequestSchema.parse({ query: 'x', status: 'solved' }).status).toBe('solved');
    expect(ChiebukuroSearchRequestSchema.safeParse({ query: 'x', status: 'closed' }).success).toBe(false);
  });

  test('GET /tracking/{carrier}/{number} lists every carrier', () => {
    const doc: any = generateOpenApiDocument();
    const carrier = doc.paths['/tracking/{carrier}/{number}'].get.parameters.find((p: any) => p.name === 'carrier');
    expect([...carrier.schema.enum].sort()).toEqual(['auto', 'dhl', 'fedex', 'fukutsu', 'japanpost', 'sagawa', 'seino', 'ups', 'yamato']);
  });
});
