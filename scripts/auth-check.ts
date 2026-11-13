/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: 本物のアプリ（src/index.ts の app。認証のミドルウェア → MCP・REST のルート）を、
 * 本物の Bun.serve（本物の TCP・本物の接続元・本物の HTTP の読み取り）に載せて、認証の入口を叩く。
 *  (1) MCP の tenant は、認証が決めたものだけ: 同じ鍵は、X-API-Key でも Bearer（大文字小文字を問わない）でも同じ tenant。
 *      誤った Bearer と正しい X-API-Key を併せても通らない（以前は、認証は X-API-Key で通り、MCP は Bearer の任意の文字列で別の tenant になれた）
 *  (2) 鍵を持つ利用者と匿名（SORA_ALLOW_ANONYMOUS=true）は別の tenant。匿名どうしは、任意の Bearer を付けても同じ scope
 *  (3) X-Forwarded-For（SORA_AUTH_TRUST_PROXY=true）: 利用者が左に書いた 127.0.0.1 では、鍵なしの通過（SORA_AUTH_LOOPBACK_NO_KEY）に入れない。
 *      右から SORA_AUTH_PROXY_HOPS 番目だけを見る。X-Forwarded-For を 2 行に分けて送っても同じ（Bun が行を束ねる順序の確認）
 *  (4) SORA_AUTH_TRUST_PROXY なしでは、X-Forwarded-For が付いた要求は、直接の接続ではない
 * 待ち受けを 127.0.0.1 に固定するのは、接続元を IPv4 の 127.0.0.1 にそろえるため。src/index.ts の既定の待ち受け（hostname 無し）は、IPv4 の接続を
 * ::ffff:127.0.0.1 と報告し、isLoopbackAddress はその形をループバックと認めない（SORA_AUTH_LOOPBACK_NO_KEY は IPv4 の直接接続に効かない。設計書 E21）。
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/auth-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 4。E20・E21）
 */
import { connect } from 'node:net';
import { app, mcpSessionManager } from '../src/index.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// この確認の HTTP は、環境のプロキシを通さない（ループバックの本物のサーバーに、直接つなぐ）
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[name];

const KEY = 'auth-check-key-0123456789abcdef';

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request, srv) => app.fetch(request, { remoteAddr: srv.requestIP(request)?.address ?? null }),
});
const port = server.port as number;
const base = `http://127.0.0.1:${port}`;

const AUTH_ENV = ['SORA_API_KEY', 'SORA_ALLOW_ANONYMOUS', 'SORA_AUTH_LOOPBACK_NO_KEY', 'SORA_AUTH_TRUST_PROXY', 'SORA_AUTH_PROXY_HOPS'];

/** 認証の環境変数を、この場面のものに替えて fn を回す（認証は、要求のたびに環境を読む）。終わったら、セッションを捨てる */
async function scenario(label: string, vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  for (const name of AUTH_ENV) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: 例外: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    mcpSessionManager.clearAllSessions();
    for (const name of AUTH_ENV) delete process.env[name];
  }
}

const rpcHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2024-11-05' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'auth-check', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

const mcp = (headers: Record<string, string>, body: object, sessionId?: string) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify(body) });

async function open(headers: Record<string, string>, label: string): Promise<string> {
  const response = await mcp(headers, initialize);
  check(response.status === 200, `${label}: initialize が ${response.status}`);
  return response.headers.get('mcp-session-id') ?? '';
}

/** REST の保護された経路（GET /tools）の状態コード。headers は何行でも（同じ名前を 2 行にもできる）送る */
function rawStatus(headerLines: [string, string][]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('rawStatus: 時間切れ'));
    }, 10_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`GET /tools?q=auth-check HTTP/1.1\r\nHost: localhost\r\n${headerLines.map(([name, value]) => `${name}: ${value}\r\n`).join('')}Connection: close\r\n\r\n`));
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(received);
      if (status) resolve(Number(status[1]));
      else reject(new Error(`rawStatus: 状態行が無い: ${received.slice(0, 80)}`));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const tools = (headers: Record<string, string> = {}) => fetch(`${base}/tools?q=auth-check`, { headers }).then((response) => response.status);

// (1) 鍵あり。同じ鍵は、どの書き方でも同じ tenant
await scenario('鍵あり', { SORA_API_KEY: KEY }, async () => {
  const sessionId = await open({ 'X-API-Key': KEY }, '鍵あり X-API-Key');
  check(sessionId !== '', '鍵あり: セッションの ID が無い');
  for (const [label, headers] of [
    ['X-API-Key', { 'X-API-Key': KEY }],
    ['Bearer', { Authorization: `Bearer ${KEY}` }],
    ['bearer（小文字）', { Authorization: `bearer ${KEY}` }],
    ['BEARER（大文字）', { Authorization: `BEARER ${KEY}` }],
    ['bearer と、読まれない X-API-Key', { Authorization: `bearer ${KEY}`, 'X-API-Key': 'not-read-when-bearer-is-present' }],
  ] as [string, Record<string, string>][]) {
    const response = await mcp(headers, listTools, sessionId);
    check(response.status === 200, `鍵あり: 同じ鍵（${label}）で、セッションを続けられない: ${response.status}`);
  }
  for (const [label, headers] of [
    ['誤った bearer と正しい X-API-Key', { Authorization: 'bearer attacker-chosen-a', 'X-API-Key': KEY }],
    ['誤った Bearer と正しい X-API-Key', { Authorization: 'Bearer attacker-chosen-a', 'X-API-Key': KEY }],
    ['誤った bearer だけ', { Authorization: 'bearer wrong-key' }],
    ['鍵なし', {}],
  ] as [string, Record<string, string>][]) {
    const response = await mcp(headers, initialize);
    check(response.status === 401, `鍵あり: ${label} が通った: ${response.status}`);
  }
  check((await tools()) === 401, '鍵あり: 鍵なしの GET /tools が通った');
  check((await tools({ 'X-API-Key': KEY })) === 200, '鍵あり: 正しい鍵の GET /tools が通らない');
});

// (2) 鍵あり + 匿名を認める。鍵を持つ利用者と匿名は、別の tenant
await scenario('匿名を認める', { SORA_API_KEY: KEY, SORA_ALLOW_ANONYMOUS: 'true' }, async () => {
  const keyed = await open({ 'X-API-Key': KEY }, '匿名を認める 鍵あり');
  const anonymous = await open({ Authorization: 'bearer junk-token' }, '匿名を認める 匿名');
  for (const headers of [{}, { Authorization: 'bearer junk-token' }, { Authorization: 'bearer another-junk' }] as Record<string, string>[]) {
    const response = await mcp(headers, listTools, keyed);
    check(response.status === 404, `匿名を認める: 匿名の利用者が、鍵を持つ利用者のセッションを使えた: ${JSON.stringify(headers)} → ${response.status}`);
  }
  for (const headers of [{}, { Authorization: 'bearer another-junk' }] as Record<string, string>[]) {
    const response = await mcp(headers, listTools, anonymous);
    check(response.status === 200, `匿名を認める: 匿名どうしが、同じ scope にならない: ${JSON.stringify(headers)} → ${response.status}`);
  }
  check((await mcp({ 'X-API-Key': KEY }, listTools, anonymous)).status === 404, '匿名を認める: 鍵を持つ利用者が、匿名のセッションを使えた');
});

// (3) X-Forwarded-For。接続元（ソケット）は 127.0.0.1。SORA_AUTH_TRUST_PROXY=true で、右から数える
await scenario('プロキシ 1 段', { SORA_API_KEY: KEY, SORA_AUTH_LOOPBACK_NO_KEY: 'true', SORA_AUTH_TRUST_PROXY: 'true' }, async () => {
  check((await tools()) === 200, 'プロキシ 1 段: X-Forwarded-For なしの直接のループバックが、鍵なしで通らない');
  for (const [label, forwardedFor, expected] of [
    ['プロキシが見た相手が外部（右）', '198.51.100.7', 401],
    ['利用者が左に 127.0.0.1 を書き、プロキシが本当の接続元を右に足した', '127.0.0.1, 198.51.100.7', 401],
    ['プロキシが見た相手がループバック（右）', '198.51.100.7, 127.0.0.1', 200],
    ['プロキシが見た相手がループバック（1 つだけ）', '127.0.0.1', 200],
    ['IP アドレスでない値（localhost）', 'localhost', 401],
    ['IP アドレスでない値（ポートつき）', '127.0.0.1:8080', 401],
    ['IP アドレスでない値（短縮形）', '127.1', 401],
  ] as [string, string, number][]) {
    const status = await tools({ 'X-Forwarded-For': forwardedFor });
    check(status === expected, `プロキシ 1 段: ${label}（X-Forwarded-For: ${forwardedFor}）が ${status}（期待 ${expected}）`);
  }
  // 同じ名前の行を 2 行に分けても、1 つの列として、右から数える
  check((await rawStatus([['X-Forwarded-For', '127.0.0.1'], ['X-Forwarded-For', '198.51.100.7']])) === 401, 'プロキシ 1 段: X-Forwarded-For を 2 行に分けて、左の行の 127.0.0.1 が効いた');
  check((await rawStatus([['X-Forwarded-For', '198.51.100.7'], ['X-Forwarded-For', '127.0.0.1']])) === 200, 'プロキシ 1 段: X-Forwarded-For を 2 行に分けたとき、右の行（127.0.0.1）が効かない');
});

await scenario('プロキシ 2 段', { SORA_API_KEY: KEY, SORA_AUTH_LOOPBACK_NO_KEY: 'true', SORA_AUTH_TRUST_PROXY: 'true', SORA_AUTH_PROXY_HOPS: '2' }, async () => {
  for (const [forwardedFor, expected] of [
    ['127.0.0.1, 10.1.1.1', 200],
    ['198.51.100.7, 127.0.0.1, 10.1.1.1', 200],
    ['127.0.0.1, 198.51.100.7, 10.1.1.1', 401],
    ['127.0.0.1', 401], // 段数に足りない = プロキシを通っていない
    ['198.51.100.7, 127.0.0.1', 401],
  ] as [string, number][]) {
    const status = await tools({ 'X-Forwarded-For': forwardedFor });
    check(status === expected, `プロキシ 2 段: X-Forwarded-For: ${forwardedFor} が ${status}（期待 ${expected}）`);
  }
});

// (4) SORA_AUTH_TRUST_PROXY なし: X-Forwarded-For・X-Real-IP が付いた要求は、直接の接続ではない
await scenario('プロキシを信頼しない', { SORA_API_KEY: KEY, SORA_AUTH_LOOPBACK_NO_KEY: 'true' }, async () => {
  check((await tools()) === 200, 'プロキシを信頼しない: 直接のループバックが、鍵なしで通らない');
  check((await tools({ 'X-Forwarded-For': '127.0.0.1' })) === 401, 'プロキシを信頼しない: X-Forwarded-For つきの要求が、鍵なしで通った');
  check((await tools({ 'X-Real-IP': '127.0.0.1' })) === 401, 'プロキシを信頼しない: X-Real-IP つきの要求が、鍵なしで通った');
});

await server.stop(true);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: 本物のサーバーで、MCP の tenant は認証が決めたものだけ（同じ鍵はどの書き方でも同じ tenant・誤った Bearer と正しい X-API-Key は通らない・匿名は鍵を持つ利用者と別）。X-Forwarded-For は右から数え、利用者が左に書いた 127.0.0.1 では鍵なしの通過に入れない');
process.exit(0);
