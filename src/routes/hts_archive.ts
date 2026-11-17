import { type Context, Hono } from 'hono';
import { isModuleActive } from '../mcp/registry.js';
import { ARCHIVE_ID_PATTERN, readArchivedRelease, readArchiveIndex } from '../services/hts_archive.js';
import { formatError } from './utils.js';

const moduleDisabled = (c: Context) =>
  formatError(c, 'hts-archive module is not enabled. Add it to SORA_MODULES by name (e.g. SORA_MODULES=all,hts-archive); "all" alone does not include it.', 'MODULE_DISABLED', 404, false);

/** HTS の版の保存（GET /trade/hts/releases, GET /trade/hts/releases/:id）。モジュール 'hts-archive' を SORA_MODULES に名前で挙げたときだけ応答する。 */
export const htsArchiveRoutes = new Hono();

htsArchiveRoutes.get('/trade/hts/releases', (c) => (isModuleActive('hts-archive') ? c.json(readArchiveIndex()) : moduleDisabled(c)));

htsArchiveRoutes.get('/trade/hts/releases/:id', async (c) => {
  if (!isModuleActive('hts-archive')) return moduleDisabled(c);
  const id = c.req.param('id');
  if (!ARCHIVE_ID_PATTERN.test(id)) return formatError(c, 'id must match ^[0-9A-Za-z_-]{1,80}$', 'INVALID_INPUT', 400, false);
  const gz = readArchivedRelease(id);
  if (!gz) return formatError(c, `HTS release not archived: ${id}`, 'NOT_FOUND', 404, false);
  // 保存した gzip は、受け取れる相手にはそのまま返す（約 12MB を毎回展開しない）
  if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
    return c.body(gz, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' });
  }
  // 受け取れない相手には、ストリームで解凍して返す（同期の Bun.gunzipSync は、解凍の間イベントループを止め、展開後の全体を、リクエストのたびにメモリへ置く）。
  // 壊れた gzip は、200 を送り始める前に分かるよう、最初の塊だけ読んでから返す（以前は、gunzipSync の例外で 500）
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    first = await reader.read();
  } catch {
    return formatError(c, `HTS release could not be decompressed: ${id}`, 'ARCHIVE_ERROR', 500, false);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(first.value);
      else controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' });
});
