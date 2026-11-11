// src/tls_trust.test.ts が子プロセスで走らせる。環境変数は、起動時に決まる（wreq-js の native は、起動時の環境を読む）。
import { getOrCreateHttpSession, pickBrowserProfile } from '../../http_fetcher.js';

const dir = new URL('.', import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  tls: { cert: Bun.file(`${dir}leaf.pem`), key: Bun.file(`${dir}leaf.key`) },
  fetch: () => new Response('ok'),
});
const session = await getOrCreateHttpSession('127.0.0.1', pickBrowserProfile());
try {
  const response = await session.fetch(`https://127.0.0.1:${server.port}/`, { timeout: 8000 });
  console.log(`RESULT ok ${response.status}`);
} catch (error) {
  const message = String((error as Error).message);
  console.log(`RESULT rejected ${/CERTIFICATE_VERIFY_FAILED/.test(message) ? 'CERTIFICATE_VERIFY_FAILED' : message}`);
}
process.exit(0);
