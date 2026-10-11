import { describe, expect, test } from 'bun:test';
import { findNotationIssues, noteKeyPaths, parseDocumentedDefault, type Param } from './scan.js';
import { checkReadmeExamples, missingExampleKeys } from './readme_examples.js';

const SAFE = Number.MAX_SAFE_INTEGER;
const kinds = (params: Param[], pairs: Record<string, { method: string; path: string } | null> = {}, allow: Record<string, string> = {}) =>
  findNotationIssues(params, pairs, allow).map((f) => f.kind);

describe('parseDocumentedDefault', () => {
  test.each([
    ['取得件数 (1〜50, デフォルト: 20)', 20],
    ['国コード (デフォルト: "jp")', 'jp'],
    ['出力形式 (デフォルト: ["markdown"])', ['markdown']],
    ['付与するか (デフォルト: false)', false],
    ['並行数 (デフォルト: 3, 最大: 5)', 3],
    ['"rho-select-v2"(デフォルト: 論文版), "legacy"', 'rho-select-v2'],
    ['"auto" (スマート自動判定, デフォルト), "fast"', 'auto'],
    ['"full"(デフォルト全文), "highlights"', 'full'],
  ] as const)('%s', (description, value) => {
    expect(parseDocumentedDefault(description)).toEqual({ found: true, parseable: true, value: value as unknown });
  });

  test('conditional and unquoted string defaults are unparseable', () => {
    expect(parseDocumentedDefault('抽出するか (デフォルト: query指定時はtrue, query未指定時はfalse)')).toEqual({ found: true, parseable: false });
    expect(parseDocumentedDefault('調査期間 (デフォルト: 30d)')).toEqual({ found: true, parseable: false });
  });

  test('descriptions without the word デフォルト have no documented default', () => {
    expect(parseDocumentedDefault('特定の ID (省略時は全件を走査)')).toEqual({ found: false });
  });
});

describe('findNotationIssues', () => {
  const limit = (schema: Record<string, unknown>): Param => ({ surface: 'mcp', owner: 'tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, ...schema } });

  test('documented default must be declared with the same value', () => {
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)' })])).toEqual(['default_undeclared']);
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)', default: 20 })])).toEqual([]);
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)', default: 10 })])).toEqual(['default_mismatch']);
  });

  test('value lists without enum are reported', () => {
    const scale = '最小震度 (10=震度1, 20=震度2, 30=震度3)';
    expect(kinds([limit({ description: scale })])).toEqual(['enum_missing']);
    expect(kinds([limit({ description: scale, enum: [10, 20, 30] })])).toEqual([]);
    const mode: Param = { surface: 'rest', owner: 'POST /x', path: 'mode', schema: { type: 'string', description: '"auto"(自動), "fast"(静的)' } };
    expect(kinds([mode])).toEqual(['enum_missing']);
  });

  test('safe-integer bounds and documented ranges must be explicit', () => {
    expect(kinds([limit({ maximum: SAFE })])).toEqual(['unbounded_integer']);
    expect(kinds([limit({ minimum: undefined, maximum: undefined, description: '件数 (1〜30)' })])).toEqual(['range_mismatch']);
    const urls: Param = { surface: 'rest', owner: 'POST /x', path: 'urls', schema: { type: 'array', items: { type: 'string' }, description: 'URL 配列 (最大20件)' } };
    expect(kinds([urls])).toEqual(['range_mismatch']);
  });

  test('MCP tool and REST twin must agree; allowlist suppresses with a reason', () => {
    const mcp: Param = { surface: 'mcp', owner: 'tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 30 } };
    const rest: Param = { surface: 'rest', owner: 'POST /tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 20 } };
    const pairs = { tool: { method: 'POST', path: '/tool' } };
    expect(kinds([mcp, rest], pairs)).toEqual(['pair_mismatch']);
    expect(kinds([mcp, rest], pairs, { 'pair_mismatch tool limit': 'intentional' })).toEqual([]);
  });
});

describe('noteKeyPaths', () => {
  test('reads nested keys of a 返却 note as paths', () => {
    expect(noteKeyPaths('{ query, suggestions: [...] }')).toEqual(['query', 'suggestions']);
    expect(noteKeyPaths('{ routes: [{ index, totalTime }], note }')).toEqual(['routes', 'routes[].index', 'routes[].totalTime', 'note']);
    expect(noteKeyPaths('{ found, detail: { text, author }, items?: [{ id, plans: [{ planId }] }] }')).toEqual([
      'found', 'detail', 'detail.text', 'detail.author', 'items', 'items[].id', 'items[].plans', 'items[].plans[].planId',
    ]);
  });
});

describe('README examples', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'number' },
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, meta: { type: 'object' } } } },
    },
  };
  const doc = {
    paths: {
      '/things/{id}': {
        post: {
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { q: { type: 'string' } } } } } },
          responses: { '200': { content: { 'application/json': { schema } } } },
        },
      },
    },
  };

  test('reports example keys the schema does not declare, including nested ones', () => {
    expect(missingExampleKeys({ count: 1, items: [{ id: 'a', meta: { free: 1 }, extra: 2 }], total: 3 }, schema))
      .toEqual(['.items[].extra', '.total']);
  });

  test('checks request and response examples under the endpoint of their section', () => {
    const md = [
      '### Things (`POST /things/1`)',
      '- **リクエスト**:',
      '```json',
      '{ "q": "x", "limit": 2 }',
      '```',
      '- **レスポンス例**:',
      '```json',
      '{ "count": 1, "items": [ ... ], "rank": 1 }',
      '```',
    ].join('\n');
    expect(checkReadmeExamples(md, doc).map((f) => `${f.kind} ${f.detail}`)).toEqual([
      'request POST /things/1: limit',
      'response POST /things/1: .rank',
    ]);
  });

  test('a response example that cannot be parsed or matched is a finding', () => {
    const md = ['### Other (`GET /missing`)', '- **レスポンス例**:', '```json', '{ "a": 1 }', '```', '- **レスポンス例**:', '```json', '{ broken', '```'].join('\n');
    expect(checkReadmeExamples(md, doc).map((f) => f.detail)).toEqual([
      'no OpenAPI operation for GET /missing',
      'unparseable JSON (GET /missing)',
    ]);
  });
});
