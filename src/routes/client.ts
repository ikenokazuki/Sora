import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';

/**
 * 生成済みクライアント（client/）を読み取り専用で配る。
 * 配るのは client/manifest.json に載ったファイルだけ。パスは一覧との完全一致で照合するので、
 * `..` や絶対パスは一覧に無く、ディスクには触れない。
 */
// ソース実行（src/routes/）と、イメージ内のバンドル（/app/server.js）で client/ の相対位置が違う。
const CLIENT_DIRS = [new URL('../../client/', import.meta.url), new URL('./client/', import.meta.url)];

async function readClientFile(path: string): Promise<string> {
  let lastError: unknown;
  for (const dir of CLIENT_DIRS) {
    try {
      return await readFile(new URL(path, dir), 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function listedFiles(): Promise<Set<string>> {
  const manifest = JSON.parse(await readClientFile('manifest.json')) as { files: string[] };
  return new Set(['manifest.json', ...manifest.files]);
}

const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: 'Not found', code: 'NOT_FOUND', status: 404, retryable: false }, 404);

export const clientRoutes = new Hono();

clientRoutes.get('/client', async (c) => {
  try {
    return c.body(await readClientFile('manifest.json'), 200, { 'Content-Type': 'application/json; charset=utf-8' });
  } catch {
    return notFound(c);
  }
});

clientRoutes.get('/client/*', async (c) => {
  // 生のパスを使う（%2e%2e を勝手に解決させない）。
  const path = new URL(c.req.url).pathname.slice('/client/'.length);
  try {
    if (!(await listedFiles()).has(path)) return notFound(c);
    const type = path.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    return c.body(await readClientFile(path), 200, { 'Content-Type': type });
  } catch {
    return notFound(c);
  }
});
