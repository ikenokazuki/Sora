// いまのコードの MCP ツールの定義（名前・説明・入力のスキーマ）を、全ツールが見える状態で JSON に書き出す。
// 使い方: NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file docs/evaluations/tool-selection/snapshot.ts <出力のファイル>
// 統合の前（v4 の系）と後（v5）で 1 回ずつ書き出し、run.ts に渡して正答率を比べる。
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp.js';

const out = process.argv[2];
if (!out) {
  console.error('使い方: bun snapshot.ts <出力のファイル>');
  process.exit(2);
}

const server = createMcpServer({ deferTools: false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'tool-selection-snapshot', version: '1.0.0' }, { capabilities: {} });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
const snapshot = {
  count: tools.length,
  tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema })),
};
writeFileSync(out, `${JSON.stringify(snapshot)}\n`);
console.log(`${tools.length} tools, ${JSON.stringify(snapshot.tools).length} chars → ${out}`);
process.exit(0);
