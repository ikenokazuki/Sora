import { describe, expect, test } from 'bun:test';
import { McpSessionManager } from './mcp.js';

const rpcHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2024-11-05',
};

function connection(manager: McpSessionManager, auth: Record<string, string> = {}) {
  let id = 0;
  let sessionId: string | undefined;
  const request = (method: string, params: object = {}, headers: Record<string, string> = auth) =>
    manager.handleRequest(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...rpcHeaders, ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }));
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
      const notification = await manager.handleRequest(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { ...rpcHeaders, ...auth, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }));
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
      return manager.handleRequest(new Request('http://localhost/mcp', {
        method: 'DELETE', headers: { ...rpcHeaders, ...auth, 'mcp-session-id': sessionId! },
      }));
    },
  };
}

describe('MCP session activation isolation', () => {
  for (const [label, auth] of [
    ['anonymous', {}],
    ['same Bearer key', { Authorization: 'Bearer session-test-key' }],
    ['same X-API-Key', { 'x-api-key': 'session-test-key' }],
  ] as const) {
    test(`${label}: discovery stays in one session and new connections start with core tools`, async () => {
      const manager = new McpSessionManager();
      const first = connection(manager, auth);
      const second = connection(manager, auth);
      const third = connection(manager, auth);
      try {
        await first.initialize();
        await second.initialize();
        expect(await first.names()).toHaveLength(14);
        expect(await second.names()).toHaveLength(14);
        await first.discover('fetch_x_post');
        const firstNames = await first.names();
        expect(firstNames).toHaveLength(16);
        expect(firstNames).toContain('fetch_x_post');
        expect(firstNames).toContain('default.fetch_x_post');
        expect(await second.names()).toHaveLength(14);
        const hiddenCall = await second.call('default.fetch_x_post', { statusId: 'abc' });
        expect(hiddenCall.result.isError).toBe(true);
        expect(hiddenCall.result.content[0].text).toContain('disabled');
        await third.initialize();
        expect(await third.names()).toHaveLength(14);
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
      expect(await second.names()).toHaveLength(14);
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
      await first.discover('fetch_x_post');
      expect((await first.close()).status).toBe(200);
      expect((await first.request('tools/list')).status).toBe(404);
      await second.initialize();
      expect(await second.names()).toHaveLength(14);
      await second.discover('fetch_x_post');
      manager.clearAllSessions();
      expect((await second.request('tools/list')).status).toBe(404);
      await third.initialize();
      expect(await third.names()).toHaveLength(14);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('a session accepts the same key via either header and rejects another tenant', async () => {
    const manager = new McpSessionManager();
    const first = connection(manager, { Authorization: 'Bearer session-owner-key' });
    try {
      await first.initialize();
      await first.discover('fetch_x_post');
      const sameOwner = await first.request('tools/list', {}, { 'x-api-key': 'session-owner-key' });
      expect(sameOwner.status).toBe(200);
      const sameOwnerBody = await sameOwner.json() as any;
      expect(sameOwnerBody.result.tools).toHaveLength(16);
      const otherOwners: Record<string, string>[] = [{ Authorization: 'Bearer different-owner-key' }, {}];
      for (const auth of otherOwners) {
        const response = await first.request('tools/list', {}, auth);
        expect(response.status).toBe(404);
        expect((await response.json() as any).error.message).toBe('Session not found');
      }
      expect(await first.names()).toHaveLength(16);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('stateless discovery does not change future lists or stateful sessions', async () => {
    const manager = new McpSessionManager();
    const stateless = connection(manager);
    const stateful = connection(manager);
    try {
      const discovery = await stateless.discover('fetch_x_post');
      expect(discovery.result.content[0].text).toContain('fetch_x_post');
      expect(await stateless.names()).toHaveLength(14);
      await stateful.initialize();
      expect(await stateful.names()).toHaveLength(14);
      await stateful.discover('fetch_x_post');
      expect(await stateful.names()).toHaveLength(16);
      expect(await stateless.names()).toHaveLength(14);
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
        expect(await stateless.names()).toHaveLength(14);
      }
      const unknown = await stateless.call('default.nonexistent_tool', {});
      expect(unknown.result.isError).toBe(true);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('stateless activation cannot enable a module disabled by configuration', async () => {
    const previousModules = process.env.ENABLED_MODULES;
    const manager = new McpSessionManager();
    try {
      process.env.ENABLED_MODULES = 'web';
      const stateless = connection(manager);
      const result = await stateless.call('default.track_package', { trackingNumber: '123' });
      expect(result.result.isError).toBe(true);
      expect(await stateless.names()).not.toContain('track_package');
    } finally {
      if (previousModules === undefined) delete process.env.ENABLED_MODULES;
      else process.env.ENABLED_MODULES = previousModules;
      manager.clearAllSessions();
    }
  });
});
