import { describe, expect, test } from 'bun:test';
import { REST_MAP } from '../scripts/tool-health/catalog.js';
import { createMcpServer, toolCatalogOf } from './mcp.js';
import { EXPLICIT_ONLY_MODULES } from './mcp/registry.js';
import {
  describeRestTool,
  finalizeOpenApi,
  listRestTools,
  operationKey,
  OTHER_OPERATIONS,
  REST_TOOLS,
} from './rest_operations.js';
import { generateOpenApiDocument } from './types.js';

/** 名前を挙げたときだけ有効になるモジュール（lyrics・shazam・hts-archive）も含めて、全部の経路を OpenAPI に出す */
function withAllModules<T>(fn: () => T): T {
  const prev = process.env.ENABLED_MODULES;
  process.env.ENABLED_MODULES = 'all,lyrics,shazam,hts-archive';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ENABLED_MODULES; else process.env.ENABLED_MODULES = prev;
  }
}

const allOperations = (doc: { paths: Record<string, Record<string, any>> }) =>
  Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ key: operationKey(method, path), path, method, op })));

describe('台帳（REST_TOOLS・OTHER_OPERATIONS）', () => {
  test('名前（operationId）は重ならず、別名・GET の形は正本を指す', () => {
    const ids = [...REST_TOOLS.map((tool) => tool.id), ...Object.values(OTHER_OPERATIONS).map((other) => other.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const toolIds = new Set(REST_TOOLS.map((tool) => tool.id));
    for (const other of Object.values(OTHER_OPERATIONS)) {
      if (other.of) expect(toolIds.has(other.of)).toBe(true);
      expect(['alias', 'get', 'stream'].includes(other.kind)).toBe(other.of !== undefined);
    }
  });

  test('OpenAPI の全部の操作が台帳にあり、台帳の経路は OpenAPI に実在する（経路を足したら、台帳にも足す）', () => {
    const doc = withAllModules(() => generateOpenApiDocument());
    const keys = new Set(allOperations(doc).map((operation) => operation.key));
    const registered = [...REST_TOOLS.map((tool) => operationKey(tool.method, tool.path)), ...Object.keys(OTHER_OPERATIONS)];
    expect([...keys].filter((key) => !registered.includes(key))).toEqual([]);
    expect(registered.filter((key) => !keys.has(key))).toEqual([]);
  });

  // REST_MAP は、ツール名 → 経路（1 つか、複数）。MCP のツールを統合した v5.0.0 では、1 つのツールが複数の経路を持つ
  type Route = { method: string; path: string };
  const routesOf = (value: Route | Route[] | null | undefined): Route[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
  const keyOf = (route: Route) => operationKey(route.method, route.path.replace(/:(\w+)/g, '{$1}'));

  test('REST_MAP のすべての経路が台帳にあり、MCP のツールのカテゴリは、最初の経路のカテゴリと同じ', () => {
    const catalog = toolCatalogOf(createMcpServer({ deferTools: false, modules: ['all', ...EXPLICIT_ONLY_MODULES] }));
    const byKey = new Map(REST_TOOLS.map((tool) => [operationKey(tool.method, tool.path), tool]));
    for (const [name, value] of Object.entries(REST_MAP)) {
      const routes = routesOf(value);
      for (const route of routes) expect(byKey.has(keyOf(route)), `${name}: ${keyOf(route)}`).toBe(true);
      const entry = catalog.get(name);
      if (entry && routes.length > 0) expect(byKey.get(keyOf(routes[0]))?.category, name).toBe(entry.category);
    }
  });
});

describe('finalizeOpenApi（OpenAPI の整備）', () => {
  const doc = withAllModules(() => generateOpenApiDocument());
  const operations = allOperations(doc);

  test('すべての操作に、重ならない operationId とタグがある', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { op } of operations) expect(op.tags).toHaveLength(1);
  });

  test('operationId は、正本は台帳の名前、別名の経路もそれぞれ別の名前', () => {
    const op = (key: string) => operations.find((operation) => operation.key === key)!.op;
    expect(op('POST /search/deep').operationId).toBe('search_deep');
    expect(op('POST /search').operationId).toBe('search_deep_alias');
    expect(op('POST /search').tags).toEqual(['web']);
    expect(op('POST /search').description).toContain('正本は POST /search/deep');
    expect(op('GET /weather').description).toContain('GET');
  });

  test('エラー応答は共通の形（error・code・status・retryable）で宣言され、default もある', () => {
    for (const { key, op } of operations) {
      if (key === 'GET /t/{carrier}/{number}') continue; // 利用者に見せる HTML のページ
      expect(op.responses.default?.content?.['application/json']?.schema?.required).toEqual(['error', 'code', 'status', 'retryable']);
      for (const [code, response] of Object.entries<any>(op.responses)) {
        if (!code.startsWith('2')) expect(response.content?.['application/json']).toBeDefined();
      }
    }
  });

  test('認証は Bearer か X-API-Key（キー未設定なら無し）で、公開の経路は認証なし', () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }, {}]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components.securitySchemes.apiKeyHeader).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    const op = (key: string) => operations.find((operation) => operation.key === key)!.op;
    expect(op('GET /health').security).toEqual([]);
    expect(op('POST /scrape').security).toBeUndefined();
  });

  test('パスの変数は、すべて parameters に宣言されている', () => {
    for (const { path, op } of operations) {
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
        expect(op.parameters?.some((p: any) => p.in === 'path' && p.name === name && p.required === true)).toBe(true);
      }
    }
  });

  test('スキーマは各操作の中に直接ある（$ref を使わない）。1 つの操作の定義だけで完結する', () => {
    for (const { op } of operations) expect(JSON.stringify(op)).not.toContain('$ref');
  });

  test('入力の文書を書き換えず、別名が操作のオブジェクトを共有しても、互いに影響しない', () => {
    const shared = { post: { summary: 's', responses: { '200': { description: 'ok' } } } };
    const input = { paths: { '/search': shared, '/search/deep': shared } };
    const out = finalizeOpenApi(input);
    expect((shared.post as any).operationId).toBeUndefined();
    expect(out.paths['/search'].post.operationId).toBe('search_deep_alias');
    expect(out.paths['/search/deep'].post.operationId).toBe('search_deep');
  });

  test('台帳に無い経路にも、重ならない operationId が付く', () => {
    const out = finalizeOpenApi({ paths: { '/new/thing/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
    expect(out.paths['/new/thing/{id}'].get.operationId).toBe('get_new_thing_id');
    expect(out.paths['/new/thing/{id}'].get.tags).toEqual(['system']);
  });
});

describe('listRestTools / describeRestTool', () => {
  const doc = generateOpenApiDocument();

  test('既定のモジュールでは、台帳の正本のうち 52 件が載り、名前を挙げたときだけのモジュールの操作は載らない', () => {
    const names = listRestTools(doc).map((tool) => tool.name);
    expect(names).toHaveLength(52);
    for (const hidden of ['get_lyrics', 'recognize_song', 'recognize_song_signature', 'list_hts_releases', 'get_hts_release']) {
      expect(names).not.toContain(hidden);
    }
    expect(withAllModules(() => listRestTools(generateOpenApiDocument())).map((tool) => tool.name)).toContain('get_lyrics');
  });

  test('q は、空白で区切った語をすべて含むものだけ（名前・パス・カテゴリ・概要。大文字小文字は区別しない）', () => {
    expect(listRestTools(doc, { q: '郵便番号' }).map((tool) => tool.name)).toContain('search_postal_code');
    expect(listRestTools(doc, { q: 'WEATHER' }).map((tool) => tool.name)).toEqual(['get_weather']);
    expect(listRestTools(doc, { q: '/tracking' }).map((tool) => tool.name)).toEqual(['track_package']);
    expect(listRestTools(doc, { q: '　weather　　life ' }).map((tool) => tool.name)).toEqual(['get_weather']);
    expect(listRestTools(doc, { q: 'weather 郵便番号' })).toEqual([]);
    expect(listRestTools(doc, { q: 'zzzz-no-such' })).toEqual([]);
  });

  test('category は、そのカテゴリだけ', () => {
    const trade = listRestTools(doc, { category: 'trade' });
    expect(trade.length).toBeGreaterThan(0);
    expect(trade.every((tool) => tool.category === 'trade')).toBe(true);
  });

  test('定義には、入力のスキーマ・path と query の引数・別名が入り、応答のスキーマは response のときだけ', () => {
    const plain = describeRestTool(doc, 'search_postal_code')!;
    expect(plain).toMatchObject({ name: 'search_postal_code', method: 'POST', path: '/geo/postal-code', category: 'disaster' });
    expect(plain.request.contentType).toBe('application/json');
    expect(plain.request.schema.properties.zipcode).toBeDefined();
    expect(plain.alternatives).toEqual([{ kind: 'get', method: 'GET', path: '/geo/postal-code' }]);
    expect(plain.response).toBeUndefined();

    const withResponse = describeRestTool(doc, 'search_postal_code', { response: true })!;
    expect(withResponse.response.contentType).toBe('application/json');
    expect(withResponse.response.schema).toBeDefined();

    const deep = describeRestTool(doc, 'search_deep')!;
    expect(deep.alternatives.map((alternative: any) => alternative.path).sort()).toEqual(['/deep-search', '/search', '/search/integrated']);

    const del = describeRestTool(doc, 'watch_delete')!;
    expect(del).toMatchObject({ method: 'DELETE', path: '/watch/{id}' });
    expect(del.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(del.request).toBeUndefined();
  });

  test('一覧に無い名前・別名の名前・無効なモジュールの操作は undefined', () => {
    expect(describeRestTool(doc, 'nope')).toBeUndefined();
    expect(describeRestTool(doc, 'search_deep_alias')).toBeUndefined();
    expect(describeRestTool(doc, 'get_lyrics')).toBeUndefined();
  });
});
