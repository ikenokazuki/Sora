// E6（実行: README.md）。Bun の fetch が、実行中に設定した HTTPS_PROXY・HTTP_PROXY・NO_PROXY と、proxy オプションを守るか
import net from 'node:net';
const log: string[] = [];
const proxy = net.createServer((client) => {
  client.once('data', (buf) => {
    const line = buf.toString('latin1').split('\r\n')[0];
    log.push(line.slice(0, 60));
    client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); // どの宛先も断る（届いたかだけを見る）
  });
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const p = (proxy.address() as net.AddressInfo).port;
const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Response('LOCAL'); } });
const tryFetch = async (label: string, url: string, init?: RequestInit) => {
  const before = log.length;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), ...init }).then((x) => `status ${x.status}`, (e) => `error ${String(e).slice(0, 50)}`);
  console.log(`${label}: ${r} / proxy に届いた: ${log.length - before}`);
};
// (1) 環境変数を、最初の fetch の「あと」に設定する（起動後の設定が効くか）
await tryFetch('1. 環境変数なし（直接）', 'https://example.com/');
process.env.HTTPS_PROXY = `http://127.0.0.1:${p}`; process.env.HTTP_PROXY = `http://127.0.0.1:${p}`;
await tryFetch('2. HTTPS_PROXY を後から設定 → https', 'https://example.com/');
await tryFetch('3. HTTP_PROXY を後から設定 → http', 'http://example.com/');
await tryFetch('4. ループバック（NO_PROXY なし）', `http://127.0.0.1:${local.port}/`);
process.env.NO_PROXY = '127.0.0.1,localhost';
await tryFetch('5. ループバック（NO_PROXY=127.0.0.1）', `http://127.0.0.1:${local.port}/`);
delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY; delete process.env.NO_PROXY;
await tryFetch('6. 環境変数なし + proxy オプション → https', 'https://example.com/', { proxy: `http://127.0.0.1:${p}` } as RequestInit);
console.log('proxy log:', JSON.stringify(log));
proxy.close(); local.stop(true); process.exit(0);
