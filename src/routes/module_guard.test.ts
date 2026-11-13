import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { app } from '../index.js';
import { isRestModuleActive, moduleOfOperation, OTHER_OPERATIONS, REST_TOOLS } from '../rest_operations.js';
import { generateOpenApiDocument } from '../types.js';
import { restModuleGuard } from './module_guard.js';

/**
 * REST の経路も、SORA_MODULES で絞ったモジュールに従う（設計 5。穴 20。ユーザーの決定: standard でも入れる）。
 * これまで、REST は lyrics・shazam・hts-archive しかモジュールを確かめず、SORA_MODULES=web にしても、/watch/*・/trade/* などが開いたままだった
 * （MCP のツールだけが隠れた）。経路とモジュールの対応は、操作の台帳（rest_operations.ts）を使う。
 */

const previous = process.env.SORA_MODULES;
afterEach(() => {
  if (previous === undefined) delete process.env.SORA_MODULES;
  else process.env.SORA_MODULES = previous;
});
const modules = (value: string | undefined) => {
  if (value === undefined) delete process.env.SORA_MODULES;
  else process.env.SORA_MODULES = value;
};

describe('moduleOfOperation: 経路が属するモジュール（台帳から）', () => {
  test('正本の操作は、台帳のカテゴリ', () => {
    for (const tool of REST_TOOLS) expect(moduleOfOperation(tool.method, tool.path), tool.id).toBe(tool.category);
  });

  test('別名・GET の形・進行状況の SSE は、正本のカテゴリ', () => {
    const byId = new Map(REST_TOOLS.map((tool) => [tool.id, tool.category]));
    for (const [key, other] of Object.entries(OTHER_OPERATIONS)) {
      const [method, path] = key.split(' ');
      if (other.of) expect(moduleOfOperation(method, path), key).toBe(byId.get(other.of));
    }
    expect(moduleOfOperation('POST', '/action')).toBe('browser');
    expect(moduleOfOperation('GET', '/weather/{city}')).toBe('life');
    expect(moduleOfOperation('POST', '/crawl/stream')).toBe('web');
  });

  test('システム・ページ・台帳に無い経路は、モジュールに属さない（検査しない）', () => {
    for (const [method, path] of [['GET', '/health'], ['GET', '/'], ['POST', '/cache/clear'], ['GET', '/t/{carrier}/{number}'], ['GET', '/tools'], ['GET', '/nothing'], ['GET', '/openapi.json']]) {
      expect(moduleOfOperation(method, path), `${method} ${path}`).toBeUndefined();
    }
  });

  test('Hono の経路の書き方（:id）も、台帳の書き方（{id}）として引ける。メソッドの大文字小文字は区別しない', () => {
    expect(moduleOfOperation('DELETE', '/watch/:id')).toBe('watch');
    expect(moduleOfOperation('delete', '/watch/{id}')).toBe('watch');
    expect(moduleOfOperation('GET', '/intelligence/context/:contextId/evidence')).toBe('intel');
  });

  test('app の全部の経路が、台帳にあるか、モジュールを持たない公開の文書の経路（経路を足したら、台帳にも足す。足さないと、検査をすり抜ける）', () => {
    const documents = new Set(['/openapi.json', '/docs', '/swagger']);
    const unknown: string[] = [];
    for (const route of app.routes) {
      if (route.method === 'ALL') continue; // 全体にかかるミドルウェアと、MCP の通り道（/mcp・/sse・/message。MCP は、ツールの登録がモジュールを見る）
      const covered = moduleOfOperation(route.method, route.path) !== undefined || [...REST_TOOLS.map((t) => `${t.method} ${t.path}`), ...Object.keys(OTHER_OPERATIONS)].includes(`${route.method} ${route.path.replace(/:([A-Za-z_]\w*)/g, '{$1}')}`);
      if (!covered && !documents.has(route.path)) unknown.push(`${route.method} ${route.path}`);
    }
    expect(unknown).toEqual([]);
  });
});

describe('isRestModuleActive', () => {
  test('既定（all）では、all に含まれるモジュールが有効で、名前を挙げたときだけのものは無効', () => {
    modules(undefined);
    for (const name of ['web', 'browser', 'yahoo', 'life', 'disaster', 'watch', 'music', 'gov', 'trade', 'media', 'intel', 'youtube']) expect(isRestModuleActive(name), name).toBe(true);
    for (const name of ['lyrics', 'shazam', 'hts-archive']) expect(isRestModuleActive(name), name).toBe(false);
  });

  test('絞ると、名前を挙げたものだけ有効。media は、web でも有効（MCP のツールの登録と同じ）', () => {
    modules('web,watch');
    expect(isRestModuleActive('web')).toBe(true);
    expect(isRestModuleActive('watch')).toBe(true);
    expect(isRestModuleActive('trade')).toBe(false);
    expect(isRestModuleActive('media')).toBe(true);
    modules('gov');
    expect(isRestModuleActive('media')).toBe(false);
    modules('media');
    expect(isRestModuleActive('media')).toBe(true);
    expect(isRestModuleActive('web')).toBe(false);
  });
});

describe('REST の経路: 無効なモジュールは 404（MODULE_DISABLED）', () => {
  const get = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

  test('SORA_MODULES=web: web の経路は通り、ほかのモジュールの経路は閉じる', async () => {
    modules('web');
    for (const [method, path] of [['GET', '/watch/list'], ['POST', '/trade/hts-verify'], ['POST', '/weather'], ['GET', '/weather'], ['POST', '/gov/laws'], ['POST', '/intelligence/country'], ['POST', '/search/image'], ['POST', '/youtube/transcript'], ['POST', '/browser/action'], ['POST', '/action'], ['DELETE', '/watch/wt_1'], ['GET', '/intelligence/context/abc/evidence']] as const) {
      const res = await (method === 'POST' ? post(path) : get(path, { method }));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await code(res), `${method} ${path}`).toBe('MODULE_DISABLED');
    }
    // web の経路は、モジュールで止まらない（入力が空なので 400 など。404 の MODULE_DISABLED ではない）
    for (const path of ['/scrape', '/crawl', '/map', '/search/deep', '/search/web']) {
      const res = await post(path);
      expect(await code(res), path).not.toBe('MODULE_DISABLED');
    }
  });

  test('media は、web でも通る', async () => {
    modules('web');
    expect(await code(await post('/media/inspect-image'))).not.toBe('MODULE_DISABLED');
    modules('gov');
    expect(await code(await post('/media/inspect-image'))).toBe('MODULE_DISABLED');
  });

  test('システムとモジュールを持たない経路は、絞っても開いたまま', async () => {
    modules('web');
    expect((await get('/health')).status).toBe(200);
    expect((await get('/')).status).toBe(200);
    expect((await get('/openapi.json')).status).toBe(200);
    expect((await post('/cache/clear')).status).toBe(200);
    expect((await get('/tools')).status).toBe(200);
  });

  test('既定（all）では、これまでどおり、どの経路も通る', async () => {
    modules(undefined);
    for (const [method, path] of [['GET', '/watch/list'], ['POST', '/trade/hts-verify'], ['POST', '/weather']] as const) {
      const res = await (method === 'POST' ? post(path) : get(path));
      expect(await code(res), `${method} ${path}`).not.toBe('MODULE_DISABLED');
    }
  });

  test('名前を挙げたときだけのモジュールは、これまでどおり（lyrics は all だけでは閉じる。名前を挙げると通る）', async () => {
    modules('all');
    expect(await code(await post('/lyrics'))).toBe('MODULE_DISABLED');
    modules('all,lyrics');
    expect(await code(await post('/lyrics'))).not.toBe('MODULE_DISABLED');
  });

  test('処理のあとに登録された全体のミドルウェア（ALL）があっても、処理の経路を取り違えない', async () => {
    const probe = new Hono();
    probe.use('*', restModuleGuard);
    probe.get('/watch/list', (c) => c.text('処理まで届いた'));
    probe.use('*', async (_c, next) => next()); // 経路の一覧では、処理の次に並ぶ
    modules('web');
    expect((await probe.request('/watch/list')).status).toBe(404);
    modules(undefined);
    expect(await (await probe.request('/watch/list')).text()).toBe('処理まで届いた');
  });

  test('閉じた経路でも、鍵のない要求は 401（認証のあとに検査する。鍵のない要求に、設定を教えない）', async () => {
    modules('web');
    const previousKey = process.env.SORA_API_KEY;
    process.env.SORA_API_KEY = 'module-guard-order-key-0123456789';
    try {
      const noKey = await get('/watch/list');
      expect(noKey.status).toBe(401);
      const withKey = await get('/watch/list', { headers: { 'X-API-Key': 'module-guard-order-key-0123456789' } });
      expect(withKey.status).toBe(404);
      expect(await code(withKey)).toBe('MODULE_DISABLED');
    } finally {
      if (previousKey === undefined) delete process.env.SORA_API_KEY;
      else process.env.SORA_API_KEY = previousKey;
    }
  });

  test('末尾のスラッシュなどの別の書き方は、経路に当たらず 404 のまま（検査をすり抜けて処理に届かない）', async () => {
    modules('web');
    const res = await get('/watch/list/');
    expect(res.status).toBe(404);
  });
});

describe('OpenAPI と /tools も、絞ったモジュールに従う（文書に載るのに 404 になる経路を作らない）', () => {
  const paths = () => Object.keys(generateOpenApiDocument().paths);

  test('SORA_MODULES=web: 閉じた経路は載らず、web・media・システムの経路は載る', () => {
    modules('web');
    const list = paths();
    for (const path of ['/watch/list', '/watch/register', '/trade/hts-verify', '/weather', '/gov/laws', '/browser/action']) expect(list, path).not.toContain(path);
    for (const path of ['/scrape', '/crawl', '/search/deep', '/media/inspect-image', '/health', '/cache/clear']) expect(list, path).toContain(path);
  });

  test('既定（all）の文書は、これまでと同じ（閉じた経路は無い）', () => {
    modules(undefined);
    const list = paths();
    for (const path of ['/watch/list', '/trade/hts-verify', '/weather', '/scrape', '/health']) expect(list, path).toContain(path);
  });
});
