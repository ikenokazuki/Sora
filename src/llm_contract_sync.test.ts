import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import {
  createMcpServer,
  SORA_MCP_INSTRUCTIONS,
} from './mcp.js';
import {
  SearchWebQuerySchema,
  IntegratedSearchRequestSchema,
  HighlightAlgorithmSchema,
  DEFAULT_HIGHLIGHT_ALGORITHM,
  HIGHLIGHT_ALGORITHMS,
  generateOpenApiDocument,
} from './types.js';
import { SEARCH_WEB_INPUT_SHAPE } from './search_web_formats.js';

describe('Sora v2.23.0 LLM Contract Synchronization', () => {
  describe('A. search_web contract parity', () => {
    it('SEARCH_WEB_INPUT_SHAPE and SearchWebQuerySchema must have canonical contract fields', () => {
      // Runtime shape
      const shape = SEARCH_WEB_INPUT_SHAPE;
      expect(shape.query).toBeDefined();
      expect(shape.includeDomains).toBeDefined();
      expect(shape.excludeDomains).toBeDefined();
      expect(shape.updated).toBeDefined();
      expect(shape.formats).toBeDefined();
      expect(shape.limit).toBeDefined();
      expect(shape.maxChars).toBeDefined();
      expect(shape.onlyMainContent).toBeDefined();
      expect(shape.noCache).toBeDefined();

      // OpenApi query schema must match
      const openApiShape = SearchWebQuerySchema.shape as Record<string, z.ZodTypeAny>;
      expect(openApiShape.query).toBeDefined();
      expect(openApiShape.includeDomains).toBeDefined();
      expect(openApiShape.excludeDomains).toBeDefined();
      expect(openApiShape.updated).toBeDefined();
      expect(openApiShape.formats).toBeDefined();
      expect(openApiShape.limit).toBeDefined();
      expect(openApiShape.maxChars).toBeDefined();
      expect(openApiShape.onlyMainContent).toBeDefined();
      expect(openApiShape.noCache).toBeDefined();

      // Forbidden stale fields
      expect((openApiShape as any).page).toBeUndefined();
    });

    it('updated parameter accepts all, day, week, year and rejects month', () => {
      const openApiUpdated = SearchWebQuerySchema.shape.updated as z.ZodTypeAny;
      expect(openApiUpdated.safeParse('all').success).toBe(true);
      expect(openApiUpdated.safeParse('day').success).toBe(true);
      expect(openApiUpdated.safeParse('week').success).toBe(true);
      expect(openApiUpdated.safeParse('year').success).toBe(true);
      expect(openApiUpdated.safeParse('month').success).toBe(false);
    });

    it('limit parameter has maximum 20', () => {
      const limitSchema = SearchWebQuerySchema.shape.limit as z.ZodTypeAny;
      expect(limitSchema.safeParse(20).success).toBe(true);
      expect(limitSchema.safeParse(21).success).toBe(false);
    });

    it('OpenAPI spec contains formats, maxChars, onlyMainContent and omits page for /search/web', () => {
      const spec = generateOpenApiDocument();
      const webPost = spec.paths?.['/search/web']?.post;
      expect(webPost).toBeDefined();
      const schema = webPost?.requestBody?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      const properties = schema?.properties || {};
      expect(properties.formats).toBeDefined();
      expect(properties.maxChars).toBeDefined();
      expect(properties.onlyMainContent).toBeDefined();
      expect(properties.page).toBeUndefined();
      expect(properties.limit?.maximum).toBe(20);
    });
  });

  describe('B. search_deep / integrated search parity', () => {
    it('IntegratedSearchRequestSchema matches full runtime integrated search contract', () => {
      const shape = IntegratedSearchRequestSchema.shape as Record<string, z.ZodTypeAny>;
      const requiredFields = [
        'query',
        'limit',
        'scrapeContent',
        'includeRealtime',
        'realtimeSort',
        'officialAccountId',
        'maxChars',
        'noCache',
        'includeDomains',
        'excludeDomains',
        'updated',
        'extractHighlights',
        'onlyMainContent',
        'formats',
        'dedup',
        'reorderUFlat',
        'enablePrf',
        'diversityWeight',
        'annotateTemporal',
        'minimizeTables',
        'highlightAlgorithm',
        'highlightOverheadTokens',
        'highlightMaxCount',
        'verbose',
        'responseMode',
      ];

      for (const field of requiredFields) {
        expect(shape[field]).toBeDefined();
      }

      // Forbidden stale fields
      expect((shape as any).fetchContent).toBeUndefined();
      expect((shape as any).maxCharsPerResult).toBeUndefined();
    });

    it('MCP search_deep includes updated and noCache in schema', () => {
      const server = createMcpServer({ deferTools: false });
      const searchDeep = (server as any)._registeredTools['search_deep'];
      expect(searchDeep).toBeDefined();
      const schema = searchDeep.inputSchema?.shape || searchDeep.inputSchema || searchDeep.schema;
      expect(schema.updated).toBeDefined();
      expect(schema.noCache).toBeDefined();
      expect(schema.responseMode).toBeDefined();
      expect(schema.formats).toBeDefined();
      expect(schema.scrapeContent).toBeDefined();
      expect(schema.maxChars).toBeDefined();
    });

    it('OpenAPI spec for /search includes responseMode, formats, scrapeContent and excludes fetchContent', () => {
      const spec = generateOpenApiDocument();
      const searchPost = spec.paths?.['/search']?.post;
      expect(searchPost).toBeDefined();
      const schema = searchPost?.requestBody?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      const properties = schema?.properties || {};
      expect(properties.scrapeContent).toBeDefined();
      expect(properties.maxChars).toBeDefined();
      expect(properties.responseMode).toBeDefined();
      expect(properties.formats).toBeDefined();
      expect(properties.fetchContent).toBeUndefined();
      expect(properties.maxCharsPerResult).toBeUndefined();
    });
  });

  describe('C. highlightAlgorithm parity', () => {
    it('shared HIGHLIGHT_ALGORITHMS contains rho-select-v2 and default is rho-select-v2', () => {
      expect(HIGHLIGHT_ALGORITHMS).toContain('rho-select-v2');
      expect(DEFAULT_HIGHLIGHT_ALGORITHM).toBe('rho-select-v2');
      expect(HighlightAlgorithmSchema.safeParse('rho-select-v2').success).toBe(true);
    });

    it('MCP scrape, scrape_batch, search_deep, crawl_site include rho-select-v2 in schema', () => {
      const server = createMcpServer({ deferTools: false });
      const tools = ['scrape', 'scrape_batch', 'search_deep', 'crawl_site'];

      for (const toolName of tools) {
        const tool = (server as any)._registeredTools[toolName];
        expect(tool).toBeDefined();
        const schema = tool.inputSchema?.shape || tool.inputSchema || tool.schema;
        const hlSchema = schema.highlightAlgorithm;
        expect(hlSchema).toBeDefined();
        expect(hlSchema.safeParse('rho-select-v2').success).toBe(true);
        expect(hlSchema.safeParse('rho-select').success).toBe(true);
        expect(hlSchema.safeParse('rho-bm25').success).toBe(true);
        expect(hlSchema.safeParse('legacy').success).toBe(true);
      }
    });
  });

  describe('D. deferred tool discovery', () => {
    it('initial tools/list with deferTools:true has exactly 12 core tools', () => {
      const server = createMcpServer({ deferTools: true });
      const registered = (server as any)._registeredTools;
      const enabledTools = Object.entries(registered)
        .filter(([_, handle]: [string, any]) => handle.enabled !== false)
        .map(([name]) => name);

      expect(enabledTools.length).toBe(12);
      const expectedCore = [
        'scrape',
        'search_web',
        'search_deep',
        'search_tools',
        'check_product_compliance',
        'get_weather',
        'search_route',
        'search_chiebukuro',
        'search_realtime',
        'search_disaster_warnings',
        'search_earthquake',
        'search_laws',
      ];
      for (const name of expectedCore) {
        expect(enabledTools).toContain(name);
      }
      expect(enabledTools).not.toContain('track_package');
    });

    it('search_tools enables deferred tools like track_package', async () => {
      const server = createMcpServer({ deferTools: true });
      const searchTools = (server as any)._registeredTools['search_tools'];
      expect(searchTools).toBeDefined();

      const result = await searchTools.handler({ query: '荷物追跡' });
      expect(result.content?.[0]?.text).toContain('track_package');

      const registered = (server as any)._registeredTools;
      expect(registered['track_package'].enabled).toBe(true);
    });
  });

  describe('E. SORA_MCP_INSTRUCTIONS and tool descriptions', () => {
    it('instructions contain dynamic tool discovery protocol', () => {
      expect(SORA_MCP_INSTRUCTIONS).toContain('Dynamic Tool Discovery');
      expect(SORA_MCP_INSTRUCTIONS).toContain('search_tools');
    });

    it('instructions clarify visible tools should be called directly', () => {
      expect(SORA_MCP_INSTRUCTIONS).toMatch(/visible.*directly|表示されている.*直接/i);
    });

    it('instructions document search_web formats and search_deep responseMode', () => {
      expect(SORA_MCP_INSTRUCTIONS).toContain('formats');
      expect(SORA_MCP_INSTRUCTIONS).toContain('responseMode');
      expect(SORA_MCP_INSTRUCTIONS).toContain('evidence');
      expect(SORA_MCP_INSTRUCTIONS).toContain('full');
    });

    it('search_tools description does not instruct to search already visible core tools', () => {
      const server = createMcpServer({ deferTools: true });
      const searchToolsDesc = (server as any)._registeredTools['search_tools'].description;
      expect(searchToolsDesc).not.toContain('専門機能を利用する際は、まずこのツールで対象ツールを検索してください');
      expect(searchToolsDesc).toMatch(/表示されていない|追加ツール/);
    });

    it('search_deep description focuses on WHAT and does not contain search_tools meta-guidance', () => {
      const server = createMcpServer({ deferTools: true });
      const searchDeepDesc = (server as any)._registeredTools['search_deep'].description;
      expect(searchDeepDesc).not.toContain('まず search_tools で専用ツールを検索');
      expect(searchDeepDesc).toContain('responseMode');
    });

    it('instructions contain tool overlap boundaries and token efficiency guidelines', () => {
      expect(SORA_MCP_INSTRUCTIONS).toContain('Web Tool Overlap & Primary Boundaries');
      expect(SORA_MCP_INSTRUCTIONS).toContain('search_web');
      expect(SORA_MCP_INSTRUCTIONS).toContain('search_deep');
      expect(SORA_MCP_INSTRUCTIONS).toContain('scrape');
      expect(SORA_MCP_INSTRUCTIONS).toContain('crawl_site');
      expect(SORA_MCP_INSTRUCTIONS).toContain('browser_action');
      expect(SORA_MCP_INSTRUCTIONS).toContain('Token Efficiency');
    });
  });

  describe('F. Progressive disclosure & E2E tool-list refresh', () => {
    it('initial tools/list budget is bounded to exactly 12 core tools and measured character limits', () => {
      const server = createMcpServer({ deferTools: true });
      const registered = (server as any)._registeredTools;
      const initialTools = Object.entries(registered)
        .filter(([_, t]: [string, any]) => t.enabled)
        .map(([name, t]: [string, any]) => ({
          name,
          descLength: t.description?.length || 0,
        }));

      expect(initialTools.length).toBe(12);
      const totalDescChars = initialTools.reduce((acc, t) => acc + t.descLength, 0);
      expect(totalDescChars).toBeLessThan(3500);
      for (const t of initialTools) {
        expect(t.descLength).toBeLessThan(400);
      }
    });

    it('E2E: client receives list_changed notification and can immediately invoke newly activated tool', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');

      const server = createMcpServer({ deferTools: true });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      let listChangedCount = 0;
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        listChangedCount++;
      });

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      // 1. Initial list has 12 tools
      const initialTools = await client.listTools();
      expect(initialTools.tools.length).toBe(12);
      expect(initialTools.tools.some((t: any) => t.name === 'track_package')).toBe(false);

      // 2. Discover and activate track_package
      const searchResult = await client.callTool({ name: 'search_tools', arguments: { query: '荷物追跡' } });
      expect((searchResult.content as any)[0].text).toContain('track_package');
      expect((searchResult.content as any)[0].text).toContain('有効化完了');

      // 3. Client received standard MCP notification
      expect(listChangedCount).toBe(1);

      // 4. Refreshed tools/list now includes track_package
      const refreshedTools = await client.listTools();
      expect(refreshedTools.tools.length).toBe(13);
      expect(refreshedTools.tools.some((t: any) => t.name === 'track_package')).toBe(true);

      // 5. Invoke the newly activated tool directly
      const trackResult = await client.callTool({
        name: 'track_package',
        arguments: { trackingNumber: '123456789012' },
      });
      expect(trackResult.isError ?? false).toBe(false);

      await client.close();
      await server.close();
    });
  });

  describe('G. Module gating integrity', () => {
    it('disabled modules are never registered and cannot be activated by search_tools', async () => {
      // Only enable 'life' module
      const server = createMcpServer({ deferTools: true, modules: ['life'] });
      const registered = (server as any)._registeredTools;

      // music module tools must not exist at all in registered tools
      expect(registered['search_song']).toBeUndefined();
      expect(registered['search_artist']).toBeUndefined();

      // search_tools should not be able to find music tools
      const searchTools = registered['search_tools'];
      expect(searchTools).toBeDefined();

      const searchResult = await searchTools.handler({ query: '音楽' });
      const text = searchResult.content?.[0]?.text;
      expect(text).toContain('一致する追加ツールは見つかりませんでした');
      expect(text).toMatch(/無効化|利用不可/);
    });
  });

  describe('H. Natural language discovery quality and lightweight output', () => {
    it('deferred tools are discoverable by natural language terms and bidirectional containment', async () => {
      const server = createMcpServer({ deferTools: true });
      const searchTools = (server as any)._registeredTools['search_tools'];

      // natural language tracking
      const resTracking = await searchTools.handler({ query: 'ヤマトの追跡' });
      expect(resTracking.content?.[0]?.text).toContain('track_package');

      // natural language music
      const resSong = await searchTools.handler({ query: '曲の検索' });
      expect(resSong.content?.[0]?.text).toContain('search_song');

      // natural language artist
      const resArtist = await searchTools.handler({ query: '歌手' });
      expect(resArtist.content?.[0]?.text).toContain('search_artist');
    });

    it('search_tools output is lightweight without full schema dumping', async () => {
      const server = createMcpServer({ deferTools: true });
      const searchTools = (server as any)._registeredTools['search_tools'];

      const result = await searchTools.handler({ query: '荷物追跡' });
      const text = result.content?.[0]?.text;

      // Must have tool name and summary
      expect(text).toContain('track_package');
      expect(text).toContain('有効化完了');

      // Must NOT dump full json-schema properties
      expect(text).not.toContain('"properties"');
      expect(text).not.toContain('"required"');
      expect(text).not.toContain('"type": "string"');
    });
  });

  describe('I. Tool overlap boundaries in descriptions', () => {
    it('verifies critical distinction phrases in web and browser tool descriptions', () => {
      const server = createMcpServer({ deferTools: false });
      const registered = (server as any)._registeredTools;

      expect(registered['search_web'].description).toMatch(/URL\/スニペット探索/);
      expect(registered['search_deep'].description).toMatch(/Web\+X統合深層調査|深層エビデンス駆動リランキング/);
      expect(registered['scrape'].description).toMatch(/既知URLの精読・本文抽出/);
      expect(registered['crawl_site'].description).toMatch(/同一サイトの複数ページ巡回/);
      expect(registered['browser_action'].description).toMatch(/対話・動的操作・レンダリングが必須/);
    });
  });
});
