import type { MiddlewareHandler } from 'hono';
import { findOversizedInput } from '../security/input_limits.js';
import { formatError } from './utils.js';

/** MCP の経路は、ツールの包み（mcp/registry.ts）で調べる（誤りを、ツールの結果として返すため） */
const MCP_PATHS = new Set(['/mcp', '/sse', '/message']);

/**
 * REST の要求の、クエリの欄と JSON の本文の、文字列の長さの上限（security/input_limits.ts）。超えたら経路の前に 400。
 * 経路の本文の読み方（c.req.json()）と同じく、content-type は見ない。multipart は、ファイルを壊さないように読まない（欄はスキーマが確かめる）
 */
export const restInputLimits: MiddlewareHandler = async (c, next) => {
  if (!MCP_PATHS.has(c.req.path)) {
    // 値が 1 つの欄は、配列にしない（誤りの文の欄の名前を、q[0] ではなく q にする）
    let problem = findOversizedInput(Object.fromEntries(Object.entries(c.req.queries()).map(([key, values]) => [key, values.length === 1 ? values[0] : values])));
    if (!problem && c.req.raw.body && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/')) {
      // JSON でない本文は、経路が断る（Hono が本文を覚えるので、経路も同じ本文を読む）
      const body = await c.req.json().catch(() => undefined);
      if (body !== undefined) problem = findOversizedInput(body);
    }
    if (problem) return formatError(c, problem, 'INVALID_INPUT', 400, false);
  }
  return next();
};
