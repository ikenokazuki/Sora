import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import dgram from 'node:dgram';
import net from 'node:net';
import { closeSharedBrowser, getBrowser, resolveChromiumPath } from '../browser_engine.js';
import { isEgressGatewayEnabled, isEgressGatewayStarted, stopEgressGateway } from '../net/egress.js';
import { wavBytes } from '../test_fixtures/audio.js';
import { withEnv } from '../test_fixtures/env.js';
import { AudioDecodeError, createOfflineContext, decodeAudioWindows, lockPageOffline } from './audio_decode.js';

/**
 * 音声のデコード用のページを、通信できず・移動もしない状態にする（設計 2。段階 6b。穴 28）。
 * 利用者（や、利用者が指した先）のバイト列を、メディアのデコーダーに入れるページなので、そのページから外へ出る道を閉じる。
 * 閉じ方は 3 重: (1) 専用のコンテキストの通信を、行き先の無いプロキシに向ける（ブラウザ本体の通信。ページの要求の割り込みが見えない
 * prerender・投機的な取得・WebRTC の TCP・移動の試みの TCP 接続・ポップアップも止まる）、(2) ページの要求の割り込み、(3) オフライン。
 */

type Handler = (request: unknown) => void;

/** puppeteer の Page の、lockPageOffline が使う部分だけの偽物 */
function fakePage(options: { failInterception?: boolean; failOffline?: boolean } = {}) {
  const calls: string[] = [];
  const handlers: Handler[] = [];
  const page = {
    setRequestInterception: async (on: boolean) => {
      calls.push(`interception:${on}`);
      if (options.failInterception) throw new Error('interception failed');
    },
    setOfflineMode: async (on: boolean) => {
      calls.push(`offline:${on}`);
      if (options.failOffline) throw new Error('offline failed');
    },
    on: (event: string, handler: Handler) => {
      calls.push(`on:${event}`);
      handlers.push(handler);
    },
  };
  return { page: page as never, calls, handlers };
}

/** 要求の偽物。何をされたか（continue / abort と理由）を覚える */
function fakeRequest(url: string, isNavigation = false) {
  const outcome: string[] = [];
  const request = {
    url: () => url,
    isNavigationRequest: () => isNavigation,
    continue: async () => { outcome.push('continue'); },
    abort: async (reason?: string) => { outcome.push(`abort:${reason}`); },
  };
  return { request, outcome };
}

describe('lockPageOffline（偽のページ）', () => {
  test('要求の割り込みと、オフラインの両方を有効にする', async () => {
    const { page, calls } = fakePage();
    await lockPageOffline(page);
    expect(calls).toContain('interception:true');
    expect(calls).toContain('offline:true');
    expect(calls).toContain('on:request');
  });

  test.each([
    'http://example.com/',
    'https://example.com/a.mp3',
    'ws://example.com/socket',
    'ftp://example.com/',
    'file:///etc/passwd',
    'chrome://version/',
    'http://169.254.169.254/latest/meta-data/',
    // 途中に blob:・data:・about: を含むだけの URL（先頭で見分けないと、通ってしまう）
    'http://example.com/?next=data:text/plain,x',
    'https://example.com/blob:null/1234',
    'https://example.com/about:blank',
  ])('ネットワーク・ファイルへの要求は断る: %s', async (url) => {
    const { page, handlers } = fakePage();
    await lockPageOffline(page);
    const { request, outcome } = fakeRequest(url);
    handlers[0](request);
    await Promise.resolve();
    expect(outcome).toEqual(['abort:blockedbyclient']);
  });

  test.each(['blob:null/1234', 'data:audio/wav;base64,AAAA', 'about:blank'])('ページの中だけで完結する要求（%s）は通す', async (url) => {
    const { page, handlers } = fakePage();
    await lockPageOffline(page);
    const { request, outcome } = fakeRequest(url);
    handlers[0](request);
    await Promise.resolve();
    expect(outcome).toEqual(['continue']);
  });

  test.each(['blob:null/1234', 'data:text/html,<b>x</b>', 'about:blank'])('ページの移動（%s）は、中だけで完結するものでも断る', async (url) => {
    const { page, handlers } = fakePage();
    await lockPageOffline(page);
    const { request, outcome } = fakeRequest(url, true);
    handlers[0](request);
    await Promise.resolve();
    expect(outcome).toEqual(['abort:blockedbyclient']);
  });

  test('要求への返答が失敗しても（ページが閉じた後など）、握って、未処理の拒否にしない', async () => {
    const { page, handlers } = fakePage();
    await lockPageOffline(page);
    const rejecting = {
      url: () => 'http://example.com/',
      isNavigationRequest: () => false,
      continue: async () => { throw new Error('already handled'); },
      abort: async () => { throw new Error('Target closed'); },
    };
    // 握っていなければ、返答の失敗が未処理の拒否になり、Bun のテストが失敗する。
    // （expect(() => …).not.toThrow() の中で呼ぶと、その拒否は見逃されるので、直に呼ぶ）
    handlers[0](rejecting);
    handlers[0]({ ...rejecting, url: () => 'blob:null/1234' });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test('割り込みを有効にできなかったら、閉じられていないので、失敗させる（黙って通さない）', async () => {
    await expect(lockPageOffline(fakePage({ failInterception: true }).page)).rejects.toThrow('interception failed');
  });

  test('オフラインにできなかったときも、失敗させる', async () => {
    await expect(lockPageOffline(fakePage({ failOffline: true }).page)).rejects.toThrow('offline failed');
  });
});

/**
 * ヒットを数えるローカルのサーバー（ページから届くかを、サーバー側で確かめる）。
 * 届いた HTTP の要求のパスと、TCP の接続の数・UDP のパケットの数（要求の行まで届かない、つなぎだけの接触も数える）。
 */
function hitServer() {
  const paths = new Set<string>();
  let contacts = 0;
  const tcp = net.createServer((socket) => {
    contacts++;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      const match = /^[A-Z]+ (\S+) HTTP/.exec(buffer);
      if (match) paths.add(new URL(match[1], 'http://x').pathname);
      buffer = '';
      socket.end('HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    socket.on('error', () => undefined);
  });
  tcp.listen(0, '127.0.0.1');
  const port = (tcp.address() as net.AddressInfo).port;
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => { contacts++; });
  udp.bind(port, '127.0.0.1'); // 同じ番号で、UDP（STUN）も待つ
  return {
    port,
    target: `http://127.0.0.1:${port}/`,
    paths,
    contacts: () => contacts,
    stop: () => { tcp.close(); udp.close(); },
  };
}

/**
 * ページの中で、ネットワークへ出ようとする（puppeteer が関数の文字列を送る。外の変数を参照しない）。
 * fetch・Worker・WebSocket・Worker の WebSocket・prerender・投機的な取得（Speculation Rules）・WebRTC（STUN の UDP と TURN の TCP）・ポップアップ。
 * navigate: iframe（http と https）と、ページ自身の移動も試す
 */
const reachOut = async (target: string, port: number, navigate: boolean) => {
  const rules = document.createElement('script');
  rules.type = 'speculationrules';
  rules.textContent = JSON.stringify({ prefetch: [{ urls: [`${target}spec_prefetch`] }] });
  document.head.append(rules);
  const main = await fetch(`${target}fetch`).then(() => 'reached', () => 'blocked');
  const inWorker = (source: string) => new Worker(URL.createObjectURL(new Blob([source])));
  const worker = inWorker(`fetch(${JSON.stringify(`${target}worker`)}).then(() => postMessage('reached'), () => postMessage('blocked'))`);
  const fromWorker = await new Promise<string>((resolve) => {
    worker.onmessage = (event) => resolve(String(event.data));
    setTimeout(() => resolve('blocked'), 3000);
  });
  inWorker(`new WebSocket('ws://127.0.0.1:${port}/worker_ws')`);
  try { new WebSocket(`ws://127.0.0.1:${port}/websocket`); } catch {}
  const prerender = document.createElement('link');
  prerender.rel = 'prerender';
  prerender.href = `${target}link_prerender`;
  document.head.append(prerender);
  try {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: [`stun:127.0.0.1:${port}`, `turn:127.0.0.1:${port}?transport=tcp`], username: 'a', credential: 'b' }] });
    peer.createDataChannel('x');
    peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => undefined);
  } catch {}
  window.open(`${target}window_open`);
  if (navigate) {
    for (const [name, scheme] of [['iframe', 'http'], ['iframe_https', 'https']]) {
      const frame = document.createElement('iframe');
      frame.src = `${scheme}://127.0.0.1:${port}/${name}`;
      document.body.append(frame);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  // ページ自身の移動は、最後に（移動すると、この関数の戻り値を返せなくなる）
  if (navigate) setTimeout(() => { location.href = `${target}navigate`; }, 50);
  return { main, fromWorker };
};

/** ページの中で、先読み（prerender と Speculation Rules の投機的な取得）だけを試す。移動はしない（移動すると、始まる前の先読みは取り消される） */
const speculateOnly = (target: string) => {
  const rules = document.createElement('script');
  rules.type = 'speculationrules';
  rules.textContent = JSON.stringify({ prefetch: [{ urls: [`${target}spec_prefetch`] }] });
  document.head.append(rules);
  const prerender = document.createElement('link');
  prerender.rel = 'prerender';
  prerender.href = `${target}link_prerender`;
  document.head.append(prerender);
};

describe.skipIf(!resolveChromiumPath())('デコード用のコンテキストとページ（実 Chromium）', () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  test('対照: 閉じていないコンテキスト・ページは、ローカルのサーバーに、HTTP も TCP・UDP も届く（この試験が、届かないだけで通らないことの確認）', async () => {
    const { browser } = await getBrowser();
    const server = hitServer();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const result = await page.evaluate(reachOut, server.target, server.port, true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(result).toEqual({ main: 'reached', fromWorker: 'reached' });
      // 移動先のページが、アイコン（/favicon.ico）も取りに来ることがあるので、含まれていることを確かめる
      expect([...server.paths]).toEqual(expect.arrayContaining(['/fetch', '/worker', '/websocket', '/worker_ws', '/window_open', '/iframe', '/navigate']));
      // prerender と投機的な取得は、Chromium の判断で動く（版・状況で、どちらかしか動かないことがある）ので、どちらかが届けばよい。
      // 始まる前にページが移動すると取り消されるので（混んだ CI で 1 回、どちらも届かなかった）、届いていなければ、移動しないページで試し直す
      const speculated = () => server.paths.has('/link_prerender') || server.paths.has('/spec_prefetch');
      if (!speculated()) {
        const again = await context.newPage();
        await again.evaluate(speculateOnly, server.target);
        for (const deadline = Date.now() + 10_000; !speculated() && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(speculated()).toBe(true);
      expect(server.contacts()).toBeGreaterThan(9);
    } finally {
      await context.close();
      server.stop();
    }
  }, 60000);

  test('閉じたコンテキスト・ページは、fetch・Worker・WebSocket・prerender・投機的な取得・WebRTC・ポップアップ・iframe・ページの移動のどれも、ローカルのサーバーに、つなぎだけでも届かない', async () => {
    const { browser } = await getBrowser();
    const server = hitServer();
    const context = await createOfflineContext(browser);
    try {
      const page = await context.newPage();
      await lockPageOffline(page);
      const result = await page.evaluate(reachOut, server.target, server.port, true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(result).toEqual({ main: 'blocked', fromWorker: 'blocked' });
      expect([...server.paths]).toEqual([]);
      expect(server.contacts()).toBe(0);
    } finally {
      await context.close();
      server.stop();
    }
  }, 60000);

  test('閉じたコンテキスト・ページでも、バイト列を blob の <audio> に入れて長さを読むことと、decodeAudioData は、できる', async () => {
    const { browser } = await getBrowser();
    const context = await createOfflineContext(browser);
    try {
      const page = await context.newPage();
      await lockPageOffline(page);
      const out = await page.evaluate(async (b64: string) => {
        const bin = atob(b64);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const el = new Audio();
        const duration = await new Promise<number | string>((resolve) => {
          el.preload = 'metadata';
          el.onloadedmetadata = () => resolve(el.duration);
          el.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 5000);
          el.src = URL.createObjectURL(new Blob([data]));
        });
        const buffer = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(data.buffer as ArrayBuffer);
        return { duration, decoded: buffer.duration };
      }, Buffer.from(wavBytes(3)).toString('base64'));
      expect(out.duration).toBeCloseTo(3, 1);
      expect(out.decoded).toBeCloseTo(3, 1);
    } finally {
      await context.close();
    }
  }, 60000);
});

describe.skipIf(!resolveChromiumPath())('decodeAudioWindows は、閉じたコンテキストとページで、バイト列を処理する', () => {
  afterAll(async () => {
    await closeSharedBrowser();
    // 出口のゲートウェイは、プロセスで 1 つ。起動したままにすると、あとに走る別のテストファイルが、古い設定のゲートウェイに当たる（CI で、egress_fetch.test.ts が 403 になった）
    expect(isEgressGatewayStarted()).toBe(false);
  });

  test('ページへの最初の操作（バイト列を渡す前）の時点で、外へ出る道が全部閉じている。デコード自体は、これまでどおり動く', async () => {
    const { browser } = await getBrowser();
    const server = hitServer();
    const realCreate = browser.createBrowserContext.bind(browser);
    let observed: unknown;
    let firstEvaluate = true;
    const spy = spyOn(browser, 'createBrowserContext').mockImplementation((async (...args: Parameters<typeof realCreate>) => {
      const context = await realCreate(...args);
      const realNewPage = context.newPage.bind(context);
      context.newPage = (async () => {
        const page = await realNewPage();
        const realEvaluate = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>;
        (page as unknown as { evaluate: unknown }).evaluate = async (fn: unknown, ...rest: unknown[]) => {
          if (firstEvaluate) {
            firstEvaluate = false;
            observed = await realEvaluate(reachOut, server.target, server.port, false);
          }
          return realEvaluate(fn, ...rest);
        };
        return page;
      }) as typeof context.newPage;
      return context;
    }) as never);
    try {
      const out = await decodeAudioWindows(wavBytes(3), () => [0]);
      expect(out.durationSec).toBeCloseTo(3, 1);
      expect(observed).toEqual({ main: 'blocked', fromWorker: 'blocked' });
      expect([...server.paths]).toEqual([]);
      expect(server.contacts()).toBe(0);
    } finally {
      spy.mockRestore();
      server.stop();
    }
  }, 60000);
  test('出口のゲートウェイを使う設定（SORA_EGRESS_GATEWAY=on。ブラウザ全体のプロキシがゲートウェイ）でも、コンテキストのプロキシが優先され、外へ出ずに、デコードできる', async () => {
    // SORA_FETCH_ALLOW_PRIVATE_NETWORK=true（手元で全件を回すときに、全体に渡すことがある）では、ゲートウェイは使われないので、外す
    await withEnv({ SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined }, async () => {
      expect(isEgressGatewayEnabled()).toBe(true);
      await closeSharedBrowser(); // 起動のときの設定（ゲートウェイ）で、ブラウザを起動し直す
      const server = hitServer();
      try {
        const out = await decodeAudioWindows(wavBytes(3), () => [0]);
        expect(out.durationSec).toBeCloseTo(3, 1);
        const { browser } = await getBrowser();
        const context = await createOfflineContext(browser);
        try {
          const page = await context.newPage();
          await lockPageOffline(page);
          const result = await page.evaluate(reachOut, server.target, server.port, false);
          expect(result).toEqual({ main: 'blocked', fromWorker: 'blocked' });
        } finally {
          await context.close();
        }
        expect(server.contacts()).toBe(0);
      } finally {
        server.stop();
        await closeSharedBrowser();
        // ゲートウェイは、プロセスで 1 つを使い回す。起動したままにすると、あとに走る別のテスト（既定の設定で起動し直す前提のもの）が、この設定のゲートウェイに当たる
        await stopEgressGateway();
      }
    });
  }, 120000);
  test('バイト列だけで起こしうる通信（HLS のプレイリストに書いたセグメントの URL を、メディアのデコーダーが取りに行く）: 閉じていないと届く。decodeAudioWindows は、届かず、これまでどおり AudioDecodeError', async () => {
    const playlist = (port: number) => new TextEncoder().encode(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttp://127.0.0.1:${port}/seg0.ts\n#EXT-X-ENDLIST\n`);
    // 対照: 閉じていないコンテキストで、デコード用のページと同じく、<audio> と decodeAudioData に渡す
    const control = hitServer();
    const { browser } = await getBrowser();
    const plain = await browser.createBrowserContext();
    try {
      const page = await plain.newPage();
      await page.evaluate(async (b64: string) => {
        const bin = atob(b64);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const el = new Audio();
        el.preload = 'metadata';
        el.src = URL.createObjectURL(new Blob([data]));
        await new OfflineAudioContext(1, 1, 16000).decodeAudioData(data.buffer as ArrayBuffer).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }, Buffer.from(playlist(control.port)).toString('base64'));
      expect(control.paths.has('/seg0.ts')).toBe(true);
    } finally {
      await plain.close();
      control.stop();
    }
    // decodeAudioWindows は、同じバイト列で、どこへもつながらない
    const server = hitServer();
    try {
      const error = await decodeAudioWindows(playlist(server.port), () => [0]).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(AudioDecodeError);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect([...server.paths]).toEqual([]);
      expect(server.contacts()).toBe(0);
    } finally {
      server.stop();
    }
  }, 60000);
});
