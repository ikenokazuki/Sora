import { describe, expect, test } from 'bun:test';
import { McpSessionManager } from './mcp.js';

const rpcHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2024-11-05',
};

/** tenant は、呼び出し側（本物では認証のミドルウェア）が渡す。ここでは、manager に直接渡す */
function connection(manager: McpSessionManager, tenantId?: string) {
  let id = 0;
  let sessionId: string | undefined;
  const send = (body: object, as: { tenantId?: string }, extra: Record<string, string> = {}) =>
    manager.handleRequest(new Request('http://localhost/mcp', {
      method: extra.method ?? 'POST',
      headers: { ...rpcHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      ...(extra.method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
    }), as);
  const request = (method: string, params: object = {}, as: { tenantId?: string } = { tenantId }) =>
    send({ jsonrpc: '2.0', id: ++id, method, params }, as);
  const rpc = async (method: string, params: object = {}) => {
    const response = await request(method, params);
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  return {
    request,
    rpc,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'session-isolation-test', version: '1' },
      });
      expect(response.status).toBe(200);
      sessionId = response.headers.get('mcp-session-id')!;
      expect(sessionId).toBeTruthy();
      const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { tenantId });
      expect(notification.status).toBe(202);
    },
    async names() {
      const body = await rpc('tools/list');
      expect(body.error).toBeUndefined();
      return body.result.tools.map((tool: { name: string }) => tool.name) as string[];
    },
    discover(query: string) {
      return rpc('tools/call', { name: 'search_tools', arguments: { query } });
    },
    call(name: string, args: object) {
      return rpc('tools/call', { name, arguments: args });
    },
    close() {
      return send({}, { tenantId }, { method: 'DELETE' });
    },
  };
}

describe('MCP session activation isolation', () => {
  for (const [label, tenantId] of [
    ['legacy (no tenant given)', undefined],
    ['a named tenant', 'name:session-test'],
    ['a key-hash tenant', 'key:0123456789abcdef'],
  ] as const) {
    test(`${label}: discovery stays in one session and new connections start with core tools`, async () => {
      const manager = new McpSessionManager();
      const first = connection(manager, tenantId);
      const second = connection(manager, tenantId);
      const third = connection(manager, tenantId);
      try {
        await first.initialize();
        await second.initialize();
        expect(await first.names()).toHaveLength(13);
        expect(await second.names()).toHaveLength(13);
        await first.discover('search_keywords');
        const firstNames = await first.names();
        expect(firstNames).toHaveLength(15);
        expect(firstNames).toContain('search_keywords');
        expect(firstNames).toContain('default.search_keywords');
        expect(await second.names()).toHaveLength(13);
        const hiddenCall = await second.call('default.search_keywords', {});
        expect(hiddenCall.result.isError).toBe(true);
        expect(hiddenCall.result.content[0].text).toContain('disabled');
        await third.initialize();
        expect(await third.names()).toHaveLength(13);
      } finally {
        manager.clearAllSessions();
      }
    });
  }

  test('structured tool activation does not appear in another connection', async () => {
    const manager = new McpSessionManager();
    const first = connection(manager);
    const second = connection(manager);
    try {
      await first.initialize();
      await first.discover('get_country_context');
      expect(await first.names()).toContain('get_country_context');
      expect(await first.names()).toContain('default.get_country_context');
      await second.initialize();
      expect(await second.names()).toHaveLength(13);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('closed and cleared sessions discard their activated tools', async () => {
    const manager = new McpSessionManager();
    const first = connection(manager);
    const second = connection(manager);
    const third = connection(manager);
    try {
      await first.initialize();
      await first.discover('search_keywords');
      expect((await first.close()).status).toBe(200);
      expect((await first.request('tools/list')).status).toBe(404);
      await second.initialize();
      expect(await second.names()).toHaveLength(13);
      await second.discover('search_keywords');
      manager.clearAllSessions();
      expect((await second.request('tools/list')).status).toBe(404);
      await third.initialize();
      expect(await third.names()).toHaveLength(13);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('a session accepts only the tenant that created it (the tenant is given by the caller, never read from headers)', async () => {
    const manager = new McpSessionManager();
    const first = connection(manager, 'name:owner');
    try {
      await first.initialize();
      await first.discover('search_keywords');
      const sameOwner = await first.request('tools/list', {}, { tenantId: 'name:owner' });
      expect(sameOwner.status).toBe(200);
      const sameOwnerBody = await sameOwner.json() as any;
      expect(sameOwnerBody.result.tools).toHaveLength(15);
      const otherOwners: { tenantId?: string }[] = [{ tenantId: 'name:other' }, { tenantId: 'key:0123456789abcdef' }, { tenantId: 'legacy' }, {}];
      for (const as of otherOwners) {
        const response = await first.request('tools/list', {}, as);
        expect(response.status, JSON.stringify(as)).toBe(404);
        expect((await response.json() as any).error.message).toBe('Session not found');
      }
      expect(await first.names()).toHaveLength(15);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('stateless discovery does not change future lists or stateful sessions', async () => {
    const manager = new McpSessionManager();
    const stateless = connection(manager);
    const stateful = connection(manager);
    try {
      const discovery = await stateless.discover('search_keywords');
      expect(discovery.result.content[0].text).toContain('search_keywords');
      expect(await stateless.names()).toHaveLength(13);
      await stateful.initialize();
      expect(await stateful.names()).toHaveLength(13);
      await stateful.discover('search_keywords');
      expect(await stateful.names()).toHaveLength(15);
      expect(await stateless.names()).toHaveLength(13);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('stateless calls can use a deferred tool and its alias without retaining activation', async () => {
    const manager = new McpSessionManager();
    const stateless = connection(manager);
    try {
      for (const name of ['track_package', 'default.track_package']) {
        const result = await stateless.call(name, { trackingNumber: '123', noCache: true });
        expect(result.error).toBeUndefined();
        expect(result.result.isError ?? false).toBe(false);
        expect(JSON.parse(result.result.content[0].text)).toMatchObject({
          trackingNumber: '123', carrier: 'unknown', status: 'not_found',
        });
        expect(await stateless.names()).toHaveLength(13);
      }
      const unknown = await stateless.call('default.nonexistent_tool', {});
      expect(unknown.result.isError).toBe(true);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('stateless activation cannot enable a module disabled by configuration', async () => {
    const previousModules = process.env.SORA_MODULES;
    const manager = new McpSessionManager();
    try {
      process.env.SORA_MODULES = 'web';
      const stateless = connection(manager);
      const result = await stateless.call('default.track_package', { trackingNumber: '123' });
      expect(result.result.isError).toBe(true);
      expect(await stateless.names()).not.toContain('track_package');
    } finally {
      if (previousModules === undefined) delete process.env.SORA_MODULES;
      else process.env.SORA_MODULES = previousModules;
      manager.clearAllSessions();
    }
  });
});
