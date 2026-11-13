/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: 本物のアプリ（src/index.ts の app。認証のミドルウェア → MCP・REST のルート）を、
 * 本物の Bun.serve（src/index.ts と同じ待ち受け。本物の TCP・本物の HTTP の読み取り）に載せて、認証の入口を叩く。
 *  (1) MCP の tenant は、認証が決めたものだけ: 同じ鍵は、X-API-Key でも Bearer（大文字小文字を問わない）でも同じ tenant。
 *      誤った Bearer と正しい X-API-Key を併せても通らない（以前は、認証は X-API-Key で通り、MCP は Bearer の任意の文字列で別の tenant になれた）
 *  (2) 鍵を持つ利用者と匿名（SORA_ALLOW_ANONYMOUS=true）は別の tenant。匿名どうしは、任意の Bearer を付けても同じ scope
 *  (3) ループバックは特別ではない: 鍵を設定したら、ループバックからでも鍵が要る。鍵なしの通過（廃止した設定）は、廃止した名前を残らず置いても、
 *      X-Forwarded-For・X-Real-IP を付けても付けなくても、効かない（設計書 E24。旧名は、登録簿とそのテスト以外に書かない）
 *  (5) 共有キャッシュと tenant（設計 5。E25）: 保存済みのセッション（Cookie）で得たページを、別の tenant に返さない。ログインしていない tenant どうしは共有する
 *  (6) ウォッチと tenant（設計 5。穴 2・18）: ある tenant が登録したウォッチは、別の tenant の一覧に出ず（通知先・取得した内容も）、確認も削除もできない。id を省いた確認は、呼んだ tenant の分だけ
 *  (7) map_site と tenant（設計 5。穴 17）: robots.txt・サイトマップを、呼んだ tenant の保存済みのセッションで取り、保存済みのセッションで見えた map を、別の tenant に返さない
 *  (8) 管理者の鍵と POST /cache/clear（設計 5。穴 19）: admin: true の鍵だけが、全員分（共有のキャッシュも）を消せる。ほかの鍵は、自分の tenant のキャッシュだけを消す
 *  (9) REST のモジュール（設計 5。穴 20）: SORA_MODULES で絞ったモジュールの経路は、REST でも閉じる（認証のあと: 鍵のない要求は 401 で、設定を教えない）。文書（/openapi.json）にも載らない
 *  (10) 増幅の上限（設計 6。穴 11・21）: SORA_ISOLATION=strict で、map_site は robots.txt の Sitemap: 行の先頭 5 つだけを取り、crawl のパターンとセレクタは 20 個まで（超えたら 400）。standard（既定）では、緩い値
 *  (11) ブラウザの枠（設計 6。穴 25）: SORA_ISOLATION=strict で、枠を全部埋め、ある tenant（bob）の待ちを上限（10 件）まで埋めると、bob の次の /browser/action は、待たされず 429（Retry-After つき・code: BROWSER_BUSY）。別の tenant（alice）は断られず、待つ（以前は、全体で 1 本の列で、上限も時間切れも無く、どの tenant も同じように待たされ続けた）
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
import { getFromCache, setToCache } from '../src/cache.js';
import { browserSemaphore } from '../src/browser_engine.js';
import { dbSaveTenantCookies } from '../src/db.js';
import { closeHttpSession } from '../src/http_fetcher.js';
import { app, mcpSessionManager } from '../src/index.js';
import { tenantCacheKey } from '../src/security/tenant_state.js';

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
const AUTH_ENV = ['SORA_API_KEY', 'SORA_ALLOW_ANONYMOUS', 'SORA_AUTH_KEYS_FILE', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_MODULES', 'SORA_ISOLATION', ...REMOVED_ENV];

/** 認証の環境変数を、この場面のものに替えて fn を回す（認証は、要求のたびに環境を読む）。終わったら、セッションを捨てる */
async function scenario(label: string, vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  if (process.env.AUTH_CHECK_TRACE) console.error(`[auth-check] 場面: ${label}`);
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
// (5) 用。前の場面で Cookie を受け取った tenant（alice・bob）と混ざらないよう、別の tenant にする
const SHARED_ALICE_1 = 'shared-alice-key-0123456789abcdef';
const SHARED_ALICE_2 = 'shared-alice-second-key-0123456789';
const SHARED_BOB = 'shared-bob-key-0123456789abcdefgh';
const SHARED_CAROL = 'shared-carol-key-0123456789abcdefg';
// (6) 用。同じ name の 2 つの鍵（alice）と、別の name（bob）
const WATCH_ALICE_1 = 'watch-alice-key-0123456789abcdef';
const WATCH_ALICE_2 = 'watch-alice-second-key-0123456789';
const WATCH_BOB = 'watch-bob-key-0123456789abcdefgh';
// (7) 用。map_site の結果を、tenant ごとに分けて確かめる
const MAP_ALICE_1 = 'map-alice-key-0123456789abcdefg';
const MAP_ALICE_2 = 'map-alice-second-key-0123456789';
const MAP_BOB = 'map-bob-key-0123456789abcdefghij';
const MAP_CAROL = 'map-carol-key-0123456789abcdefghi';
// (8) 用。管理者の鍵（admin: true）と、同じ name の管理者でない鍵（admin は鍵ごとの属性）
const CLEAR_ALICE = 'clear-alice-key-0123456789abcdef';
const CLEAR_BOB = 'clear-bob-key-0123456789abcdefgh';
const CLEAR_OPS = 'clear-ops-key-0123456789abcdefghi';
const CLEAR_OPS_PLAIN = 'clear-ops-plain-key-0123456789ab';
const keyDir = mkdtempSync(join(tmpdir(), 'sora-auth-check-'));
const keyPath = join(keyDir, 'keys.json');
writeFileSync(keyPath, JSON.stringify({ keys: [{ name: 'alice', key: ALICE_1 }, { name: 'alice', key: ALICE_2 }, { name: 'bob', keyHash: `sha256:${new Bun.CryptoHasher('sha256').update(BOB).digest('hex')}` }, { name: 'shared-alice', key: SHARED_ALICE_1 }, { name: 'shared-alice', key: SHARED_ALICE_2 }, { name: 'shared-bob', key: SHARED_BOB }, { name: 'shared-carol', key: SHARED_CAROL }, { name: 'watch-alice', key: WATCH_ALICE_1 }, { name: 'watch-alice', key: WATCH_ALICE_2 }, { name: 'watch-bob', key: WATCH_BOB }, { name: 'map-alice', key: MAP_ALICE_1 }, { name: 'map-alice', key: MAP_ALICE_2 }, { name: 'map-bob', key: MAP_BOB }, { name: 'map-carol', key: MAP_CAROL }, { name: 'clear-alice', key: CLEAR_ALICE }, { name: 'clear-bob', key: CLEAR_BOB }, { name: 'clear-ops', key: CLEAR_OPS, admin: true }, { name: 'clear-ops', key: CLEAR_OPS_PLAIN }] }), { mode: 0o600 });
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

// (5) 共有キャッシュと tenant。alice は、このサイトの保存済みのセッション（Cookie）を持つ。サーバーは、Cookie の値で、返す本文を変える
const PRIVATE = 'PRIVATE-FOR-ALICE';
const PUBLIC = 'PUBLIC-FOR-EVERYONE';
let sharedHits = 0;
const personalizedSite = createServer((request, response) => {
  sharedHits++;
  const marker = (request.headers.cookie ?? '').includes('sess=ALICE') ? PRIVATE : PUBLIC;
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<html><head><title>${marker}</title></head><body><main><h1>${marker}</h1><p>${marker}: このページの本文です。注文の履歴、住所、会員の情報など、読めるだけの長さの文章をここに置きます。</p><p>${marker}: 二つ目の段落です。抽出器が本文として扱うのに足りる長さの文を、続けて並べておきます。</p></main></body></html>`);
});
await new Promise<void>((resolve) => personalizedSite.listen(0, '127.0.0.1', () => resolve()));
const personalizedUrl = `http://127.0.0.1:${(personalizedSite.address() as { port: number }).port}/mypage`;
const scrapeText = async (headers: Record<string, string>) => {
  const response = await fetch(`${base}/scrape`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url: personalizedUrl, mode: 'fast', formats: ['markdown'] }) });
  const body = await response.text();
  return { status: response.status, private: body.includes(PRIVATE), public: body.includes(PUBLIC), cached: body.includes('"cached":true') };
};
await scenario('共有キャッシュと tenant', { SORA_AUTH_KEYS_FILE: keyPath, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  const tenants = ['name:shared-alice', 'name:shared-bob', 'name:shared-carol'];
  dbSaveTenantCookies('name:shared-alice', '127.0.0.1', [{ name: 'sess', value: 'ALICE', path: '/' }]);
  const alice = await scrapeText({ 'X-API-Key': SHARED_ALICE_1 });
  check(alice.status === 200 && alice.private && !alice.public, `共有キャッシュ: alice が、保存済みの Cookie で、自分のページを取れない: ${JSON.stringify(alice)}`);
  const bob = await scrapeText({ 'X-API-Key': SHARED_BOB });
  check(bob.status === 200 && bob.public && !bob.private && !bob.cached, `共有キャッシュ: bob に、alice のページが返った（またはキャッシュから返った）: ${JSON.stringify(bob)}`);
  const carol = await scrapeText({ 'X-API-Key': SHARED_CAROL });
  check(carol.status === 200 && carol.public && !carol.private && carol.cached, `共有キャッシュ: ログインしていない carol が、bob の公開のページを、共有のキャッシュから読めない: ${JSON.stringify(carol)}`);
  const aliceAgain = await scrapeText({ 'X-API-Key': SHARED_ALICE_2 });
  check(aliceAgain.private && !aliceAgain.public && aliceAgain.cached, `共有キャッシュ: alice の 2 回目（同じ name の別の鍵）が、alice 自身のキャッシュから返らない: ${JSON.stringify(aliceAgain)}`);
  check(sharedHits === 2, `共有キャッシュ: サーバーへの要求が 2 回でない（alice と bob の 1 回ずつ。あとは、キャッシュ）: ${sharedHits}`);
  for (const tenantId of tenants) {
    await closeHttpSession('127.0.0.1', tenantId).catch(() => {});
    dbSaveTenantCookies(tenantId, '127.0.0.1', []);
  }
});
personalizedSite.close();

// (6) ウォッチと tenant。alice が登録したウォッチは、bob の一覧に出ず、bob は確認も削除もできない。id を省いた確認は、呼んだ tenant の分だけ
let watchHits = 0;
const watchSite = createServer((request, response) => {
  watchHits++;
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<html><head><title>監視</title></head><body><main><h1>監視</h1><p>${request.url}: 監視するページの本文です。変化を調べるのに足りる長さの文章を、ここに置いておきます。</p></main></body></html>`);
});
await new Promise<void>((resolve) => watchSite.listen(0, '127.0.0.1', () => resolve()));
const watchBase = `http://127.0.0.1:${(watchSite.address() as { port: number }).port}`;
const watchApi = async (key: string, method: string, path: string, body?: object) => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
};
await scenario('ウォッチと tenant', { SORA_AUTH_KEYS_FILE: keyPath, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  const registered = await watchApi(WATCH_ALICE_1, 'POST', '/watch/register', { url: `${watchBase}/alice`, title: 'alice のウォッチ', webhookUrl: 'https://hooks.example.com/alice-secret-token' });
  const aliceId: unknown = registered.json?.target?.id;
  check(registered.status === 200 && typeof aliceId === 'string', `ウォッチ: alice の登録が通らない: ${registered.status} ${registered.text.slice(0, 200)}`);
  if (typeof aliceId !== 'string') return;
  // 一覧: alice（別の鍵でも同じ name）には出る。bob には、登録も、通知先も、取得した内容も出ない
  const aliceList = await watchApi(WATCH_ALICE_2, 'GET', '/watch/list');
  check(aliceList.json?.count === 1 && aliceList.json?.targets?.[0]?.id === aliceId, `ウォッチ: alice の別の鍵（同じ name）の一覧に、alice のウォッチが出ない: ${aliceList.text.slice(0, 200)}`);
  const bobList = await watchApi(WATCH_BOB, 'GET', '/watch/list');
  check(bobList.status === 200 && bobList.json?.count === 0 && !bobList.text.includes(aliceId) && !bobList.text.includes('alice-secret-token') && !bobList.text.includes('/alice:'), `ウォッチ: bob の一覧に、alice のウォッチが出た: ${bobList.text.slice(0, 200)}`);
  // 確認: bob は、alice の id を使えない（存在しない id と同じ失敗）。alice のページを取りに行かない。id を省いても、bob の分だけ（0 件）
  const hitsBefore = watchHits;
  const bobCheck = await watchApi(WATCH_BOB, 'POST', '/watch/check', { id: aliceId });
  const noneCheck = await watchApi(WATCH_BOB, 'POST', '/watch/check', { id: 'wt_nothing' });
  check(bobCheck.status !== 200 && bobCheck.status === noneCheck.status && bobCheck.json?.code === noneCheck.json?.code, `ウォッチ: bob が alice の id を確認できた、または、存在しない id と失敗の形が違う: ${bobCheck.status} ${bobCheck.text.slice(0, 120)} / ${noneCheck.status}`);
  const bobAll = await watchApi(WATCH_BOB, 'POST', '/watch/check', {});
  check(bobAll.status === 200 && bobAll.json?.results?.length === 0, `ウォッチ: bob の全件の確認に、alice の分が入った: ${bobAll.text.slice(0, 200)}`);
  check(watchHits === hitsBefore, `ウォッチ: bob の確認で、alice のページを取りに行った（${watchHits - hitsBefore} 回）`);
  // 削除: bob は、alice のウォッチを消せない
  const bobDelete = await watchApi(WATCH_BOB, 'DELETE', `/watch/${aliceId}`);
  check(bobDelete.status === 200 && bobDelete.json?.success === false, `ウォッチ: bob が alice のウォッチを削除できた: ${bobDelete.text.slice(0, 120)}`);
  // alice 自身（別の鍵でも）は、確認も削除もできる
  const aliceCheck = await watchApi(WATCH_ALICE_1, 'POST', '/watch/check', { id: aliceId });
  check(aliceCheck.status === 200 && aliceCheck.json?.result?.targetId === aliceId, `ウォッチ: alice が自分のウォッチを確認できない: ${aliceCheck.status} ${aliceCheck.text.slice(0, 200)}`);
  const aliceDelete = await watchApi(WATCH_ALICE_2, 'DELETE', `/watch/${aliceId}`);
  check(aliceDelete.json?.success === true, `ウォッチ: alice の別の鍵（同じ name）が、alice のウォッチを削除できない: ${aliceDelete.text.slice(0, 120)}`);
  const afterDelete = await watchApi(WATCH_ALICE_1, 'GET', '/watch/list');
  check(afterDelete.json?.count === 0, `ウォッチ: 削除したあとも、alice の一覧に残る: ${afterDelete.text.slice(0, 200)}`);
});
watchSite.close();

// (7) map_site と tenant。alice は、このサイトの保存済みのセッション（Cookie）を持つ。サイトマップは、Cookie の値で、返す URL の一覧を変える
let mapHits = 0;
const mapSite = createServer((request, response) => {
  const kind = (request.headers.cookie ?? '').includes('sess=ALICE') ? 'private' : 'public';
  const origin = `http://127.0.0.1:${(mapSite.address() as { port: number }).port}`;
  if (request.url === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`User-agent: *\nSitemap: ${origin}/sitemap.xml\n`);
    return;
  }
  if (request.url === '/sitemap.xml') {
    mapHits++;
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/${kind}-1</loc></url><url><loc>${origin}/${kind}-2</loc></url></urlset>`);
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise<void>((resolve) => mapSite.listen(0, '127.0.0.1', () => resolve()));
const mapUrl = `http://127.0.0.1:${(mapSite.address() as { port: number }).port}/`;
const mapAs = async (key: string) => {
  const response = await fetch(`${base}/map`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ url: mapUrl, limit: 10 }) });
  const body = await response.text();
  return { status: response.status, private: body.includes('private-'), public: body.includes('public-'), cached: body.includes('"cached":true') };
};
await scenario('map_site と tenant', { SORA_AUTH_KEYS_FILE: keyPath, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  const tenantIds = ['name:map-alice', 'name:map-bob', 'name:map-carol'];
  dbSaveTenantCookies('name:map-alice', '127.0.0.1', [{ name: 'sess', value: 'ALICE', path: '/' }]);
  const alice = await mapAs(MAP_ALICE_1);
  check(alice.status === 200 && alice.private && !alice.public, `map_site: alice が、保存済みの Cookie で、自分の map を取れない: ${JSON.stringify(alice)}`);
  const bob = await mapAs(MAP_BOB);
  check(bob.status === 200 && bob.public && !bob.private && !bob.cached, `map_site: bob に、alice の map が返った（またはキャッシュから返った）: ${JSON.stringify(bob)}`);
  const carol = await mapAs(MAP_CAROL);
  check(carol.status === 200 && carol.public && !carol.private && carol.cached, `map_site: ログインしていない carol が、bob の公開の map を、共有のキャッシュから読めない: ${JSON.stringify(carol)}`);
  const aliceAgain = await mapAs(MAP_ALICE_2);
  check(aliceAgain.private && !aliceAgain.public && aliceAgain.cached, `map_site: alice の 2 回目（同じ name の別の鍵）が、alice 自身のキャッシュから返らない: ${JSON.stringify(aliceAgain)}`);
  check(mapHits === 2, `map_site: サイトマップへの要求が 2 回でない（alice と bob の 1 回ずつ。あとは、キャッシュ）: ${mapHits}`);
  for (const tenantId of tenantIds) {
    await closeHttpSession('127.0.0.1', tenantId).catch(() => {});
    dbSaveTenantCookies(tenantId, '127.0.0.1', []);
  }
});
mapSite.close();

// REST を、鍵つきで呼ぶ（(9)・(10) で使う）
const restAs = async (key: string | undefined, method: string, path: string, body?: object) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) };
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, headers: response.headers };
};

// (10) 増幅の上限。悪意のあるサイト: robots.txt に Sitemap: を 100 行並べ、それぞれが空のサイトマップ（つぎの候補に進む）
let amplificationHits = 0;
const amplificationSite = createServer((request, response) => {
  const origin = `http://127.0.0.1:${(amplificationSite.address() as { port: number }).port}`;
  if (request.url === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(Array.from({ length: 100 }, (_, i) => `Sitemap: ${origin}/amplify/${i}.xml`).join('\n'));
    return;
  }
  if (request.url?.startsWith('/amplify/')) {
    amplificationHits++;
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<html><head><title>t</title></head><body><main><h1>t</h1><p>増幅を確かめるページの本文です。読めるだけの長さの文章を、ここに置いておきます。</p></main></body></html>');
});
await new Promise<void>((resolve) => amplificationSite.listen(0, '127.0.0.1', () => resolve()));
const amplificationUrl = `http://127.0.0.1:${(amplificationSite.address() as { port: number }).port}/`;
await scenario('増幅の上限（strict）', { SORA_AUTH_KEYS_FILE: keyPath, SORA_ISOLATION: 'strict', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  const mapped = await restAs(MAP_BOB, 'POST', '/map', { url: amplificationUrl, limit: 10, noCache: true });
  check(mapped.status === 200, `増幅の上限: strict の /map が 200 でない: ${mapped.status} ${mapped.text.slice(0, 120)}`);
  check(amplificationHits === 5, `増幅の上限: strict で、robots.txt の Sitemap: 行を 5 つだけ取っていない（${amplificationHits} 回）`);
  const patterns = await restAs(MAP_BOB, 'POST', '/crawl', { url: amplificationUrl, includePatterns: Array.from({ length: 21 }, (_, i) => `/p${i}/**`) });
  check(patterns.status === 400 && patterns.json?.code === 'INVALID_INPUT', `増幅の上限: strict で、パターン 21 個が 400 でない: ${patterns.status} ${patterns.text.slice(0, 120)}`);
  const selectors = await restAs(MAP_BOB, 'POST', '/scrape', { url: amplificationUrl, removeSelectors: Array.from({ length: 21 }, (_, i) => `.r${i}`) });
  check(selectors.status === 400 && selectors.json?.code === 'INVALID_INPUT', `増幅の上限: strict で、セレクタ 21 個が 400 でない: ${selectors.status} ${selectors.text.slice(0, 120)}`);
});
await scenario('増幅の上限（既定の standard）', { SORA_AUTH_KEYS_FILE: keyPath, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
  amplificationHits = 0;
  const selectors = await restAs(MAP_BOB, 'POST', '/scrape', { url: amplificationUrl, removeSelectors: Array.from({ length: 21 }, (_, i) => `.r${i}`) });
  check(selectors.status !== 400, `増幅の上限: 既定（standard）で、セレクタ 21 個が断られた（緩い値は 100 個）: ${selectors.status} ${selectors.text.slice(0, 120)}`);
  const mapped = await restAs(MAP_BOB, 'POST', '/map', { url: amplificationUrl, limit: 10, noCache: true });
  check(mapped.status === 200 && amplificationHits > 5, `増幅の上限: 既定（standard）で、Sitemap: 行を 5 つより多く取っていない（${amplificationHits} 回。緩い値は 50 行）`);
});
amplificationSite.close();

// (9) REST のモジュール。SORA_MODULES=web にすると、web 以外のモジュールの経路（/watch/*・/trade/* など）は、REST でも 404（MODULE_DISABLED）
await scenario('REST のモジュール', { SORA_AUTH_KEYS_FILE: keyPath, SORA_MODULES: 'web' }, async () => {
  const noKey = await restAs(undefined, 'GET', '/watch/list');
  check(noKey.status === 401, `REST のモジュール: 鍵のない要求が 401 でない（設定を教えている）: ${noKey.status} ${noKey.text.slice(0, 120)}`);
  const closed = await restAs(MAP_BOB, 'GET', '/watch/list');
  check(closed.status === 404 && closed.json?.code === 'MODULE_DISABLED', `REST のモジュール: SORA_MODULES=web で /watch/list が閉じていない: ${closed.status} ${closed.text.slice(0, 160)}`);
  const closedDelete = await restAs(MAP_BOB, 'DELETE', '/watch/wt_none');
  check(closedDelete.status === 404 && closedDelete.json?.code === 'MODULE_DISABLED', `REST のモジュール: DELETE /watch/:id が閉じていない: ${closedDelete.status}`);
  const closedTrade = await restAs(MAP_BOB, 'POST', '/trade/hts-verify', {});
  check(closedTrade.status === 404 && closedTrade.json?.code === 'MODULE_DISABLED', `REST のモジュール: /trade/hts-verify が閉じていない: ${closedTrade.status}`);
  const open = await restAs(MAP_BOB, 'POST', '/scrape', {});
  check(open.status !== 404 || open.json?.code !== 'MODULE_DISABLED', `REST のモジュール: web の経路 /scrape まで閉じた: ${open.status} ${open.text.slice(0, 120)}`);
  const health = await restAs(undefined, 'GET', '/health');
  check(health.status === 200, `REST のモジュール: /health が鍵なしで開かない: ${health.status}`);
  const doc = await restAs(undefined, 'GET', '/openapi.json');
  check(doc.status === 200 && doc.json?.paths && !('/watch/list' in doc.json.paths) && '/scrape' in doc.json.paths, `REST のモジュール: 閉じた経路が OpenAPI に載っている、または web の経路が載っていない`);
});
await scenario('REST のモジュール（既定の all）', { SORA_AUTH_KEYS_FILE: keyPath }, async () => {
  const allOpen = await restAs(MAP_BOB, 'GET', '/watch/list');
  check(allOpen.status === 200, `REST のモジュール: 既定（all）で /watch/list が開いていない: ${allOpen.status} ${allOpen.text.slice(0, 120)}`);
});

// (8) 管理者の鍵と POST /cache/clear。キャッシュの行は、同じプロセスのメモリに直に置く（アプリと同じモジュール）
const clearAs = async (key?: string) => {
  const response = await fetch(`${base}/cache/clear`, { method: 'POST', headers: key ? { 'X-API-Key': key } : {} });
  const body = (await response.json().catch(() => ({}))) as { scope?: string; cleared?: number };
  return { status: response.status, scope: body.scope, cleared: body.cleared };
};
const clearKeys = {
  alice: tenantCacheKey('name:clear-alice', 'check:k'),
  bob: tenantCacheKey('name:clear-bob', 'check:k'),
  ops: tenantCacheKey('name:clear-ops', 'check:k'),
  shared: 'check:clear-shared',
};
const seedClear = () => {
  for (const key of Object.values(clearKeys)) setToCache(key, { v: key });
};
const clearAlive = () => Object.fromEntries(Object.entries(clearKeys).map(([name, key]) => [name, getFromCache(key) !== null]));
await scenario('管理者の鍵と /cache/clear', { SORA_AUTH_KEYS_FILE: keyPath }, async () => {
  seedClear();
  const none = await clearAs();
  check(none.status === 401, `cache/clear: 鍵なしの要求が 401 でない: ${none.status}`);
  check(JSON.stringify(clearAlive()) === JSON.stringify({ alice: true, bob: true, ops: true, shared: true }), `cache/clear: 鍵なしの要求でキャッシュが消えた: ${JSON.stringify(clearAlive())}`);
  // 管理者でない利用者は、自分の tenant の分だけ
  const alice = await clearAs(CLEAR_ALICE);
  check(alice.status === 200 && alice.scope === 'tenant' && alice.cleared === 1, `cache/clear: 管理者でない利用者の消去が、自分の分だけでない: ${JSON.stringify(alice)}`);
  check(JSON.stringify(clearAlive()) === JSON.stringify({ alice: false, bob: true, ops: true, shared: true }), `cache/clear: 管理者でない利用者が、ほかの tenant か共有のキャッシュを消した: ${JSON.stringify(clearAlive())}`);
  // admin は鍵ごとの属性: 同じ name の、admin のない鍵は、管理者ではない
  const opsPlain = await clearAs(CLEAR_OPS_PLAIN);
  check(opsPlain.status === 200 && opsPlain.scope === 'tenant', `cache/clear: admin のない鍵が、全体を消せる扱いになった: ${JSON.stringify(opsPlain)}`);
  check(clearAlive().shared === true && clearAlive().bob === true, `cache/clear: admin のない鍵が、共有のキャッシュかほかの tenant を消した: ${JSON.stringify(clearAlive())}`);
  // 管理者の鍵は、全員分（共有のキャッシュも）
  const ops = await clearAs(CLEAR_OPS);
  check(ops.status === 200 && ops.scope === 'all', `cache/clear: 管理者の鍵の消去が、全体でない: ${JSON.stringify(ops)}`);
  check(JSON.stringify(clearAlive()) === JSON.stringify({ alice: false, bob: false, ops: false, shared: false }), `cache/clear: 管理者の鍵で、全員分が消えていない: ${JSON.stringify(clearAlive())}`);
  // 鍵ファイルを使わない運用（鍵が 1 つ）は、これまでどおり全体
  seedClear();
  process.env.SORA_AUTH_KEYS_FILE = '';
  delete process.env.SORA_AUTH_KEYS_FILE;
  process.env.SORA_API_KEY = KEY;
  const single = await clearAs(KEY);
  check(single.status === 200 && single.scope === 'all', `cache/clear: 鍵が 1 つの運用の消去が、全体でない: ${JSON.stringify(single)}`);
  check(JSON.stringify(clearAlive()) === JSON.stringify({ alice: false, bob: false, ops: false, shared: false }), `cache/clear: 鍵が 1 つの運用で、全員分が消えていない: ${JSON.stringify(clearAlive())}`);
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
// (11) ブラウザの枠。枠は手放さない（確認の終わりまで）。alice の待っている要求が、枠を得てブラウザを起動しないように、確認はプロセスの終了で終える
const pendingAfter = (ms: number) => new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms));
await scenario('ブラウザの枠（strict）', { SORA_AUTH_KEYS_FILE: keyPath, SORA_ISOLATION: 'strict' }, async () => {
  for (let i = 0; browserSemaphore.activeCount < browserSemaphore.max; i++) await browserSemaphore.acquire(`hog-${i}`);
  for (let i = 0; i < 10; i++) browserSemaphore.acquire('name:map-bob').catch(() => {}); // bob の待ち: strict の上限（10 件）まで
  const bob = await Promise.race([restAs(MAP_BOB, 'POST', '/browser/action', { url: amplificationUrl }), pendingAfter(5000)]);
  if (bob === 'pending') {
    failures.push('ブラウザの枠: bob の待ちが上限なのに、5 秒たっても断られず、待たされた（429 になっていない）');
  } else {
    check(bob.status === 429 && bob.json?.code === 'BROWSER_BUSY' && bob.json?.retryable === true, `ブラウザの枠: bob の待ちが上限のとき、/browser/action が 429（BROWSER_BUSY）でない: ${bob.status} ${bob.text.slice(0, 160)}`);
    check(bob.headers.get('retry-after') === '5', `ブラウザの枠: 429 に Retry-After: 5 が付いていない（${bob.headers.get('retry-after')}）`);
  }
  const alice = await Promise.race([restAs(MAP_ALICE_1, 'POST', '/browser/action', { url: amplificationUrl }).then(() => 'answered' as const), pendingAfter(500)]);
  check(alice === 'pending', 'ブラウザの枠: bob の待ちが上限でも、別の tenant の alice が断られた（alice の待ちは、bob と別に数える）');
});
site.close();
rmSync(keyDir, { recursive: true, force: true });

await server.stop(true);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: 本物のサーバーで、MCP の tenant は認証が決めたものだけ（同じ鍵はどの書き方でも同じ tenant・誤った Bearer と正しい X-API-Key は通らない・匿名は鍵を持つ利用者と別）。ループバックからでも鍵が要り（鍵なしの通過は廃止）、鍵ファイルは、鍵ごとに別の tenant（MCP のセッションも、サイトごとの Cookie も）で、匿名を認めず、読めないときは 503。保存済みのセッションで得たページは、別の tenant に返らない（共有キャッシュ）。ウォッチは、別の tenant の一覧に出ず、確認も削除もできない。map_site の結果は、保存済みのセッションで見えた分を、別の tenant に返さない。/cache/clear は、admin の鍵だけが全員分を消し、ほかの鍵は自分の tenant の分だけ消す。SORA_MODULES で絞ったモジュールの経路は、REST でも閉じる。SORA_ISOLATION=strict では、増幅の上限（サイトマップ・パターン・セレクタ）を締め、ブラウザの枠は、tenant ごとの待ちが上限に達すると、待たせずに 429 で断り、別の tenant は断らない');
process.exit(0);
