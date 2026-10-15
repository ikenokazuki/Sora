import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { sanitizeJsonSchemaForGemini } from './schema_sanitizer.js';
import type { ToolCatalogEntry } from './mcp.js';

export type SearchDetail = 'names' | 'summary' | 'schema';

/** detail=schema で返す上限。超えた分は件数と案内だけ付ける。 */
export const SCHEMA_MAX_TOOLS = 8;
export const SCHEMA_MAX_CHARS = 20_000;

export interface ToolMatch {
  entry: ToolCatalogEntry;
  /** この呼び出しで有効化した（activate:false では常に false）。 */
  newlyEnabled: boolean;
}

/** tools/list と同じ形（SDK の変換 + Gemini 互換化）の入力スキーマ。 */
export function listedInputSchema(entry: ToolCatalogEntry): unknown {
  const obj = normalizeObjectSchema((entry.handle as unknown as { inputSchema?: unknown }).inputSchema as never);
  const json = obj ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) : { type: 'object', properties: {} };
  return sanitizeJsonSchemaForGemini(json);
}

function summaryLine(entry: ToolCatalogEntry): string {
  const tag = entry.description.match(/^【(.*?)】/)?.[0] || '';
  const cleanDesc = entry.description.replace(/^【.*?】/, '').slice(0, 80);
  return `${tag}${cleanDesc}...`;
}

/**
 * search_tools の本文を作る。detail 省略かつ activate 既定（true）の出力は従来と同一。
 * 呼び出し側は activate=true のとき先に有効化を済ませ、newlyEnabled を渡す。
 */
export function formatToolMatches(matches: ToolMatch[], opts: { detail?: SearchDetail; activate?: boolean }): string {
  const detail = opts.detail ?? 'summary';
  const activate = opts.activate !== false;

  if (detail === 'names') {
    return matches.map(({ entry }) => `- ${entry.name} [${entry.category}] ${entry.keywords.slice(0, 5).join(', ')}`.trimEnd()).join('\n');
  }

  if (detail === 'schema') {
    const shown = matches.slice(0, SCHEMA_MAX_TOOLS);
    const blocks: string[] = [];
    let used = 0;
    for (const { entry } of shown) {
      const block = `### ${entry.name}\n${summaryLine(entry)}\n${JSON.stringify(listedInputSchema(entry))}`;
      if (used + block.length > SCHEMA_MAX_CHARS && blocks.length > 0) break;
      blocks.push(block);
      used += block.length;
    }
    const omitted = matches.length - blocks.length;
    if (omitted > 0) blocks.push(`（他 ${omitted} 件は省略。query を絞るか detail:"names" で一覧してください）`);
    return blocks.join('\n\n');
  }

  if (!activate) {
    return matches.map(({ entry }) => `- ${entry.name}: ${summaryLine(entry)} (状態: ${entry.handle.enabled ? '有効' : '未有効化'})`).join('\n');
  }

  const newly = matches.filter((m) => m.newlyEnabled).map(({ entry }) => `- ${entry.name}: ${summaryLine(entry)} (状態: 有効化完了)`);
  const already = matches.filter((m) => !m.newlyEnabled).map(({ entry }) => `- ${entry.name} (状態: 既に有効)`);
  const messages: string[] = [];
  if (newly.length > 0) messages.push(`以下のツールをセッション内で有効化しました:\n${newly.join('\n')}\n\n対象ツールを直接呼び出してください。`);
  if (already.length > 0) messages.push(`以下のツールはすでに有効化されています:\n${already.join('\n')}`);
  return messages.join('\n\n');
}
