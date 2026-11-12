import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import net from 'node:net';
import { resetSecurityMetrics } from '../security/metrics.js';
import { egressGatewayOptionsFromEnv, getEgressGateway, isEgressGatewayEnabled, parseAllowedPorts, stopEgressGateway } from './egress.js';
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

  test('認識できない値は、使わず、警告を出す（打ち間違いに気づけるように）。同じ値の警告は 1 回だけ', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: 'enable-typo' })).toBe(false);
      expect(isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: 'enable-typo' })).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('SORA_EGRESS_GATEWAY');
      expect(String(warn.mock.calls[0][0])).toContain('enable-typo');
    } finally {
      warn.mockRestore();
    }
  });

  test('ALLOW_LOCAL_FETCH=true（内部への取得を許す、開発・テスト用の設定）のときは、使わない。警告を出す', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(isEgressGatewayEnabled({ SORA_EGRESS_GATEWAY: 'on', ALLOW_LOCAL_FETCH: 'true' })).toBe(false);
      expect(String(warn.mock.calls[0][0])).toContain('ALLOW_LOCAL_FETCH');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseAllowedPorts: 許す宛先ポート（SORA_EGRESS_PORTS）', () => {
  test.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['443', [443]],
    ['80,443', [80, 443]],
    [' 80 , 8080,443 ', [80, 8080, 443]],
    ['65535', [65535]],
  ])('%j は %j', (raw, expected) => {
    expect(parseAllowedPorts(raw)).toEqual(expected);
  });

  test.each(['abc', '0', '65536', '80,,443', '80;443', '-1', '1.5', '80 443'])('%j は、理由を添えたエラー（起動のときに気づく）', (raw) => {
    expect(() => parseAllowedPorts(raw)).toThrow('SORA_EGRESS_PORTS');
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

  test('対応していない上流（socks4 など）は、理由を添えたエラー。黙って、上流なしにはしない', () => {
    expect(() => egressGatewayOptionsFromEnv({ SORA_PROXY_URL: 'socks4://proxy.example:1080' })).toThrow('socks4');
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
