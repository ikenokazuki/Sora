import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp.js';
import {
  CANONICAL_TOOLS, PROVIDER_CASES, REST_MAP, TOOL_CASES, snapshotDependencies,
} from './catalog.js';

async function canonicalNames(): Promise<string[]> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'catalog-check', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    const tools = await client.listTools();
    return tools.tools.map((t: any) => t.name).filter((n: string) => !n.startsWith('default.')).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tool-health catalog consistency', () => {
  test('canonical ledger matches the registered set', async () => {
    const ledger = [...CANONICAL_TOOLS].sort();
    expect(new Set(ledger).size).toBe(ledger.length);
    expect(await canonicalNames()).toEqual(ledger);
  });
  test('every canonical tool has a live case and vice versa', () => {
    const covered = new Set(TOOL_CASES.flatMap((c) => c.toolNames));
    for (const name of CANONICAL_TOOLS) {
      expect(covered.has(name)).toBe(true);
    }
    for (const name of covered) {
      expect(CANONICAL_TOOLS).toContain(name);
    }
  });
  test('dependency ledger matches live registries by name', () => {
    const snap = snapshotDependencies();
    expect(snap.carriers.sort()).toEqual(['dhl', 'fedex', 'fukutsu', 'japanpost', 'sagawa', 'seino', 'ups', 'yamato']);
    expect(snap.platforms.sort()).toEqual(['facebook', 'instagram', 'threads', 'weibo']);
    expect(snap.providers).toContain('gdelt_export');
    expect(snap.providers).toContain('social_posts');
    expect(snap.providers).toContain('wikidata');
    expect(snap.providers.length).toBe(24);
    expect(snap.feeds.length).toBe(13);
    expect(snap.fediverse).toEqual(['https://misskey.io', 'https://mstdn.jp', 'https://fedibird.com', 'https://mastodon.xyz']);
    expect(snap.worldbank.length).toBe(6);
  });
  test('provider cases cover every provider, feed, fediverse host, and indicator', () => {
    const snap = snapshotDependencies();
    const depIds = new Set(PROVIDER_CASES.flatMap((c) => c.dependencyIds));
    for (const p of snap.providers) {
      if (p === 'fediverse') {
        expect(snap.fediverse.every((h) => depIds.has('fediverse:' + h))).toBe(true);
        continue;
      }
      if (p === 'global_feeds') {
        expect(snap.feeds.every((f) => depIds.has('feed:' + f))).toBe(true);
        continue;
      }
      expect(depIds.has(p)).toBe(true);
    }
    for (const f of snap.feeds) expect(depIds.has('feed:' + f)).toBe(true);
    for (const h of snap.fediverse) expect(depIds.has('fediverse:' + h)).toBe(true);
    for (const w of snap.worldbank) expect(depIds.has('worldbank:' + w)).toBe(true);
  });
  test('REST map covers every canonical tool exactly once', () => {
    expect(new Set(Object.keys(REST_MAP)).size).toBe(CANONICAL_TOOLS.length);
    for (const name of CANONICAL_TOOLS) expect(name in REST_MAP).toBe(true);
    expect(REST_MAP['search_tools']).toBeNull();
  });
});
