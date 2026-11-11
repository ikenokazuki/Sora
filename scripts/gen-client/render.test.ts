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
  watch: [{ method: 'GET', path: '/watch/list', fn: 'watchList' }, { method: 'DELETE', path: '/watch/:id', fn: 'watchDelete' }],
  search_tools: null,
};
const tools: ToolMeta[] = [
  { name: 'search_web', category: 'web', description: '【Web検索】URL一覧', keywords: ['検索'] },
  { name: 'get_country_context', category: 'intel', description: 'ctx', keywords: [] },
  { name: 'watch', category: 'watch', description: 'watch', keywords: [] },
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
    expect(files['servers/sora/watch.ts']).toContain('export function watchList(): Promise<WatchListOutput>');
    expect(files['servers/sora/watch.ts']).toContain('export function watchDelete(input: WatchDeleteInput): Promise<WatchDeleteOutput>');
    expect(files['servers/sora/watch.ts']).toContain('id: string;');
  });

  test('tools without a REST route are skipped; unresolved ones fail the generation', () => {
    expect(files['servers/sora/search_tools.ts']).toBeUndefined();
    expect(() => generateClient(doc, { ...rest, search_web: { method: 'POST', path: '/nope' } }, tools)).toThrow(/search_web/);
    expect(() => generateClient(doc, rest, [...tools, { name: 'ghost', category: 'web', description: '', keywords: [] }])).toThrow(/ghost/);
  });

  test('catalog, manifest and index list the same generated tools in a fixed order', () => {
    const catalog = JSON.parse(files['catalog.json']);
    expect(catalog.map((t: { name: string; fn: string }) => `${t.name}.${t.fn}`)).toEqual(['get_country_context.getCountryContext', 'search_web.searchWeb', 'watch.watchList', 'watch.watchDelete']);
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

  test('each function is documented by its own REST operation (summary, then description), not by the merged MCP description', () => {
    const json = { 200: { content: { 'application/json': { schema: { type: 'object' } } } } };
    const ops: OpenApiDoc = {
      paths: {
        '/watch/list': { get: { summary: '監視の一覧 */ 取得', responses: json } },
        '/watch/{id}': { delete: { summary: '監視の削除', description: '以後の監視を止める。\n  id は一覧で確認', responses: json } },
        '/gov/law-text': { post: { responses: json } },
        '/search/web': { post: { summary: 'Web 検索', responses: json } },
        '/gov/laws': { post: { description: '法令の一覧', responses: json } },
      },
    };
    const watch: ToolMeta = { name: 'watch', category: 'watch', description: 'action で選ぶ。返却: register は { target }', keywords: [] };
    const law: ToolMeta = { name: 'search_laws', category: 'gov', description: '【法令】keyword か lawId', keywords: [] };
    const web: ToolMeta = { name: 'search_web', category: 'web', description: '【Web検索】MCP の説明', keywords: [] };
    const diet: ToolMeta = { name: 'search_diet', category: 'gov', description: '【国会】MCP の説明', keywords: [] };
    const files = generateClient(ops, {
      watch: [{ method: 'GET', path: '/watch/list', fn: 'watchList' }, { method: 'DELETE', path: '/watch/:id', fn: 'watchDelete' }],
      search_laws: { method: 'POST', path: '/gov/law-text' },
      search_web: { method: 'POST', path: '/search/web' },
      search_diet: { method: 'POST', path: '/gov/laws' },
    }, [watch, law, web, diet]);
    const module = files['servers/sora/watch.ts'];
    expect(module).toContain('/** 監視の一覧 * / 取得 */\nexport function watchList()');
    expect(module).toContain('/** 監視の削除 以後の監視を止める。 id は一覧で確認 */\nexport function watchDelete(');
    expect(module).not.toContain('action で選ぶ');
    // 1 つのルートのツールも、操作の文（summary だけ・description だけでも）
    expect(files['servers/sora/search_web.ts']).toContain('/** Web 検索 */\nexport function searchWeb()');
    expect(files['servers/sora/search_diet.ts']).toContain('/** 法令の一覧 */\nexport function searchDiet()');
    // 操作に説明が無いときだけ、ツールの説明を使う
    expect(files['servers/sora/search_laws.ts']).toContain('/** 【法令】keyword か lawId */');
    // catalog.json は、ツールの説明のまま（ツールの検索に使う）
    expect(JSON.parse(files['catalog.json']).map((row: { name: string; description: string }) => `${row.name}: ${row.description}`)).toEqual([
      `search_diet: ${diet.description}`, `search_laws: ${law.description}`, `search_web: ${web.description}`, `watch: ${watch.description}`, `watch: ${watch.description}`,
    ]);
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
