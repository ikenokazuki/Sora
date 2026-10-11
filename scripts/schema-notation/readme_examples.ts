// README の REST の例（リクエスト・レスポンスの JSON）を、OpenAPI のスキーマと照合する。
// レスポンス例はキーを入れ子までたどり、リクエスト例は最上位のキーだけを見る。
// README の例は「書いたキーがスキーマにある」ことだけを確かめる（例はスキーマの一部でよい）。
import { readFileSync } from 'node:fs';
import { generateOpenApiDocument } from '../../src/types.js';

export interface ReadmeExampleFinding { line: number; kind: 'response' | 'request'; detail: string }
interface Endpoint { method: string; path: string }

const ENDPOINT = /`(POST|GET|DELETE|PUT)\s+(\/[^`\s]*)`/;

/** 省略記法（`[ ... ]`・`{ ... }`・undefined）を JSON として読める形にする。 */
function parseExample(body: string): unknown {
  return JSON.parse(body.replace(/\[\s*\.\.\.\s*\]/g, '[]').replace(/\{\s*\.\.\.\s*\}/g, '{}').replace(/\bundefined\b/g, 'null'));
}

/** allOf / anyOf / oneOf をプロパティの和にまとめる（例のキーがどれかにあれば良い）。 */
function resolve(schema: any): any {
  if (!schema) return schema;
  if (schema.allOf) return { properties: Object.assign({}, ...schema.allOf.map((s: any) => resolve(s)?.properties ?? {})) };
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const resolved = options.map(resolve).filter((s: any) => s?.properties || s?.items);
    if (resolved.length === 0) return schema;
    return { properties: Object.assign({}, ...resolved.map((s: any) => s.properties ?? {})), items: resolved.find((s: any) => s.items)?.items };
  }
  return schema;
}

/** 例にあってスキーマに無いキーのパス。プロパティを宣言していない（自由形式の）位置より先は確かめない。 */
export function missingExampleKeys(example: unknown, schema: any, path = ''): string[] {
  const s = resolve(schema);
  if (Array.isArray(example)) {
    return s?.items ? example.slice(0, 3).flatMap((item) => missingExampleKeys(item, s.items, `${path}[]`)) : [];
  }
  if (!example || typeof example !== 'object' || !s?.properties) return [];
  return Object.entries(example as Record<string, unknown>).flatMap(([key, value]) =>
    key in s.properties ? missingExampleKeys(value, s.properties[key], `${path}.${key}`) : [`${path}.${key}`]);
}

export function checkReadmeExamples(markdown: string, doc: any = generateOpenApiDocument()): ReadmeExampleFinding[] {
  const lines = markdown.split('\n');
  const paths = Object.keys(doc.paths);
  const findPath = (p: string) => {
    const bare = p.split('?')[0];
    return paths.find((t) => new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(bare));
  };
  const out: ReadmeExampleFinding[] = [];
  let endpoint: Endpoint | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3} /.test(line)) endpoint = undefined;
    const m = line.match(ENDPOINT);
    // エンドポイントは、見出し・太字の項目・「リクエスト」の行に書かれたものをその後の例に当てはめる
    if (m && (/^#{3,4} /.test(line) || /^\s*- \*\*/.test(line) || /リクエスト/.test(line))) endpoint = { method: m[1], path: m[2] };
    if (!line.trim().startsWith('```json')) continue;

    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('```')) end++;
    const label = lines.slice(Math.max(0, i - 3), i).filter((l) => l.trim()).pop() ?? '';
    const labelEndpoint = label.match(ENDPOINT);
    const ep = labelEndpoint ? { method: labelEndpoint[1], path: labelEndpoint[2] } : endpoint;
    const kind: ReadmeExampleFinding['kind'] =
      /レスポンス/.test(label) || ep?.method === 'GET' || ep?.method === 'DELETE' ? 'response' : 'request';
    const lineNo = i + 1;
    i = end;
    // エンドポイントが分からないリクエストの JSON は、MCP の設定例などの API 以外の例として扱う
    if (!ep) {
      if (kind === 'response') out.push({ line: lineNo, kind, detail: 'response example without an endpoint' });
      continue;
    }
    let example: unknown;
    try {
      example = parseExample(lines.slice(lineNo, end).join('\n'));
    } catch {
      out.push({ line: lineNo, kind, detail: `unparseable JSON (${ep.method} ${ep.path})` });
      continue;
    }
    const path = findPath(ep.path);
    const op = path ? doc.paths[path]?.[ep.method.toLowerCase()] : undefined;
    if (!op) {
      out.push({ line: lineNo, kind, detail: `no OpenAPI operation for ${ep.method} ${ep.path}` });
      continue;
    }
    if (kind === 'response') {
      const schema = op.responses?.['200']?.content?.['application/json']?.schema;
      if (!schema) continue;
      const missing = missingExampleKeys(example, schema);
      if (missing.length) out.push({ line: lineNo, kind, detail: `${ep.method} ${ep.path}: ${missing.join(' ')}` });
    } else {
      const schema = op.requestBody?.content?.['application/json']?.schema;
      if (!schema?.properties || Array.isArray(example) || !example || typeof example !== 'object') continue;
      const missing = Object.keys(example).filter((key) => !(key in schema.properties));
      if (missing.length) out.push({ line: lineNo, kind, detail: `${ep.method} ${ep.path}: ${missing.join(' ')}` });
    }
  }
  return out;
}

export function checkRepositoryReadme(): ReadmeExampleFinding[] {
  return checkReadmeExamples(readFileSync(new URL('../../README.md', import.meta.url), 'utf8'));
}

if (import.meta.main) {
  const findings = checkRepositoryReadme();
  for (const f of findings) console.log(`README.md:${f.line} [${f.kind}] ${f.detail}`);
  console.log(`TOTAL ${findings.length}`);
  process.exit(findings.length ? 1 : 0);
}
