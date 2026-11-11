import { describe, expect, test } from 'bun:test';
import { generateClient, type OpenApiDoc, type ToolMeta } from './render.js';

const emptyOp = { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } };
const doc: OpenApiDoc = {
  paths: {
    '/gov/law-text': { post: emptyOp },
    '/intelligence/context/{contextId}/evidence': { get: emptyOp },
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

  test('a tool with several routes gets one module with one function per route: the first named after the tool, the others by method and path', () => {
    const watch: ToolMeta = { name: 'watch', category: 'watch', description: 'watch', keywords: [] };
    const multi = generateClient(doc, { watch: [{ method: 'GET', path: '/watch/list' }, { method: 'DELETE', path: '/watch/:id' }] }, [watch]);
    const module = multi['servers/sora/watch.ts'];
    expect(module).toContain('export function watch(): Promise<WatchOutput>');
    expect(module).toContain('export function deleteWatchId(input: DeleteWatchIdInput): Promise<DeleteWatchIdOutput>');
    expect(module).toContain("callSora<DeleteWatchIdOutput>({ method: 'DELETE', path: '/watch/:id' }, input)");
    expect(module.match(/^import /gm)).toHaveLength(1);
    const catalog = JSON.parse(multi['catalog.json']);
    expect(catalog.map((t: { name: string; fn: string }) => `${t.name}.${t.fn}`)).toEqual(['watch.watch', 'watch.deleteWatchId']);
    expect(catalog[1]).toMatchObject({ method: 'DELETE', path: '/watch/:id', file: 'servers/sora/watch.ts' });
    expect(multi['servers/sora/index.ts'].match(/export \*/g)).toHaveLength(1);
  });
});

describe('generateClient function names', () => {
  const meta = (name: string): ToolMeta => ({ name, category: 'test', description: name, keywords: [] });
  const fnsOf = (files: Record<string, string>): string[] => JSON.parse(files['catalog.json']).map((t: { fn: string }) => t.fn);
  const errorOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  test('a route fn replaces the default name in the module, its types and the catalog', () => {
    const files = generateClient(doc, { search_web: { method: 'POST', path: '/search/web', fn: 'findWeb' } }, [meta('search_web')]);
    const module = files['servers/sora/search_web.ts'];
    expect(module).toContain('export function findWeb(input: FindWebInput): Promise<FindWebOutput>');
    expect(module).not.toContain('searchWeb');
    expect(JSON.parse(files['catalog.json'])[0]).toMatchObject({ name: 'search_web', fn: 'findWeb' });
  });

  test('with several routes the first is named after the tool unless it has an fn; the others use their fn', () => {
    const second = { method: 'POST', path: '/gov/law-text', fn: 'getLawText' };
    const plain = generateClient(doc, { search_laws: [{ method: 'POST', path: '/search/web' }, second] }, [meta('search_laws')]);
    expect(fnsOf(plain)).toEqual(['searchLaws', 'getLawText']);
    const named = generateClient(doc, { search_laws: [{ method: 'POST', path: '/search/web', fn: 'findLaws' }, second] }, [meta('search_laws')]);
    expect(fnsOf(named)).toEqual(['findLaws', 'getLawText']);
  });

  test('a later route without fn is named by method and path; hyphens and :params become camelCase', () => {
    const files = generateClient(doc, {
      search_laws: [{ method: 'POST', path: '/search/web' }, { method: 'POST', path: '/gov/law-text' }],
      get_country_context: [{ method: 'GET', path: '/intelligence/context/:contextId' }, { method: 'GET', path: '/intelligence/context/:contextId/evidence' }],
    }, [meta('search_laws'), meta('get_country_context')]);
    expect(fnsOf(files)).toEqual(['getCountryContext', 'getIntelligenceContextContextIdEvidence', 'searchLaws', 'postGovLawText']);
    expect(files['servers/sora/get_country_context.ts']).toContain('export function getIntelligenceContextContextIdEvidence(input: GetIntelligenceContextContextIdEvidenceInput)');
  });

  test('two functions with the same name fail the generation and name both owners', () => {
    const across = errorOf(() => generateClient(doc, {
      search_web: { method: 'POST', path: '/search/web' },
      search_laws: { method: 'POST', path: '/gov/law-text', fn: 'searchWeb' },
    }, [meta('search_web'), meta('search_laws')]));
    expect(across).toContain('"searchWeb"');
    expect(across).toContain('search_web (POST /search/web)');
    expect(across).toContain('search_laws (POST /gov/law-text)');
    const inside = errorOf(() => generateClient(doc, {
      watch: [{ method: 'GET', path: '/watch/list' }, { method: 'DELETE', path: '/watch/:id', fn: 'watch' }],
    }, [meta('watch')]));
    expect(inside).toContain('"watch"');
    expect(inside).toContain('watch (GET /watch/list)');
    expect(inside).toContain('watch (DELETE /watch/:id)');
  });

  test('a tool with several routes fails when any one is missing from the OpenAPI document, naming the tool and the route', () => {
    const present = { method: 'POST', path: '/search/web' };
    const missing = { method: 'POST', path: '/nope' };
    for (const routes of [[present, missing], [missing, present]]) {
      const message = errorOf(() => generateClient(doc, { search_laws: routes }, [meta('search_laws')]));
      expect(message).toContain('search_laws');
      expect(message).toContain('POST /nope');
    }
  });
});
