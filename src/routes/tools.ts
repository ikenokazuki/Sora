import { Hono } from 'hono';
import { describeRestTool, listRestTools } from '../rest_operations.js';
import { generateOpenApiDocument } from '../types.js';
import { formatError } from './utils.js';

/**
 * 言語に依存しない操作の一覧と定義。コードを実行できる呼び出し側は、curl や標準ライブラリだけで
 * 「一覧 → 1 つの定義 → 呼ぶ」を進められる（OpenAPI 全体は約 500KB あり、まるごとは読めない）。
 * 元は OpenAPI（/openapi.json と同じ文書）なので、無効なモジュールの操作は出ない。
 */
export const toolsRoutes = new Hono();

toolsRoutes.get('/tools', (c) => {
  c.header('Cache-Control', 'no-cache');
  const tools = listRestTools(generateOpenApiDocument(), { q: c.req.query('q'), category: c.req.query('category') });
  return c.json({ count: tools.length, tools });
});

toolsRoutes.get('/tools/:name', (c) => {
  c.header('Cache-Control', 'no-cache');
  const name = c.req.param('name');
  const tool = describeRestTool(generateOpenApiDocument(), name, { response: c.req.query('response') === 'true' });
  if (!tool) return formatError(c, `Unknown tool: ${name}. GET /tools で一覧を確かめてください`, 'NOT_FOUND', 404);
  return c.json(tool);
});
