#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, slimToolsListMessage } from './mcp.js';

async function main() {
  const server = createMcpServer({
    deferTools: false, // stdio 環境では全ツール（47 種）を直接即時登録
  });
  const transport = new StdioServerTransport();
  // HTTP 経路（sanitizeMcpResponse）と同じく、tools/list から outputSchema を除外し inputSchema を整形する
  const send = transport.send.bind(transport);
  transport.send = (message) => send(slimToolsListMessage(message));
  await server.connect(transport);
  console.error('[Sora MCP] Stdio server connected and ready.');
}

main().catch((err) => {
  console.error('[Sora MCP] Stdio fatal error:', err);
  process.exit(1);
});
