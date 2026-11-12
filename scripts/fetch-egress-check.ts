/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: Bun の fetch と、通信する子プロセスを、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on）に通すと、
 *  (1) Bun の fetch（installEgressFetch が包んだ globalThis.fetch）: 内部の宛先は断られ、宛先のサーバーには何も届かない。環境変数 NO_PROXY が挙げていても、迂回しない
 *      （Bun は、NO_PROXY の宛先には、指定したプロキシも使わず、直接つなぐ）。名前は、ゲートウェイが解決して、宛先に届く（OS では解決できない名前でも届く）
 *  (2) 同梱の Yahoo 検索バイナリ（Rust）の通信が、ゲートウェイを通る: 名前をゲートウェイが解決し、内部の IP は断られる。NO_PROXY に挙げても、直接つながない
 *  (3) 住所データの構築の子プロセス（Bun）の fetch が、ゲートウェイを通る: 名前をゲートウェイが解決して、宛先に届く。NO_PROXY に挙げても、直接つながない
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/fetch-egress-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 1。E17・E18）
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEgressGateway, stopEgressGateway } from '../src/net/egress.js';
import { installEgressFetch } from '../src/net/egress_fetch.js';
import { getSecurityMetrics } from '../src/security/metrics.js';
import { ChildProcessBuilder } from '../src/services/address_builder.js';
import { callYahooMcp } from '../src/services/yahoo.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// 宛先の道具: 要求を数える HTTP サーバー（127.0.0.1 = 内部の宛先）
const hits: string[] = [];
const web = createServer((request, response) => {
  hits.push(`${request.method} ${request.url}`);
  response.end('web-ok');
}).listen(0, '127.0.0.1');
await once(web, 'listening');
const webPort = (web.address() as AddressInfo).port;

// ゲートウェイの設定は、環境変数から（運用の設定と同じ道）。名前の解決と、内部の判定だけ差し替える:
//   web.test → 127.0.0.1（この確認では、公開として扱う宛先）、search.yahoo.co.jp → 127.0.0.2（内部として断る。Yahoo の本物には、つなぎに行かない）
const resolved: string[] = [];
process.env.SORA_EGRESS_GATEWAY = 'on';
// Bun の fetch と子プロセスが、NO_PROXY を見て、ゲートウェイを迂回しないこと（実際の運用でも、NO_PROXY は、たいてい、ループバックを挙げる）
const noProxy = '127.0.0.1,localhost,web.test,search.yahoo.co.jp';
process.env.NO_PROXY = noProxy;
process.env.no_proxy = noProxy;
await getEgressGateway({
  allowedPorts: [webPort, 443],
  resolve: async (host) => {
    resolved.push(host);
    if (host === 'web.test') return ['127.0.0.1'];
    if (host === 'search.yahoo.co.jp') return ['127.0.0.2'];
    throw new Error(`ENOTFOUND ${host}`);
  },
  isPrivateIp: (ip) => ip === '127.0.0.2',
});
installEgressFetch();

// 内部の宛先の拒否の数。IP リテラル・localhost は、解決の前に（本物の方針で）断る（blocked_host）。名前が内部の IP に解決したら、private_ip
const deniedPrivate = () => getSecurityMetrics().sora_egress_denied_private_ip_total ?? 0;
const deniedInternal = () => deniedPrivate() + (getSecurityMetrics().sora_egress_denied_blocked_host_total ?? 0);

// (1) Bun の fetch
{
  const before = deniedInternal();
  const byIp = await fetch(`http://127.0.0.1:${webPort}/`).then(
    (response) => ({ status: response.status, deny: response.headers.get('x-sora-egress-deny') }),
    (error: unknown) => ({ error: String(error) }),
  );
  check('status' in byIp && byIp.status === 403 && (byIp.deny === 'private_ip' || byIp.deny === 'blocked_host'), `内部の宛先（127.0.0.1）が、NO_PROXY に挙げてあっても、ゲートウェイに断られていない: ${JSON.stringify(byIp)}`);
  const byName = await fetch(`http://localhost:${webPort}/`).then(
    (response) => response.status,
    () => -1,
  );
  check(byName === 403, `内部の名前（localhost）が、ゲートウェイに断られていない: ${byName}`);
  const https = await fetch(`https://127.0.0.1:${webPort}/`).then(
    () => 'reached',
    () => 'failed',
  );
  check(https === 'failed', 'https の内部の宛先が、トンネルの失敗になっていない（宛先に届いた）');
  check(hits.length === 0, `内部の宛先のサーバーに、要求が届いた: ${hits.join(', ')}`);
  check(deniedInternal() - before >= 3, `ゲートウェイが、内部の宛先の拒否（http の IP・localhost・https の IP）を、3 件数えていない: ${deniedInternal() - before}`);

  const result = await fetch(`http://web.test:${webPort}/p?x=1`).then(
    async (response) => ({ status: response.status, body: await response.text() }),
    (error: unknown) => ({ error: String(error) }),
  );
  check('status' in result && result.status === 200 && result.body === 'web-ok', `ゲートウェイ経由で、名前の宛先に届かない: ${JSON.stringify(result)}`);
  check(hits.includes('GET /p?x=1'), `宛先が、origin-form の要求を受けていない: ${hits.join(', ')}`);
  check(resolved.includes('web.test'), `名前を、ゲートウェイが解決していない: ${resolved.join(', ')}`);
}

// (2) 同梱の Yahoo 検索バイナリ。環境には、NO_PROXY（Yahoo の名前入り）がある。子プロセスには、渡らないはず
{
  resolved.length = 0;
  process.env.NO_PROXY = noProxy;
  const before = deniedPrivate();
  const result = await callYahooMcp('yahoo_web_search', { query: 'sora egress check' }, 30_000).then(
    (response) => response as { isError?: boolean },
    (error: unknown) => ({ error: String(error) }),
  );
  check(resolved.includes('search.yahoo.co.jp'), `Yahoo のバイナリの通信が、ゲートウェイを通っていない（名前を、ゲートウェイが解決していない）: ${resolved.join(', ')}`);
  check(deniedPrivate() - before >= 1, `ゲートウェイが、Yahoo のバイナリの接続（内部の IP に解決した名前）を断っていない: ${deniedPrivate() - before}`);
  check('isError' in result && result.isError === true, `断られたのに、Yahoo のバイナリが、直接つないで、応答を返した: ${JSON.stringify(result).slice(0, 200)}`);
}

// (3) 住所データの構築の子プロセス（Bun）。その fetch が、ゲートウェイを通る
{
  resolved.length = 0;
  hits.length = 0;
  process.env.NO_PROXY = noProxy;
  const code = `const response = await fetch('http://web.test:${webPort}/child'); process.exit(response.status === 200 && (await response.text()) === 'web-ok' ? 0 : 3);`;
  const outcome = await new ChildProcessBuilder({ dir: '/tmp/fetch-egress-check', command: () => [process.execPath, '-e', code] }).run({ kind: 'postal' }).then(
    () => 'ok',
    (error: unknown) => String(error),
  );
  check(outcome === 'ok', `構築の子プロセスの fetch が、ゲートウェイ経由で、宛先に届かない: ${outcome}`);
  check(hits.includes('GET /child'), `構築の子プロセスの要求が、宛先に届いていない: ${hits.join(', ')}`);
  check(resolved.includes('web.test'), `構築の子プロセスの通信が、ゲートウェイを通っていない（名前を、ゲートウェイが解決していない）: ${resolved.join(', ')}`);
}

await stopEgressGateway();
web.close();

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: Bun の fetch と、通信する子プロセス（Yahoo のバイナリ・住所データの構築）の通信は、すべて出口のゲートウェイを通る。内部の宛先は断られ、NO_PROXY でも迂回せず、名前はゲートウェイが解決する');
process.exit(0);
