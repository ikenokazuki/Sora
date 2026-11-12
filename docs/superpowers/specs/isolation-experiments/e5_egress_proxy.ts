// E5: 出口プロキシの試作（実行: README.md）。本番の実装ではない: CONNECT だけ（http:// の転送は 405 で断る）、IP の判定は粗い
// Chromium は --proxy-server でこれだけを使い、ループバックも --proxy-bypass-list=<-loopback> でプロキシに通す。
// --host-resolver-rules で、ブラウザ自身の名前解決は全部失敗させる（直接の解決・接続の抜け道を塞ぐ）。
import dns from 'node:dns/promises';
import net from 'node:net';
import puppeteer from 'puppeteer-core';

const isPrivate = (ip: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|198\.1[89]\.|2(2[4-9]|[3-5]\d)\.)/.test(ip) ||
  /^(::1?$|fe80|fc|fd|::ffff:(127\.|10\.|192\.168\.|169\.254\.))/i.test(ip);
const log: string[] = [];
const proxy = net.createServer((client) => {
  client.once('data', async (buf) => {
    const line = buf.toString('latin1').split('\r\n')[0];
    const m = line.match(/^CONNECT ([^ ]+):(\d+) HTTP\/1\.[01]$/);
    if (!m) { log.push(`deny non-CONNECT: ${line.slice(0, 40)}`); client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
    const host = m[1].replace(/^\[|\]$/g, ''); const port = Number(m[2]);
    try {
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
      if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) { log.push(`DENY ${host}:${port} -> ${addrs.map((a) => a.address).join(',')}`); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const target = net.connect({ host: addrs[0].address, port }, () => { log.push(`ok   ${host}:${port} -> ${addrs[0].address}`); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); target.pipe(client); client.pipe(target); });
      target.on('error', () => client.destroy()); client.on('error', () => target.destroy());
    } catch (e) { log.push(`DENY(dns fail, closed) ${host}`); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
  });
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = (proxy.address() as net.AddressInfo).port;

const hits: string[] = [];
const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { hits.push(new URL(req.url).pathname); return new Response('LOCAL SECRET'); } });

const browser = await puppeteer.launch({
  executablePath: '/usr/lib/chromium/chromium', headless: true, pipe: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--user-data-dir=/tmp/ud-e5', `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'],
});
const out: Record<string, string> = {};
const visit = async (label: string, url: string) => {
  const page = await browser.newPage();
  try { const r = await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' }); out[label] = `status ${r?.status()} title=${JSON.stringify(await page.title())}`; }
  catch (e) { out[label] = `blocked/error: ${String(e).slice(0, 70)}`; }
  await page.close();
};
await visit('public https (example.com)', 'https://example.com/');
await visit('loopback by IP', `http://127.0.0.1:${local.port}/ip`);
await visit('loopback by name', `http://localhost:${local.port}/name`);
await visit('metadata IP', 'http://169.254.169.254/latest/meta-data/');
console.log(JSON.stringify({ results: out, proxyLog: log, loopbackServerSaw: hits }, null, 2));
await browser.close(); proxy.close(); local.stop(true); process.exit(0);
