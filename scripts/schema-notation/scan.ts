// Input-schema notation scanner: documented defaults / enums / ranges vs declared JSON Schema,
// and MCP tool <-> REST route parity. Pure checks live in findNotationIssues().
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp.js';
import { generateOpenApiDocument } from '../../src/types.js';
import { REST_MAP } from '../tool-health/catalog.js';
import { NOTATION_ALLOWLIST } from './allowlist.js';

export type Surface = 'mcp' | 'rest';
export interface Param { surface: Surface; owner: string; path: string; schema: any }
export type FindingKind =
  | 'default_undeclared' | 'default_mismatch' | 'default_unparseable'
  | 'enum_missing' | 'range_mismatch' | 'unbounded_integer' | 'pair_mismatch';
export interface Finding { kind: FindingKind; key: string; detail: string }
export type DocumentedDefault = { found: false } | { found: true; parseable: false } | { found: true; parseable: true; value: unknown };

const SAFE = Number.MAX_SAFE_INTEGER;
const stripExamples = (text: string) => text.replace(/例\s*[:：][^)）]*/g, '');

export function parseDocumentedDefault(description: string): DocumentedDefault {
  const text = stripExamples(description ?? '');
  if (!text.includes('デフォルト')) return { found: false };
  const strictInline = [...text.matchAll(/"([^"]+)"\s*[（(][^"（）()]*デフォルト[^"（）()]*[）)]/g)];
  if (strictInline.length === 1) return { found: true, parseable: true, value: strictInline[0][1] };
  const explicit = text.match(/デフォルト\s*[:：]\s*(.*)$/s);
  if (explicit) {
    const rest = explicit[1];
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^"([^"]*)"/))) return { found: true, parseable: true, value: m[1] };
    if ((m = rest.match(/^(\[[^\]]*\])/))) {
      try { return { found: true, parseable: true, value: JSON.parse(m[1]) }; } catch { return { found: true, parseable: false }; }
    }
    if ((m = rest.match(/^(true|false)(?![\w])/))) return { found: true, parseable: true, value: m[1] === 'true' };
    if ((m = rest.match(/^(-?\d+(?:\.\d+)?)(?![\d.\w])/))) return { found: true, parseable: true, value: Number(m[1]) };
    return { found: true, parseable: false };
  }
  const looseInline = text.match(/"([^"]+)"\s*[（(][^)）]*デフォルト[^:：]/);
  if (looseInline) return { found: true, parseable: true, value: looseInline[1] };
  return { found: true, parseable: false };
}

const keyOf = (p: Param) => `${p.surface} ${p.owner} ${p.path}`;
const enumOf = (s: any): unknown[] | undefined => s.enum ?? s.items?.enum ?? (s.anyOf ? s.anyOf.flatMap((v: any) => v.enum ?? []) : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedEnum = (s: any) => { const e = enumOf(s); return e && e.length ? [...e].map(String).sort() : undefined; };

export function findNotationIssues(
  params: Param[],
  pairs: Record<string, { method: string; path: string } | null>,
  allow: Record<string, string> = {},
): Finding[] {
  const out: Finding[] = [];
  const push = (kind: FindingKind, key: string, detail: string) => {
    if (!allow[`${kind} ${key}`]) out.push({ kind, key, detail });
  };
  for (const p of params) {
    const s = p.schema ?? {};
    const desc: string = s.description ?? '';
    const key = keyOf(p);
    const doc = parseDocumentedDefault(desc);
    if (doc.found && !doc.parseable) push('default_unparseable', key, desc);
    if (doc.found && doc.parseable) {
      if (s.default === undefined) push('default_undeclared', key, `documented ${JSON.stringify(doc.value)}`);
      else if (!same(s.default, doc.value)) push('default_mismatch', key, `declared ${JSON.stringify(s.default)} / documented ${JSON.stringify(doc.value)}`);
    }
    const noEx = stripExamples(desc);
    const hasEnum = !!enumOf(s)?.length;
    const isString = s.type === 'string' || (s.type === 'array' && s.items?.type === 'string');
    if (!hasEnum && isString && (noEx.match(/"[^"]+"\s*[（(]/g) ?? []).length >= 2) push('enum_missing', key, desc);
    if (!hasEnum && (s.type === 'integer' || s.type === 'number') && (noEx.match(/\d+\s*=/g) ?? []).length >= 3) push('enum_missing', key, desc);
    if (s.type === 'integer' || s.type === 'number') {
      if (s.maximum === SAFE || s.minimum === -SAFE) push('unbounded_integer', key, `min ${s.minimum} max ${s.maximum}`);
      const r = noEx.match(/(\d+)\s*[〜~～-]\s*(\d+)/);
      if (r && (s.minimum !== Number(r[1]) || s.maximum !== Number(r[2]))) push('range_mismatch', key, `documented ${r[1]}-${r[2]} / declared ${s.minimum}-${s.maximum}`);
    }
    const max = noEx.match(/最大\s*[:：]?\s*(\d+)/);
    if (max) {
      const declared = s.type === 'array' ? s.maxItems : (s.type === 'integer' || s.type === 'number') ? s.maximum : 'n/a';
      if (declared !== 'n/a' && declared !== Number(max[1])) push('range_mismatch', key, `documented max ${max[1]} / declared ${declared}`);
    }
  }
  const restByOwner = new Map<string, Param[]>();
  for (const p of params) if (p.surface === 'rest') restByOwner.set(p.owner, [...(restByOwner.get(p.owner) ?? []), p]);
  for (const p of params) {
    if (p.surface !== 'mcp') continue;
    const route = pairs[p.owner];
    if (!route) continue;
    const owner = `${route.method.toUpperCase()} ${route.path.replace(/:(\w+)/g, '{$1}')}`;
    const twin = (restByOwner.get(owner) ?? []).find((r) => r.path === p.path || r.path === `query:${p.path}` || r.path === `path:${p.path}`);
    if (!twin) continue;
    const a = p.schema ?? {}, b = twin.schema ?? {};
    const diffs: string[] = [];
    const typeOf = (s: any) => s.type ?? (s.anyOf ? s.anyOf.map((v: any) => v.type).join('|') : undefined);
    if (typeOf(a) !== typeOf(b)) diffs.push(`type ${typeOf(a)}/${typeOf(b)}`);
    if (!same(sortedEnum(a), sortedEnum(b))) diffs.push(`enum ${JSON.stringify(sortedEnum(a))}/${JSON.stringify(sortedEnum(b))}`);
    for (const f of ['default', 'minimum', 'maximum', 'maxItems'] as const) if (!same(a[f], b[f])) diffs.push(`${f} ${JSON.stringify(a[f])}/${JSON.stringify(b[f])}`);
    if (diffs.length) push('pair_mismatch', `${p.owner} ${p.path}`, `mcp/rest ${owner}: ${diffs.join('; ')}`);
  }
  return out;
}

function walk(out: Param[], surface: Surface, owner: string, path: string, schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (path) out.push({ surface, owner, path, schema });
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) walk(out, surface, owner, path ? `${path}.${k}` : k, v);
  if (schema.items?.properties) walk(out, surface, owner, `${path}[]`, schema.items);
}

export async function collectParams(options: { hotel?: boolean } = {}): Promise<Param[]> {
  const out: Param[] = [];
  const previousHotelFlag = process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
  if (options.hotel) process.env.SORA_RAKUTEN_TRAVEL_ENABLED = 'true';
  try {
    await collectInto(out);
  } finally {
    if (previousHotelFlag === undefined) delete process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
    else process.env.SORA_RAKUTEN_TRAVEL_ENABLED = previousHotelFlag;
  }
  return out;
}

async function collectInto(out: Param[]): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'schema-notation', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const tool of (await client.listTools()).tools) {
      if (!tool.name.startsWith('default.')) walk(out, 'mcp', tool.name, '', tool.inputSchema);
    }
  } finally {
    await client.close();
    await server.close();
  }
  const doc: any = generateOpenApiDocument();
  for (const [path, ops] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      const owner = `${method.toUpperCase()} ${path}`;
      walk(out, 'rest', owner, '', op.requestBody?.content?.['application/json']?.schema);
      for (const prm of op.parameters ?? []) {
        out.push({ surface: 'rest', owner, path: `${prm.in}:${prm.name}`, schema: { ...(prm.schema ?? {}), description: prm.description ?? prm.schema?.description } });
      }
    }
  }
}

export async function scanRepository(): Promise<Finding[]> {
  return findNotationIssues(await collectParams({ hotel: true }), REST_MAP, NOTATION_ALLOWLIST);
}

if (import.meta.main) {
  const findings = await scanRepository();
  const byKind = new Map<string, Finding[]>();
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  for (const [kind, list] of byKind) {
    console.log(`\n## ${kind} (${list.length})`);
    for (const f of list) console.log(`- ${f.key} :: ${f.detail}`);
  }
  console.log(`\nTOTAL ${findings.length}`);
  process.exitCode = findings.length ? 1 : 0;
}
