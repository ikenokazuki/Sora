import { readFileSync } from 'node:fs';
import { readSkill } from '../../src/mcp/resources.js';
import { restRoutesOf, type RestMap, type RestRoute } from '../tool-health/catalog.js';
import { schemaToTs, type OpenApiSchema } from './openapi_to_ts.js';

interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
}

export interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface ToolMeta {
  name: string;
  category: string;
  description: string;
  keywords: string[];
}

const template = (name: string): string => readFileSync(new URL(`./templates/${name}`, import.meta.url), 'utf8');

const camel = (snake: string): string => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
const pascal = (snake: string): string => camel(snake).replace(/^./, (c) => c.toUpperCase());

/** `/watch/:id` → `/watch/{id}`（OpenAPI の書き方）。 */
const openApiPath = (path: string): string => path.replace(/:(\w+)/g, '{$1}');

function inputSchema(op: OpenApiOperation, method: string, path: string): OpenApiSchema | undefined {
  if (method === 'POST') return op.requestBody?.content?.['application/json']?.schema;
  const properties: Record<string, OpenApiSchema> = {};
  const required: string[] = [];
  for (const name of path.matchAll(/:(\w+)/g)) {
    properties[name[1]] = { type: 'string' };
    required.push(name[1]);
  }
  for (const p of op.parameters ?? []) {
    if (p.in !== 'path' && p.in !== 'query') continue;
    properties[p.name] = { ...p.schema, description: p.description ?? p.schema?.description };
    if (p.required && !required.includes(p.name)) required.push(p.name);
  }
  return Object.keys(properties).length > 0 ? { type: 'object', properties, required } : undefined;
}

/** `fn` の無い 2 つ目以降のルートの関数名: メソッドとパス（`DELETE /watch/:id` → `deleteWatchId`）。 */
const routeFn = (route: RestRoute): string =>
  camel([route.method.toLowerCase(), ...route.path.split('/').filter(Boolean).map((s) => s.replace(/^:/, '').replace(/-/g, '_'))].join('_'));

function routeFunction(fn: string, tool: ToolMeta, route: RestRoute, op: OpenApiOperation): string[] {
  const type = pascal(fn);
  const input = inputSchema(op, route.method, route.path);
  const output = op.responses?.['200']?.content?.['application/json']?.schema;
  const routeLiteral = `{ method: '${route.method}', path: '${route.path}' }`;
  // 関数はそのルートの REST を呼ぶので、そのルートの操作の文で説明する（統合したツールの MCP の説明は、REST に無い引数や、まとめた応答の形を書いている）
  const text = [op.summary, op.description].filter(Boolean).join(' ') || tool.description;
  const description = text.replace(/\*\//g, '* /').replace(/\s*\n\s*/g, ' ');
  const signature = input ? `input: ${type}Input` : '';
  return [
    ...(input ? [`export type ${type}Input = ${schemaToTs(input)};`, ''] : []),
    `export type ${type}Output = ${schemaToTs(output)};`,
    '',
    `/** ${description} */`,
    `export function ${fn}(${signature}): Promise<${type}Output> {`,
    `  return callSora<${type}Output>(${routeLiteral}${input ? ', input' : ''});`,
    '}',
    '',
  ];
}

/** OpenAPI と REST_MAP とツール台帳から、クライアントの全ファイル（相対パス → 内容）を作る。出力は決定的。 */
export function generateClient(doc: OpenApiDoc, restMap: RestMap, tools: ToolMeta[]): Record<string, string> {
  const files: Record<string, string> = {};
  const catalog: unknown[] = [];
  const modules: string[] = [];
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const owners = new Map<string, string>(); // 関数名 → それを持つツールとルート（index.ts が全部を再 export するので、重ならないこと）

  for (const tool of sorted) {
    if (!(tool.name in restMap)) throw new Error(`gen-client: tool "${tool.name}" has no REST_MAP entry`);
    const routes = restRoutesOf(tool.name, restMap);
    if (!routes.length) continue;
    const file = `servers/sora/${tool.name}.ts`;
    const body = routes.flatMap((route, index) => {
      const op = doc.paths[openApiPath(route.path)]?.[route.method.toLowerCase()];
      if (!op) throw new Error(`gen-client: tool "${tool.name}" (${route.method} ${route.path}) is not in the OpenAPI document`);
      // 1 つ目のルートは、ツールの主な動きなので、ルートが増えても関数名を変えない。
      const fn = route.fn ?? (index === 0 ? camel(tool.name) : routeFn(route));
      const owner = `${tool.name} (${route.method} ${route.path})`;
      const other = owners.get(fn);
      if (other) throw new Error(`gen-client: function name "${fn}" is used by both ${other} and ${owner}; give one of them another fn in REST_MAP`);
      owners.set(fn, owner);
      catalog.push({ name: tool.name, fn, category: tool.category, description: tool.description, keywords: tool.keywords, method: route.method, path: route.path, file });
      return routeFunction(fn, tool, route, op);
    });
    files[file] = ['// Generated by `bun run gen:client`. Do not edit by hand.', "import { callSora } from '../../runtime.js';", '', ...body].join('\n');
    modules.push(tool.name);
  }

  files['servers/sora/index.ts'] = [
    '// Generated by `bun run gen:client`. Do not edit by hand.',
    ...modules.map((name) => `export * from './${name}.js';`),
    '',
  ].join('\n');
  files['catalog.json'] = `${JSON.stringify(catalog, null, 2)}\n`;
  files['runtime.ts'] = template('runtime.ts');
  files['search.ts'] = template('search.ts');
  files['README.md'] = template('README.md');
  files['SKILL.md'] = readSkill('sora-client') ?? (() => { throw new Error('gen-client: sora-client skill not found'); })();
  files['manifest.json'] = `${JSON.stringify({ files: Object.keys(files).sort() }, null, 2)}\n`;
  return files;
}
