import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import net from 'node:net';
import { resetSecurityMetrics } from '../security/metrics.js';
import {
  egressChildProxyEnv,
  egressEndpointForSlot,
  egressGatewayOptionsFromEnv,
  egressOwnerAtLimit,
  egressOwnerToken,
  egressProxyUrlFor,
  getEgressGateway,
  isEgressGatewayEnabled,
  isEgressGatewayStarted,
  stopEgressGateway,
} from './egress.js';
import { childEnv } from '../security/child_env.js';
import { withEnv } from '../test_fixtures/env.js';
import { connectHead, createEgressTestKit, fakeResolver, readBytes } from './egress_test_kit.js';

const kit = createEgressTestKit();
const { startEchoServer, rawRequest } = kit;
afterEach(async () => {
  await stopEgressGateway();
  await kit.cleanup();
  resetSecurityMetrics();
});

describe('isEgressGatewayEnabled: 外向きの通信を、出口のゲートウェイに通すか（SORA_EGRESS_GATEWAY）', () => {
  test.each(['on', 'ON', ' true ', '1', 'yes'])('%j は、使う', (value) => {
    expect(isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: value })).toBe(true);
  });

  test.each([undefined, '', 'off', 'false', '0', 'no'])('%j は、使わない（これまでどおり）', (value) => {
    expect(isEgressGatewayEnabled(value === undefined ? {} : { SORA_EGRESS_GATEWAY: value })).toBe(false);
  });

  test.each(['enable-typo', 'auto', '2', 'onn'])('書き方の誤り %j は、使わないことにせず、変数名と正しい形のエラー（打ち間違いで、検査が黙って外れない）', (value) => {
    let message = '';
    try {
      isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: value });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('SORA_EGRESS_GATEWAY');
    expect(message).toContain('true・false・1・0・on・off・yes・no');
  });

  test('SORA_FETCH_ALLOW_PRIVATE_NETWORK=true（内部への取得を許す、開発・テスト用の設定）のときは、使わない。警告を出す', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' })).toBe(false);
      expect(String(warn.mock.calls[0][0])).toContain('SORA_FETCH_ALLOW_PRIVATE_NETWORK');
    } finally {
      warn.mockRestore();
    }
  });

  test.each([undefined, 'false', '0', 'off'])('SORA_FETCH_ALLOW_PRIVATE_NETWORK=%j のときは、on なら使う', (value) => {
    const env = value === undefined ? { SORA_EGRESS_GATEWAY: 'on' } : { SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: value };
    expect(isEgressGatewayEnabled(env)).toBe(true);
  });
});

describe('SORA_EGRESS_PORTS: 許す宛先ポート', () => {
  test.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['443', [443]],
    ['80,443', [80, 443]],
    [' 80 , 8080,443 ', [80, 8080, 443]],
    ['65535', [65535]],
    // ほかの列の設定と同じ読み方: 空の要素は読み飛ばし、先頭の 0 は外し、重複は 1 つにする
    ['80,,443', [80, 443]],
    ['080,80', [80]],
  ])('%j は %j（未設定は、ゲートウェイの既定の 80・443）', (raw, expected) => {
    expect(egressGatewayOptionsFromEnv(raw === undefined ? {} : { SORA_EGRESS_PORTS: raw }).allowedPorts).toEqual(expected);
  });

  test.each(['abc', '0', '65536', '80;443', '-1', '1.5', '80 443', '80,abc'])('%j は、変数名と正しい形のエラー（黙って、既定のポートにしない）', (raw) => {
    expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_PORTS: raw })).toThrow('SORA_EGRESS_PORTS');
  });
});

describe('egressGatewayOptionsFromEnv: 環境変数から、ゲートウェイの設定を作る', () => {
  test('運用者のプロキシも、ポートの指定もなければ、何も指定しない（既定のまま）', () => {
    const options = egressGatewayOptionsFromEnv({});
    expect(options.upstream).toBeUndefined();
    expect(options.bypassUpstream).toBeUndefined();
    expect(options.allowedPorts).toBeUndefined();
  });

  test('SORA_PROXY_URL を、上流に読む（socks5・資格情報つき）', () => {
    const options = egressGatewayOptionsFromEnv({ SORA_PROXY_URL: 'socks5://user:p%40ss@proxy.example:1081' });
    expect(options.upstream).toEqual({ type: 'socks5', host: 'proxy.example', port: 1081, username: 'user', password: 'p@ss' });
  });

  test('優先順位は、いまのブラウザ・静的取得と同じ（SORA_PROXY_URL > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY）', () => {
    const env = { HTTP_PROXY: 'http://http-proxy:8080', ALL_PROXY: 'socks5://all-proxy:1080' };
    expect(egressGatewayOptionsFromEnv(env).upstream?.host).toBe('http-proxy');
    expect(egressGatewayOptionsFromEnv({ ...env, HTTPS_PROXY: 'http://https-proxy:8443' }).upstream?.host).toBe('https-proxy');
    expect(egressGatewayOptionsFromEnv({ ...env, HTTPS_PROXY: 'http://https-proxy:8443', SORA_PROXY_URL: 'http://sora-proxy:3128' }).upstream?.host).toBe('sora-proxy');
    expect(egressGatewayOptionsFromEnv({ ALL_PROXY: 'socks5://all-proxy:1080' }).upstream?.type).toBe('socks5');
  });

  test('NO_PROXY の宛先は、上流を使わない（いまのブラウザの --proxy-bypass-list と同じ指定。IP・CIDR・サブドメインを含む）', () => {
    const options = egressGatewayOptionsFromEnv({ SORA_PROXY_URL: 'http://proxy.example:3128', NO_PROXY: '.corp.example,10.1.2.3,192.168.0.0/16' });
    const bypass = options.bypassUpstream;
    expect(bypass?.('a.corp.example')).toBe(true);
    expect(bypass?.('10.1.2.3')).toBe(true);
    expect(bypass?.('192.168.5.5')).toBe(true);
    expect(bypass?.('public.example')).toBe(false);
    expect(bypass?.('10.1.2.4')).toBe(false);
  });

  test('SORA_PROXY_LIST（静的取得の、リクエストごとに替えるプロキシの一覧）は、ゲートウェイの上流（1 つ）にできない。黙って無視せず、理由を添えたエラー', () => {
    expect(() => egressGatewayOptionsFromEnv({ SORA_PROXY_LIST: 'http://a.example:3128,http://b.example:3128' })).toThrow('SORA_PROXY_LIST');
    expect(() => egressGatewayOptionsFromEnv({ SORA_PROXY_LIST: '   ' })).not.toThrow(); // 空白だけは、未設定と同じ
  });

  test('SORA_PROXY_LIST の書き方の誤りも、変数名と正しい形のエラー（値は出さない）。黙って、一覧を無いものとして扱わない', () => {
    let message = '';
    try {
      egressGatewayOptionsFromEnv({ SORA_PROXY_LIST: 'socks4://user:secret@a.example:1080' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('SORA_PROXY_LIST');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('a.example');
  });

  test('SORA_PROXY_URL が対応していない方式（socks4 など）なら、変数名と正しい形のエラー（値は出さない）。黙って、上流なしにはしない', () => {
    let message = '';
    try {
      egressGatewayOptionsFromEnv({ SORA_PROXY_URL: 'socks4://user:secret@proxy.example:1080' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('SORA_PROXY_URL');
    expect(message).toContain('socks5');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('proxy.example');
  });

  test('標準の HTTPS_PROXY が対応していない方式（socks4）のときも、理由を添えたエラー。黙って、上流なしにはしない', () => {
    expect(() => egressGatewayOptionsFromEnv({ HTTPS_PROXY: 'socks4://proxy.example:1080' })).toThrow('socks4');
  });

  test('SORA_EGRESS_PORTS を、許すポートにする。誤りは、エラー', () => {
    expect(egressGatewayOptionsFromEnv({ SORA_EGRESS_PORTS: '80,443,8443' }).allowedPorts).toEqual([80, 443, 8443]);
    expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_PORTS: 'abc' })).toThrow('SORA_EGRESS_PORTS');
  });
});

describe('getEgressGateway: プロセスで 1 つの、出口のゲートウェイ（使うときに、初めて起動する）', () => {
  // テストの事前設定（test_preload.ts）は、外へ出ないよう、プロキシの環境変数に、閉じたポートの架空のプロキシを入れている。
  // ゲートウェイは、それを運用者の上流として読むので、このテストの間だけ外す
  const proxyKeys = ['SORA_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
    for (const key of proxyKeys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const permissive = async () => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    return { echo, options: { allowedPorts: [echo.port], resolve, isPrivateIp: () => false } };
  };

  test('呼ぶと、ループバックで待ち受けを始め、url を返す。実際に中継する', async () => {
    const { echo, options } = await permissive();
    const endpoint = await getEgressGateway(options);

    expect(endpoint.host).toBe('127.0.0.1');
    expect(endpoint.url).toBe(`http://127.0.0.1:${endpoint.port}`);
    const reply = await rawRequest(endpoint.port, connectHead(`echo.test:${echo.port}`));
    expect(reply.status).toBe(200);
    reply.socket.write('ping');
    expect((await readBytes(reply.socket, 4, reply.rest)).toString()).toBe('ping');
  });

  test('2 回目以降は、同じゲートウェイ。同時に呼んでも、起動は 1 回', async () => {
    const { options } = await permissive();
    const endpoints = await Promise.all([getEgressGateway(options), getEgressGateway(), getEgressGateway({ allowedPorts: [1] })]);

    expect(new Set(endpoints.map((endpoint) => endpoint.port)).size).toBe(1);
  });

  test('stopEgressGateway のあとは、もとのポートに接続できない。もう一度呼ぶと、新しく始める', async () => {
    const { options } = await permissive();
    const first = await getEgressGateway(options);
    await stopEgressGateway();
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: first.port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      }),
    ).rejects.toThrow();

    const second = await getEgressGateway(options);
    expect(second.url).toBe(`http://127.0.0.1:${second.port}`);
  });

  test('環境変数の設定の誤りで起動に失敗しても、その失敗を覚えない（直して、もう一度呼べる）', async () => {
    const previous = process.env.SORA_EGRESS_PORTS;
    process.env.SORA_EGRESS_PORTS = 'not-a-port';
    try {
      await expect(getEgressGateway()).rejects.toThrow('SORA_EGRESS_PORTS');
      process.env.SORA_EGRESS_PORTS = '443';
      const endpoint = await getEgressGateway();
      expect(endpoint.port).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.SORA_EGRESS_PORTS;
      else process.env.SORA_EGRESS_PORTS = previous;
    }
  });
});

describe('利用者ごとの接続の数え方（印つきの URL・ブラウザのプロセスごとの受け口）', () => {
  // getEgressGateway の describe と同じく、テストの事前設定の架空のプロキシを、この間だけ外す
  const proxyKeys = ['SORA_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
    for (const key of proxyKeys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const permissive = async (extra: Record<string, unknown> = {}) => {
    const echo = await startEchoServer();
    const { resolve } = fakeResolver({ 'echo.test': ['127.0.0.1'] });
    return { target: `echo.test:${echo.port}`, options: { allowedPorts: [echo.port], resolve, isPrivateIp: () => false, ...extra } };
  };
  /** URL の資格情報を、本体の取得（wreq-js・Bun の fetch）と同じに Proxy-Authorization で送る CONNECT */
  const connectVia = (proxyUrl: string, target: string) => {
    const url = new URL(proxyUrl);
    const auth = url.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${url.password}`).toString('base64')}\r\n` : '';
    return rawRequest(Number(url.port), `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  };

  test('egressOwnerToken: 利用者の ID から作る、決まった 16 進 24 字（利用者の名前は URL に出さない）。利用者が違えば違う', () => {
    const alice = egressOwnerToken('name:alice');
    expect(alice).toMatch(/^[0-9a-f]{24}$/);
    expect(egressOwnerToken('name:alice')).toBe(alice);
    expect(egressOwnerToken('name:bob')).not.toBe(alice);
    expect(alice).not.toContain('alice');
  });

  test('egressProxyUrlFor: ゲートウェイの URL に、利用者の印を付ける。その URL で通した接続は、その利用者の数に入る', async () => {
    const { target, options } = await permissive({ maxConnections: 4, ownerSharePercent: 25 }); // 1 人 1 本
    const endpoint = await getEgressGateway(options);
    const aliceUrl = await egressProxyUrlFor('name:alice');
    expect(aliceUrl).toBe(`http://${egressOwnerToken('name:alice')}:@127.0.0.1:${endpoint.port}`);

    expect((await connectVia(aliceUrl, target)).status).toBe(200);
    expect(egressOwnerAtLimit('name:alice')).toBe(true);
    expect(egressOwnerAtLimit('name:bob')).toBe(false);
    const again = await connectVia(aliceUrl, target);
    expect(again.status).toBe(503);
    expect(again.headers['x-sora-egress-deny']).toBe('tenant_limit');
    expect((await connectVia(await egressProxyUrlFor('name:bob'), target)).status).toBe(200);
  });

  test('egressEndpointForSlot: ブラウザのプロセスの番号ごとの受け口。そこへの接続は、いまその番号を持つ利用者の数に入る', async () => {
    const { target, options } = await permissive({ maxConnections: 8, ownerSharePercent: 25 }); // 1 人 2 本
    const main = await getEgressGateway(options);
    const slot0 = await egressEndpointForSlot(0, 'name:alice');
    expect(slot0.port).not.toBe(main.port);
    expect(slot0.url).toBe(`http://127.0.0.1:${slot0.port}`);
    expect((await egressEndpointForSlot(1, 'name:bob')).port).not.toBe(slot0.port);

    // 同じ利用者の、本体の取得（印つきの URL）と、ブラウザ（番号の受け口）は、同じ数に入る
    expect((await connectVia(await egressProxyUrlFor('name:alice'), target)).status).toBe(200);
    expect((await connectVia(slot0.url, target)).status).toBe(200);
    expect((await connectVia(slot0.url, target)).status).toBe(503);

    // 番号を別の利用者に渡したあとの接続は、新しい利用者の数に入る（受け口は同じ）
    const reassigned = await egressEndpointForSlot(0, 'name:carol');
    expect(reassigned.port).toBe(slot0.port);
    expect((await connectVia(reassigned.url, target)).status).toBe(200);
    expect(egressOwnerAtLimit('name:carol')).toBe(false);
  });

  test('stopEgressGateway で、番号の受け口も閉じる。次に呼ぶと、新しい受け口を作る', async () => {
    const { target, options } = await permissive();
    await getEgressGateway(options);
    const before = await egressEndpointForSlot(0, 'name:alice');
    await stopEgressGateway();
    await getEgressGateway(options);
    const after = await egressEndpointForSlot(0, 'name:alice');
    expect((await connectVia(after.url, target)).status).toBe(200);
    if (after.port !== before.port) {
      await expect(connectVia(before.url, target)).rejects.toThrow();
    }
  });

  test('ゲートウェイが動いていなければ、egressOwnerAtLimit は false（数えるものが無い）', () => {
    expect(egressOwnerAtLimit('name:alice')).toBe(false);
  });

  test('利用者ごとの割合は、水準の表から読む: strict は 25%（ここでは全体 8 本で 1 人 2 本）、standard は利用者ごとの上限なし', async () => {
    for (const [level, perOwner] of [['strict', 2], ['standard', 8]] as const) {
      await withEnv({ SORA_ISOLATION: level }, async () => {
        const { target, options } = await permissive({ maxConnections: 8 });
        await getEgressGateway(options);
        const url = await egressProxyUrlFor('name:alice');
        const statuses: number[] = [];
        for (let i = 0; i <= perOwner; i++) statuses.push((await connectVia(url, target)).status);
        expect(statuses).toEqual([...Array(perOwner).fill(200), 503]);
        await stopEgressGateway();
      });
    }
  });
});

describe('isEgressGatewayStarted: ゲートウェイを始めたか', () => {
  const proxyKeys = ['SORA_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
    for (const key of proxyKeys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('使うまでは始めていない。getEgressGateway で始め、stopEgressGateway で止まる', async () => {
    expect(isEgressGatewayStarted()).toBe(false);
    await getEgressGateway();
    expect(isEgressGatewayStarted()).toBe(true);
    await stopEgressGateway();
    expect(isEgressGatewayStarted()).toBe(false);
  });
});

describe('egressChildProxyEnv: 子プロセス（Yahoo のバイナリ・住所データの構築）の通信も、ゲートウェイに通す（HTTP(S)_PROXY で渡す）', () => {
  const keys = ['SORA_EGRESS_GATEWAY', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK', 'SORA_PROXY_URL', 'SORA_PROXY_LIST', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('off のときは、何も足さず、ゲートウェイも始めない（子プロセスの環境は、これまでどおり）', async () => {
    expect(await egressChildProxyEnv()).toEqual({});
    expect(isEgressGatewayStarted()).toBe(false);
  });

  test('on のとき、HTTP_PROXY・HTTPS_PROXY（大文字・小文字）は、ゲートウェイの url。ALL_PROXY・NO_PROXY は、消す', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'on';
    const endpoint = await getEgressGateway();

    const extra = await egressChildProxyEnv();

    expect(extra).toEqual({ HTTP_PROXY: endpoint.url, HTTPS_PROXY: endpoint.url, http_proxy: endpoint.url, https_proxy: endpoint.url });
    for (const name of ['ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) expect(name in extra && extra[name] === undefined, name).toBe(true);
  });

  test('childEnv に重ねると、運用者の上流・ALL_PROXY・NO_PROXY は、子プロセスに残らず、ゲートウェイだけを指す', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'on';
    const endpoint = await getEgressGateway();
    const source = { PATH: '/bin', LANG: 'C', HTTPS_PROXY: 'http://upstream.example:3128', http_proxy: 'http://upstream.example:3128', ALL_PROXY: 'socks5://upstream.example:1080', NO_PROXY: 'localhost,.internal', no_proxy: 'localhost' };

    const env = childEnv(await egressChildProxyEnv(), source);

    expect(env).toEqual({ PATH: '/bin', LANG: 'C', HTTP_PROXY: endpoint.url, HTTPS_PROXY: endpoint.url, http_proxy: endpoint.url, https_proxy: endpoint.url });
  });

  test('on で、ゲートウェイを始められないとき（設定の誤り）は、失敗する（子プロセスに、直接の経路を、黙って渡さない）', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'on';
    process.env.SORA_PROXY_LIST = 'http://proxy-a.example:8080';
    await expect(egressChildProxyEnv()).rejects.toThrow('SORA_PROXY_LIST');
  });

  test('SORA_FETCH_ALLOW_PRIVATE_NETWORK=true のときは、ゲートウェイを使わないので、何も足さない', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.SORA_EGRESS_GATEWAY = 'on';
      process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
      expect(await egressChildProxyEnv()).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SORA_EGRESS_ALLOW_HOSTS: 内部の宛先を、通す宛先として挙げる', () => {
  test('host:port の一覧を、allowDestinations にする（名前は小文字・末尾のドットなし、IPv6 は [ ] を外す）。未設定・空は、何も指定しない', () => {
    expect(egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: 'FxEmbed.Internal:3000, 10.0.0.5:8080 ,[fd00::5]:8443' }).allowDestinations).toEqual([
      { host: 'fxembed.internal', port: 3000 },
      { host: '10.0.0.5', port: 8080 },
      { host: 'fd00::5', port: 8443 },
    ]);
    expect(egressGatewayOptionsFromEnv({}).allowDestinations).toBeUndefined();
    expect(egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: '  ' }).allowDestinations).toBeUndefined();
  });

  test('公開の宛先（標準でないポート）も、挙げられる', () => {
    expect(egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: 'api.example.com:8443,93.184.216.34:8443' }).allowDestinations).toEqual([
      { host: 'api.example.com', port: 8443 },
      { host: '93.184.216.34', port: 8443 },
    ]);
  });

  test.each(['noport.internal', 'host:0', 'host:70000', '*.internal:80', 'http://host:80', '10.0.0.0/8:80', '0x7f.1:80', '2130706433:80', '127.1:80', '010.0.0.1:80', 'a b:80', '[::1:80', '[zz::1]:80', ':80', 'host:', 'host:80:90', '.internal:80', 'a..b:80', '[10.0.0.1]:80'])(
    '書き方の誤り %j は、変数名と正しい形のエラー（黙って、無いものとして扱わない）',
    (entry) => {
      expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: entry })).toThrow('SORA_EGRESS_ALLOW_HOSTS の値');
    },
  );

  test.each(['169.254.169.254:80', 'metadata.google.internal:80', 'instance-data:80', '[fe80::1]:80', '0.0.0.0:80', '224.0.0.1:80', '[::]:80', '192.0.2.5:80', '100.100.100.200:80', '[fd00:ec2::254]:80', '[FD00:EC2:0:0:0:0:0:254]:80'])(
    '挙げても通さない宛先 %j は、理由を添えたエラー（黙って、通さないまま起動しない）',
    (entry) => {
      expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: entry })).toThrow('SORA_EGRESS_ALLOW_HOSTS に、挙げても通さない宛先があります');
    },
  );

  test('通さない宛先の拒否の文には、どの宛先かを添える（登録簿が整えた形で）', () => {
    expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: 'fxembed.internal:3000, 169.254.169.254:80' })).toThrow('169.254.169.254:80');
    expect(() => egressGatewayOptionsFromEnv({ SORA_EGRESS_ALLOW_HOSTS: '[FE80::1]:80' })).toThrow('[fe80::1]:80');
  });
});
