import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import {
  createMcpServer,
  buildSoraMcpInstructions,
  McpSessionManager,
  SORA_MCP_INSTRUCTIONS,
  clearSharedActivatedTools,
} from './mcp.js';
import {
  SearchWebQuerySchema,
  IntegratedSearchRequestSchema,
  INTEGRATED_SEARCH_INPUT_SHAPE,
  HighlightAlgorithmSchema,
  DEFAULT_HIGHLIGHT_ALGORITHM,
  HIGHLIGHT_ALGORITHMS,
  generateOpenApiDocument,
} from './types.js';
import { SEARCH_WEB_INPUT_SHAPE } from './search_web_formats.js';

describe('Sora v2.23.0 LLM Contract Synchronization', () => {
  beforeEach(() => {
    clearSharedActivatedTools();
  });

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

    it('deeply verifies parity of enum values, defaults, min/max, and nullability across MCP, Shared Schema, and OpenAPI', () => {
      const server = createMcpServer({ deferTools: false });
      const searchDeep = (server as any)._registeredTools['search_deep'];
      const mcpShape = searchDeep.inputSchema?.shape || searchDeep.inputSchema;
      const sharedShape = INTEGRATED_SEARCH_INPUT_SHAPE;
      const openApiSpec = generateOpenApiDocument();
      const openApiProps = openApiSpec.paths?.['/search']?.post?.requestBody?.content?.['application/json']?.schema?.properties || {};

      // 1. Single-source identity: MCP schema has identical keys and properties from shared INTEGRATED_SEARCH_INPUT_SHAPE
      expect(Object.keys(mcpShape).sort()).toEqual(Object.keys(sharedShape).sort());
      for (const key of Object.keys(sharedShape)) {
        expect(mcpShape[key]).toBeDefined();
      }

      // 2. highlightAlgorithm default & enum
      const hlDefault = typeof (sharedShape.highlightAlgorithm as any)._def.defaultValue === 'function'
        ? (sharedShape.highlightAlgorithm as any)._def.defaultValue()
        : (sharedShape.highlightAlgorithm as any)._def.defaultValue;
      expect(hlDefault).toBe('rho-select-v2');
      expect(openApiProps.highlightAlgorithm.default).toBe('rho-select-v2');
      const expectedAlgos = ['rho-select', 'rho-select-v2', 'rho-bm25', 'legacy'];
      expect(openApiProps.highlightAlgorithm.enum).toEqual(expectedAlgos);

      // 3. responseMode default & enum
      const respDefault = typeof (sharedShape.responseMode as any)._def.defaultValue === 'function'
        ? (sharedShape.responseMode as any)._def.defaultValue()
        : (sharedShape.responseMode as any)._def.defaultValue;
      expect(respDefault).toBe('full');
      expect(openApiProps.responseMode.default).toBe('full');
      expect(openApiProps.responseMode.enum).toEqual(['full', 'evidence']);

      // 4. updated enum
      const expectedUpdated = ['all', 'day', 'week', 'year'];
      expect(openApiProps.updated.enum).toEqual(expectedUpdated);

      // 5. limit min / max
      expect(openApiProps.limit.maximum).toBe(20);
      expect(openApiProps.limit.minimum).toBe(1);

      // 6. query is required; others are optional
      const openApiRequired = openApiSpec.paths?.['/search']?.post?.requestBody?.content?.['application/json']?.schema?.required || [];
      expect(openApiRequired).toContain('query');
      expect(openApiRequired).not.toContain('responseMode');
      expect(openApiRequired).not.toContain('limit');
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
    it('initial tools/list with deferTools:true has exactly 14 core tools', () => {
      const server = createMcpServer({ deferTools: true });
      const registered = (server as any)._registeredTools;
      const enabledTools = Object.entries(registered)
        .filter(([_, handle]: [string, any]) => handle.enabled !== false)
        .map(([name]) => name);

      expect(enabledTools.length).toBe(14);
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
        'search_social_posts',
        'fetch_social_post',
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
      expect(searchToolsDesc).not.toContain('search_deep 等');
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
    it('initial tools/list budget is bounded to exactly 14 core tools and measured character limits', () => {
      const server = createMcpServer({ deferTools: true });
      const registered = (server as any)._registeredTools;
      const initialTools = Object.entries(registered)
        .filter(([_, t]: [string, any]) => t.enabled)
        .map(([name, t]: [string, any]) => ({
          name,
          descLength: t.description?.length || 0,
        }));

      expect(initialTools.length).toBe(14);
      const totalDescChars = initialTools.reduce((acc, t) => acc + t.descLength, 0);
      expect(totalDescChars).toBeLessThan(3500);
      for (const t of initialTools) {
        expect(t.descLength).toBeLessThan(400);
      }
    });

    it('measures serialized initial tool definitions budget and instructions characters via MCP client', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

      const server = createMcpServer({ deferTools: true });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'budget-test-client', version: '1.0.0' }, { capabilities: {} });

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const initialTools = await client.listTools();
      expect(initialTools.tools.length).toBe(14);

      const serializedTools = JSON.stringify(initialTools.tools);
      const toolChars = serializedTools.length;
      const instructionChars = SORA_MCP_INSTRUCTIONS.length;
      const estimatedTokens = Math.ceil((toolChars + instructionChars) / 4);

      // Regression guards with healthy safety margin
      expect(toolChars).toBeLessThan(30000);
      expect(instructionChars).toBeLessThan(8500);
      expect(estimatedTokens).toBeLessThan(10000);

      await client.close();
      await server.close();
    });

    it('E2E: client receives list_changed notification and can immediately invoke newly activated tool (with mocked external network)', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input?.url;
        if (
          url &&
          (url.includes('kuronekoyamato') ||
            url.includes('sagawa') ||
            url.includes('japanpost') ||
            url.includes('seino') ||
            url.includes('fukutsu') ||
            url.includes('ups.com'))
        ) {
          return new Response('<html><body>追跡モック: 配達完了</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return origFetch(input, init);
      }) as typeof fetch;

      try {
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
        expect(initialTools.tools.length).toBe(14);
        expect(initialTools.tools.some((t: any) => t.name === 'track_package')).toBe(false);

        // 2. Discover and activate track_package
        const searchResult = await client.callTool({ name: 'search_tools', arguments: { query: '荷物追跡' } });
        expect((searchResult.content as any)[0].text).toContain('track_package');
        expect((searchResult.content as any)[0].text).toContain('有効化完了');

        // 3. Client received standard MCP notification
        expect(listChangedCount).toBeGreaterThanOrEqual(1);

        // 4. Refreshed tools/list now includes track_package
        const refreshedTools = await client.listTools();
        expect(refreshedTools.tools.length).toBe(16);
        expect(refreshedTools.tools.some((t: any) => t.name === 'default.track_package')).toBe(true);
        expect(refreshedTools.tools.some((t: any) => t.name === 'track_package')).toBe(true);

        // 5. Invoke the newly activated tool directly without external network flakiness
        const trackResult = await client.callTool({
          name: 'track_package',
          arguments: { trackingNumber: '123456789012' },
        });
        expect(trackResult.isError ?? false).toBe(false);

        await client.close();
        await server.close();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('E2E: stateful HTTP transport receives list_changed notification and refreshes tools/list', async () => {
      const manager = new McpSessionManager();
      const parseRes = async (res: Response) => {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          const line = text.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            return JSON.parse(line.replace(/^data:\s*/, ''));
          }
          return null;
        }
      };

      // 1. Initialize stateful session
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-test-client', version: '1.0' } },
        }),
      });
      const initRes = await manager.handleRequest(initReq);
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get('mcp-session-id')!;
      expect(sessionId).toBeDefined();

      // 1.5 Send initialized notification
      const notifyReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      await manager.handleRequest(notifyReq);

      // 2. Initial tools/list (should be 12 core tools)
      const listReq1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const listRes1 = await manager.handleRequest(listReq1);
      const listBody1: any = await parseRes(listRes1);
      const names1 = listBody1.result.tools.map((t: any) => t.name);
      expect(names1.length).toBe(14);
      expect(names1).toContain('scrape');
      expect(names1).toContain('search_deep');
      expect(names1).toContain('search_tools');
      expect(names1).not.toContain('track_package');

      // 2.5 Establish notification-capable SSE stream (standard MCP Streamable HTTP GET)
      const sseReq = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
      });
      const sseRes = await manager.handleRequest(sseReq);
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();

      const notificationPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.replace(/^data:\s*/, ''));
                if (parsed.method === 'notifications/tools/list_changed') {
                  return parsed;
                }
              } catch {}
            }
          }
        }
        return null;
      })();

      // 3. Call search_tools to activate track_package
      const callSearchReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: '荷物追跡' } },
        }),
      });
      const callSearchRes = await manager.handleRequest(callSearchReq);
      const searchBody: any = await parseRes(callSearchRes);
      expect(searchBody.result.content[0].text).toContain('track_package');
      expect(searchBody.result.content[0].text).toContain('有効化完了');

      // 3.5 Wait for and assert notifications/tools/list_changed received via SSE stream
      const receivedNotification = await Promise.race([
        notificationPromise,
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Notification timeout')), 3000)),
      ]);
      expect(receivedNotification).not.toBeNull();
      expect(receivedNotification.method).toBe('notifications/tools/list_changed');

      await reader.cancel();

      // 4. Refreshed tools/list includes the canonical tool and its compatibility alias.
      const listReq2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      const listRes2 = await manager.handleRequest(listReq2);
      const listBody2: any = await parseRes(listRes2);
      const names2 = listBody2.result.tools.map((t: any) => t.name);
      expect(names2.length).toBe(16);
      expect(names2).toContain('default.track_package');
      expect(names2).toContain('track_package');

      manager.clearAllSessions();
    });
  });

  describe('G. Module gating integrity & module-aware instructions', () => {
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

    it('buildSoraMcpInstructions reflects only active modules and omits disabled module tools', () => {
      // 1. Life module only
      const lifeInstructions = buildSoraMcpInstructions(['life']);
      // Included tools:
      expect(lifeInstructions).toContain('get_weather');
      expect(lifeInstructions).toContain('search_route');
      expect(lifeInstructions).toContain('get_flight_status');
      expect(lifeInstructions).toContain('track_package');
      expect(lifeInstructions).toContain("'track_package' is a deferred tool");
      expect(lifeInstructions).toContain("search_tools' with query '荷物追跡'");
      // Excluded tools:
      expect(lifeInstructions).not.toContain('search_disaster_warnings');
      expect(lifeInstructions).not.toContain('search_earthquake');
      expect(lifeInstructions).not.toContain('search_road_traffic');
      expect(lifeInstructions).not.toContain('get_elevation');
      expect(lifeInstructions).not.toContain('search_song');
      expect(lifeInstructions).not.toContain('search_artist');
      expect(lifeInstructions).not.toContain('search_laws');
      expect(lifeInstructions).not.toContain('check_product_compliance');
      expect(lifeInstructions).not.toContain('search_web');
      expect(lifeInstructions).not.toContain('search_deep');

      // 2. Disaster module only
      const disasterInstructions = buildSoraMcpInstructions(['disaster']);
      // Included tools:
      expect(disasterInstructions).toContain('search_disaster_warnings');
      expect(disasterInstructions).toContain('search_earthquake');
      expect(disasterInstructions).toContain('search_road_traffic');
      expect(disasterInstructions).toContain('get_elevation');
      // Excluded tools:
      expect(disasterInstructions).not.toContain('get_weather');
      expect(disasterInstructions).not.toContain('search_route');
      expect(disasterInstructions).not.toContain('get_flight_status');
      expect(disasterInstructions).not.toContain('track_package');
      expect(disasterInstructions).not.toContain('search_song');
      expect(disasterInstructions).not.toContain('search_laws');
      expect(disasterInstructions).not.toContain('search_web');
      expect(disasterInstructions).not.toContain('search_deep');

      // 3. All modules
      const allInstructions = buildSoraMcpInstructions(['all']);
      expect(allInstructions).toContain('search_deep');
      expect(allInstructions).toContain('search_web');
      expect(allInstructions).toContain('search_song');
      expect(allInstructions).toContain('search_laws');
      expect(allInstructions).toContain('check_product_compliance');
      expect(allInstructions).toContain('get_weather');
      expect(allInstructions).toContain('search_route');
      expect(allInstructions).toContain('get_flight_status');
      expect(allInstructions).toContain('track_package');
      expect(allInstructions).toContain('search_disaster_warnings');
      expect(allInstructions).toContain('search_earthquake');
      expect(allInstructions).toContain('search_road_traffic');
      expect(allInstructions).toContain('get_elevation');
    });

    it('disabled module discovery output reflects only active modules in available categories', async () => {
      const server = createMcpServer({ deferTools: true, modules: ['life'] });
      const searchTools = (server as any)._registeredTools['search_tools'];

      const searchResult = await searchTools.handler({ query: '音楽' });
      const text = searchResult.content?.[0]?.text;

      expect(text).toContain('現在有効なカテゴリ: life (天気/乗換/荷物追跡)');
      expect(text).not.toContain('music (楽曲/歌手)');
      expect(text).not.toContain('gov (法令)');
      expect(text).not.toContain('trade (輸出/HTS/CPSC/FDA)');
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

    it('prevents false-positive 1-character reverse containment while activating intended tools', async () => {
      const server = createMcpServer({ deferTools: true });
      const searchTools = (server as any)._registeredTools['search_tools'];

      // "歌手" must activate search_artist, but NOT search_song via 1-char "歌"
      const resArtist = await searchTools.handler({ query: '歌手' });
      const artistText = resArtist.content?.[0]?.text || '';
      expect(artistText).toContain('search_artist');
      expect(artistText).not.toContain('search_song');

      // "ヤマトの追跡" must activate track_package via 3-char "ヤマト"
      const resTracking = await searchTools.handler({ query: 'ヤマトの追跡' });
      const trackingText = resTracking.content?.[0]?.text || '';
      expect(trackingText).toContain('track_package');
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

  describe('J. Dynamic tool preservation across client re-initialization (LibreChat Re-init resilience)', () => {
    it('preserves an activated tool and its compatibility alias across HTTP re-initialization', async () => {
      const manager = new McpSessionManager();
      let id = 0;
      const rpc = async (method: string, params: object = {}, sessionId?: string) => {
        const response = await manager.handleRequest(new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        }));
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.error).toBeUndefined();
        return { result: body.result, sessionId: response.headers.get('mcp-session-id')! };
      };
      const initialize = () => rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'reconnect-regression', version: '1.0' },
      });
      try {
        const first = await initialize();
        const initial = await rpc('tools/list', {}, first.sessionId);
        expect(initial.result.tools).toHaveLength(14);
        expect(initial.result.tools.some((tool: any) => tool.name === 'track_package')).toBe(false);
        expect(initial.result.tools.some((tool: any) => tool.name === 'default.track_package')).toBe(false);

        const activation = await rpc('tools/call', {
          name: 'search_tools', arguments: { query: 'track_package' },
        }, first.sessionId);
        expect(activation.result.isError ?? false).toBe(false);
        expect(activation.result.content[0].text).toContain('track_package');

        const closed = await manager.handleRequest(new Request('http://localhost/mcp', {
          method: 'DELETE', headers: { 'mcp-session-id': first.sessionId },
        }));
        expect(closed.status).toBe(200);

        const second = await initialize();
        expect(second.sessionId).not.toBe(first.sessionId);
        const list = await rpc('tools/list', {}, second.sessionId);
        const names = list.result.tools.map((tool: any) => tool.name);
        expect(names).toContain('track_package');
        expect(names).toContain('default.track_package');
        expect(names).toHaveLength(16);

        // This tracking number has no carrier candidate, so the real handler performs no external I/O.
        const call = await rpc('tools/call', {
          name: 'default.track_package', arguments: { trackingNumber: '123', noCache: true },
        }, second.sessionId);
        expect(call.result.isError ?? false).toBe(false);
        expect(JSON.parse(call.result.content[0].text)).toMatchObject({
          trackingNumber: '123', carrier: 'unknown', status: 'not_found',
        });
      } finally {
        manager.clearAllSessions();
        clearSharedActivatedTools();
      }
    });
  });

  describe('K. Tool discovery ranking and default. prefix tolerance', () => {
    it('discovers every tool in an explicitly requested category', async () => {
      const server = createMcpServer({ modules: ['yahoo'], deferTools: true });
      const reg = (server as any)._registeredTools;
      await reg.search_tools.handler({ query: 'yahoo' });
      for (const name of ['search_news', 'search_image', 'search_video', 'search_trend', 'suggest_keywords']) {
        expect(reg[name].enabled).toBe(true);
      }
      await server.close();
    });

    it('ranks query with stopwords intelligently without flooding unrelated tools', async () => {
      const server = createMcpServer({ deferTools: true });
      const reg = (server as any)._registeredTools;
      const searchTools = reg['search_tools'];

      // When LLM queries "トレンド trend 検索", it should target search_trend without flood
      const res = await searchTools.handler({ query: 'トレンド trend 検索' });
      const text = res.content[0].text;
      expect(text).toContain('search_trend');
      expect(text).not.toContain('search_image');
      expect(text).not.toContain('search_video');
      expect(text).not.toContain('predict_hts_code');

      // Discovery returns the canonical MCP name even for model-prefixed queries.
      expect(reg['search_trend'].enabled).toBe(true);
      expect(reg['default.search_trend']?.enabled).toBe(true);
    });

    it('tolerates default. prefix in search_tools query', async () => {
      const server = createMcpServer({ deferTools: true });
      const reg = (server as any)._registeredTools;
      const searchTools = reg['search_tools'];

      const res = await searchTools.handler({ query: 'default.search_trend' });
      const text = res.content[0].text;
      expect(text).toContain('search_trend');
      expect(reg['search_trend'].enabled).toBe(true);
      expect(reg['default.search_trend']?.enabled).toBe(true);
    });
  });
});
