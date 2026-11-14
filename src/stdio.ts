#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, slimToolsListMessage } from './mcp.js';
import { installEgressFetch } from './net/egress_fetch.js';
import { setQuotaEnabled } from './security/quota.js';
import { checkStartupEnv } from './startup_check.js';

async function main() {
  // 環境変数の検査（出力は標準エラーだけ。標準出力は JSON-RPC の流れ）。誤りがあれば、接続する前に exit(1)。
  // stdio は待ち受けず認証も無いので、PORT と認証の汎用の旧名は見ない
  checkStartupEnv({ transport: 'stdio' });
  // 日次クォータは、HTTP の層（認証のミドルウェアが要求を数える）の機能。stdio には要求を数える層が無いので、一括・crawl の件数だけが数えられる半端を避け、数えない
  setQuotaEnabled(false);
  // SORA_EGRESS_GATEWAY=on のとき、Bun の fetch も、出口のゲートウェイに通す。使わないときは、何も変えない
  installEgressFetch();
  const server = createMcpServer({
    deferTools: false, // stdio 環境では全ツール（33 種）を直接即時登録
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
