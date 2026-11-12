// E1: ページ（about:blank）から、127.0.0.1 への fetch・WebSocket・遷移が届くか（2026-11-12 の実測。結果は設計書の「実測」）
// 実行: README.md の「実行のしかた」
import { getBrowser, closeSharedBrowser } from '../src/browser_engine.js';
const hits: string[] = [];
const server = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req, srv) { hits.push(`http ${new URL(req.url).pathname} upgrade=${req.headers.get('upgrade') ?? '-'}`); if (srv.upgrade(req)) return undefined; return new Response('hello from loopback', { headers: { 'access-control-allow-origin': '*' } }); },
  websocket: { open() { hits.push('ws-open'); }, message() {} },
});
const port = server.port;
console.log('proxy env in container:', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /proxy/i.test(k)))));
console.log('bun self-fetch:', await (await fetch(`http://127.0.0.1:${port}/self`)).text());
const { browser } = await getBrowser();
const context = await browser.createBrowserContext();
const page = await context.newPage();
const nav = await page.goto(`http://127.0.0.1:${port}/nav`, { timeout: 15000 }).then((r) => `status ${r?.status()}`, (e) => `error ${String(e).slice(0, 80)}`);
console.log('navigation to loopback:', nav);
// 別オリジン（about:blank）から: CORS 許可ヘッダ付きのサーバーなので、fetch は届けば読める
await page.goto('about:blank');
const result = await page.evaluate(async (p: number) => {
  const out: Record<string, string> = {};
  try { const res = await fetch(`http://127.0.0.1:${p}/cross-fetch`); out.fetch = `status ${res.status}`; } catch (e) { out.fetch = `error: ${String(e).slice(0, 80)}`; }
  out.ws = await new Promise<string>((resolve) => { const s = new WebSocket(`ws://127.0.0.1:${p}/cross-ws`); const t = setTimeout(() => resolve('timeout'), 4000); s.onopen = () => { clearTimeout(t); resolve('OPEN'); s.close(); }; s.onerror = () => { clearTimeout(t); resolve('error'); }; });
  return out;
}, port);
console.log('from about:blank:', JSON.stringify(result));
console.log('loopback server saw:', JSON.stringify(hits));
await closeSharedBrowser(); server.stop(true); process.exit(0);
