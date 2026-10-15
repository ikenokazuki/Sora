import { describe, expect, test } from 'bun:test';
import { generateClient, type OpenApiDoc, type ToolMeta } from './render.js';

const doc: OpenApiDoc = {
  paths: {
    '/search/web': {
      post: {
        summary: 'web search',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } } },
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'string' } } }, required: ['results'] } } } } },
      },
    },
    '/intelligence/context/{contextId}': {
      get: {
        parameters: [
          { name: 'contextId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/watch/list': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } } },
    '/watch/{id}': { delete: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } } },
  },
};
const rest = {
  search_web: { method: 'POST', path: '/search/web' },
  get_country_context: { method: 'GET', path: '/intelligence/context/:contextId' },
  watch_list: { method: 'GET', path: '/watch/list' },
  watch_delete: { method: 'DELETE', path: '/watch/:id' },
  search_tools: null,
};
const tools: ToolMeta[] = [
  { name: 'search_web', category: 'web', description: '【Web検索】URL一覧', keywords: ['検索'] },
  { name: 'get_country_context', category: 'intel', description: 'ctx', keywords: [] },
  { name: 'watch_list', category: 'watch', description: 'list', keywords: [] },
  { name: 'watch_delete', category: 'watch', description: 'del', keywords: [] },
  { name: 'search_tools', category: 'web', description: 'meta', keywords: [] },
];

describe('generateClient', () => {
  const files = generateClient(doc, rest, tools);

  test('POST tools take the body type; GET tools merge path and query params', () => {
    const post = files['servers/sora/search_web.ts'];
    expect(post).toContain('export function searchWeb(input: SearchWebInput): Promise<SearchWebOutput>');
    expect(post).toContain("callSora<SearchWebOutput>({ method: 'POST', path: '/search/web' }, input)");
    expect(post).toContain('query: string;');
    const get = files['servers/sora/get_country_context.ts'];
    expect(get).toContain('contextId: string;');
    expect(get).toContain('cursor?: string;');
    expect(get).toContain("path: '/intelligence/context/:contextId'");
  });

  test('a tool without input takes no argument; :id path params exist on DELETE', () => {
    expect(files['servers/sora/watch_list.ts']).toContain('export function watchList(): Promise<WatchListOutput>');
    expect(files['servers/sora/watch_delete.ts']).toContain('id: string;');
  });

  test('tools without a REST route are skipped; unresolved ones fail the generation', () => {
    expect(files['servers/sora/search_tools.ts']).toBeUndefined();
    expect(() => generateClient(doc, { ...rest, search_web: { method: 'POST', path: '/nope' } }, tools)).toThrow(/search_web/);
    expect(() => generateClient(doc, rest, [...tools, { name: 'ghost', category: 'web', description: '', keywords: [] }])).toThrow(/ghost/);
  });

  test('catalog, manifest and index list the same generated tools in a fixed order', () => {
    const catalog = JSON.parse(files['catalog.json']);
    expect(catalog.map((t: { name: string }) => t.name)).toEqual(['get_country_context', 'search_web', 'watch_delete', 'watch_list']);
    expect(catalog[1]).toMatchObject({ name: 'search_web', fn: 'searchWeb', category: 'web', method: 'POST', path: '/search/web' });
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.files).toEqual(Object.keys(files).filter((f) => f !== 'manifest.json').sort());
    expect(files['servers/sora/index.ts']).toContain("export * from './search_web.js';");
    expect(generateClient(doc, rest, tools)).toEqual(files);
  });
});
