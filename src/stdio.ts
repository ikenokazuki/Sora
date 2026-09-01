#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';

async function main() {
  const server = createMcpServer({
    deferTools: false, // stdio 環境では 37 種の全ツールを直接即時登録
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Sora MCP] Stdio server connected and ready.');
}

main().catch((err) => {
  console.error('[Sora MCP] Stdio fatal error:', err);
  process.exit(1);
});
