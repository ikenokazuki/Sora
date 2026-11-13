/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: 本物のアプリ（src/index.ts の app。認証のミドルウェア → MCP・REST のルート）を、
 * 本物の Bun.serve（src/index.ts と同じ待ち受け。本物の TCP・本物の HTTP の読み取り）に載せて、認証の入口を叩く。
 *  (1) MCP の tenant は、認証が決めたものだけ: 同じ鍵は、X-API-Key でも Bearer（大文字小文字を問わない）でも同じ tenant。
 *      誤った Bearer と正しい X-API-Key を併せても通らない（以前は、認証は X-API-Key で通り、MCP は Bearer の任意の文字列で別の tenant になれた）
 *  (2) 鍵を持つ利用者と匿名（SORA_ALLOW_ANONYMOUS=true）は別の tenant。匿名どうしは、任意の Bearer を付けても同じ scope
 *  (3) ループバックは特別ではない: 鍵を設定したら、ループバックからでも鍵が要る。鍵なしの通過（廃止した設定）は、廃止した名前を残らず置いても、
 *      X-Forwarded-For・X-Real-IP を付けても付けなくても、効かない（設計書 E24。旧名は、登録簿とそのテスト以外に書かない）
 *  (4) 鍵ファイル（SORA_AUTH_KEYS_FILE）: 鍵ごとに別の tenant（name:<name>）。同じ name の 2 つの鍵は同じ tenant（MCP のセッションも、サイトごとの Cookie も引き継ぐ）で、
 *      別の name には見せない。匿名は SORA_ALLOW_ANONYMOUS=true でも 401。鍵ファイルを読めないときは 503（匿名にしない）
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/packages:/app/packages:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/auth-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 4。E20・E22〜E24）
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY } from '../src/config.js';
import { app, mcpSessionManager } from '../src/index.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// この確認の HTTP は、環境のプロキシを通さない（ループバックの本物のサーバーに、直接つなぐ）
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[name];

const KEY = 'auth-check-key-0123456789abcdef';

const server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
const port = server.port as number;
const base = `http://127.0.0.1:${port}`;

// 廃止した名前（置き換え先の無い旧名と、リリースされなかった名前）の全部。登録簿から取る（名前を、ここに書き写さない）
const REMOVED_ENV = Object.keys(LEGACY).filter((name) => !LEGACY[name].to);
const AUTH_ENV = ['SORA_API_KEY', 'SORA_ALLOW_ANONYMOUS', 'SORA_AUTH_KEYS_FILE', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', ...REMOVED_ENV];

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

// (3) ループバックは特別ではない。鍵を設定したら、ループバックからでも鍵が要る（廃止した鍵なしの通過の設定が残っていても、効かない）
await scenario('ループバックでも鍵が要る', { SORA_API_KEY: KEY, ...Object.fromEntries(REMOVED_ENV.map((name) => [name, 'true'])) }, async () => {
  check((await tools()) === 401, 'ループバック: 127.0.0.1 から、鍵なしで通った');
  check((await tools({ 'X-Forwarded-For': '127.0.0.1' })) === 401, 'ループバック: X-Forwarded-For: 127.0.0.1 つきで、鍵なしで通った');
  check((await tools({ 'X-Forwarded-For': '203.0.113.9, 127.0.0.1' })) === 401, 'ループバック: X-Forwarded-For の右端がループバックで、鍵なしで通った');
  check((await tools({ 'X-Real-IP': '127.0.0.1' })) === 401, 'ループバック: X-Real-IP: 127.0.0.1 つきで、鍵なしで通った');
  check((await mcp({}, initialize)).status === 401, 'ループバック: MCP の初期化が、鍵なしで通った');
  // IPv6 のループバック（::1）。IPv6 を使えない環境（接続できない）では、試さない
  const viaIpv6 = await fetch(`http://[::1]:${port}/tools?q=auth-check`).then((response) => response.status, () => undefined);
  if (viaIpv6 !== undefined) check(viaIpv6 === 401, `ループバック: ::1 から、鍵なしで通った（${viaIpv6}）`);
  // 鍵があれば、ループバックからでも通る。tenant は鍵のもの
  check((await tools({ 'X-API-Key': KEY })) === 200, 'ループバック: 正しい鍵の GET /tools が通らない');
});

// (4) 鍵ファイル。鍵ごとに別の tenant。サイトごとの Cookie の入れ物（tenant ごと）を、REST の /scrape で確かめる
const ALICE_1 = 'alice-key-0123456789abcdef';
const ALICE_2 = 'alice-second-key-0123456789';
const BOB = 'bob-key-0123456789abcdefgh';
const keyDir = mkdtempSync(join(tmpdir(), 'sora-auth-check-'));
const keyPath = join(keyDir, 'keys.json');
writeFileSync(keyPath, JSON.stringify({ keys: [{ name: 'alice', key: ALICE_1 }, { name: 'alice', key: ALICE_2 }, { name: 'bob', keyHash: `sha256:${new Bun.CryptoHasher('sha256').update(BOB).digest('hex')}` }] }), { mode: 0o600 });
chmodSync(keyPath, 0o600);

const seenCookies: Array<string | undefined> = [];
let siteHits = 0;
const site = createServer((request, response) => {
  siteHits++;
  seenCookies.push(request.headers.cookie);
  response.writeHead(200, { 'content-type': 'text/html', 'Set-Cookie': `sess=${siteHits}; Path=/` });
  response.end('<html><head><title>t</title></head><body><p>hello world content here and more text for the extractor</p></body></html>');
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()));
const siteBase = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
const scrape = (headers: Record<string, string>) =>
  fetch(`${base}/scrape`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url: `${siteBase}/jar`, mode: 'fast', noCache: true }) }).then((response) => response.status);

await scenario('鍵ファイル', { SORA_AUTH_KEYS_FILE: keyPath, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  // MCP: 同じ name の 2 つの鍵は同じ tenant、別の name は別
  const alice = await open({ 'X-API-Key': ALICE_1 }, '鍵ファイル alice');
  for (const headers of [{ 'X-API-Key': ALICE_2 }, { Authorization: `bearer ${ALICE_1}` }, { Authorization: `BEARER ${ALICE_2}` }] as Record<string, string>[]) {
    const response = await mcp(headers, listTools, alice);
    check(response.status === 200, `鍵ファイル: alice の別の鍵で、alice のセッションを続けられない: ${JSON.stringify(headers)} → ${response.status}`);
  }
  const bob = await open({ 'X-API-Key': BOB }, '鍵ファイル bob');
  check((await mcp({ 'X-API-Key': BOB }, listTools, alice)).status === 404, '鍵ファイル: bob が alice のセッションを使えた');
  check((await mcp({ 'X-API-Key': ALICE_1 }, listTools, bob)).status === 404, '鍵ファイル: alice が bob のセッションを使えた');
  // 匿名・誤った鍵は 401（SORA_ALLOW_ANONYMOUS=true でも）
  process.env.SORA_ALLOW_ANONYMOUS = 'true';
  for (const [label, headers] of [['鍵なし', {}], ['知らない鍵', { 'X-API-Key': 'unknown-key-0123456789abcdef' }], ['誤った bearer と正しい X-API-Key', { Authorization: 'bearer wrong', 'X-API-Key': ALICE_1 }]] as [string, Record<string, string>][]) {
    check((await mcp(headers, initialize)).status === 401, `鍵ファイル: ${label}が、SORA_ALLOW_ANONYMOUS=true で通った`);
    check((await tools(headers)) === 401, `鍵ファイル: ${label}の GET /tools が、SORA_ALLOW_ANONYMOUS=true で通った`);
  }
  delete process.env.SORA_ALLOW_ANONYMOUS;
  // 接続元を示すヘッダーも、鍵の代わりにならない
  check((await tools({ 'X-Forwarded-For': '127.0.0.1' })) === 401, '鍵ファイル: X-Forwarded-For: 127.0.0.1 つきの要求が、鍵なしで通った');
  check((await tools({ 'X-Real-IP': '127.0.0.1' })) === 401, '鍵ファイル: X-Real-IP: 127.0.0.1 つきの要求が、鍵なしで通った');
  // サイトごとの Cookie（REST の /scrape）: alice の 2 つの鍵は引き継ぎ、bob には見せない
  check((await scrape({ 'X-API-Key': ALICE_1 })) === 200, '鍵ファイル: alice の /scrape が 200 でない');
  check((await scrape({ 'X-API-Key': ALICE_2 })) === 200, '鍵ファイル: alice の別の鍵の /scrape が 200 でない');
  check((await scrape({ 'X-API-Key': BOB })) === 200, '鍵ファイル: bob の /scrape が 200 でない');
  check((await scrape({ Authorization: `Bearer ${ALICE_1}` })) === 200, '鍵ファイル: alice の 3 回目の /scrape が 200 でない');
  check(JSON.stringify(seenCookies) === JSON.stringify([undefined, 'sess=1', undefined, 'sess=2']), `鍵ファイル: サイトごとの Cookie が name ごとに分かれていない: ${JSON.stringify(seenCookies)}`);
});

// 鍵ファイルを読めない（起動のあとに壊れた）: すべての要求を 503 で断る。匿名にしない
await scenario('鍵ファイルを読めない', { SORA_AUTH_KEYS_FILE: join(keyDir, 'missing.json'), SORA_ALLOW_ANONYMOUS: 'true' }, async () => {
  const originalError = console.error;
  console.error = () => {}; // 理由のログ（1 回）は、この確認の出力に混ぜない
  try {
    check((await tools()) === 503, '鍵ファイルを読めない: 鍵なしの要求が 503 でない');
    check((await tools({ 'X-API-Key': ALICE_1 })) === 503, '鍵ファイルを読めない: 鍵つきの要求が 503 でない');
    check((await mcp({}, initialize)).status === 503, '鍵ファイルを読めない: MCP の要求が 503 でない');
  } finally {
    console.error = originalError;
  }
});
site.close();
rmSync(keyDir, { recursive: true, force: true });

await server.stop(true);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: 本物のサーバーで、MCP の tenant は認証が決めたものだけ（同じ鍵はどの書き方でも同じ tenant・誤った Bearer と正しい X-API-Key は通らない・匿名は鍵を持つ利用者と別）。ループバックからでも鍵が要り（鍵なしの通過は廃止）、鍵ファイルは、鍵ごとに別の tenant（MCP のセッションも、サイトごとの Cookie も）で、匿名を認めず、読めないときは 503');
process.exit(0);
