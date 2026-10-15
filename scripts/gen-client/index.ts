/**
 * client/ を生成する。使い方: bun run gen:client
 * 入力: OpenAPI（src/types.ts）、REST_MAP（scripts/tool-health/catalog.ts）、MCP のツール台帳（src/mcp.ts）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, toolCatalogOf } from '../../src/mcp.js';
import { generateOpenApiDocument } from '../../src/types.js';
import { REST_MAP } from '../tool-health/catalog.js';
import { generateClient, type OpenApiDoc, type ToolMeta } from './render.js';

export function buildClientFiles(): Record<string, string> {
  const tools: ToolMeta[] = [...toolCatalogOf(createMcpServer({ deferTools: false })).values()].map((entry) => ({
    name: entry.name,
    category: entry.category,
    description: entry.description,
    keywords: entry.keywords,
  }));
  return generateClient(generateOpenApiDocument() as unknown as OpenApiDoc, REST_MAP, tools);
}

if (import.meta.main) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client');
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(buildClientFiles())) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(`wrote ${outDir}`);
  process.exit(0);
}
