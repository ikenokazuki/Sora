import { afterAll, describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import puppeteer, { type Browser } from 'puppeteer-core';
import { closeSharedBrowser, getBrowser, resolveChromiumPath } from './browser_engine.js';

/**
 * Sora が起動する Chromium は、ページの WebRTC に、UDP を直接送らせない。
 * RTCPeerConnection の STUN・TURN・ICE の候補は、任意の宛先へ UDP を送れ、出口のゲートウェイ・プロキシ・ページの通信の検査
 * （setupPageSecurity）のどれも通らない（内部の宛先への到達と、プロキシで運用しているときの実 IP の漏れになる）。
 * 手元の UDP の受け口を STUN・TURN サーバーに指定して、1 つも届かないことを確かめる。
 * 対照として、同じ環境の指定なしの Chromium からは届くことも確かめる（届かない環境では、何も確かめていないことになる）。
 * ICE は、ループバックのほかに IPv4 のインターフェースが無い環境（--network=none など）では何も送らないので、そのときは飛ばす。
 */
const chromePath = resolveChromiumPath();
const hasNetworkInterface = Object.values(networkInterfaces()).some((list) => list?.some((i) => i.family === 'IPv4' && !i.internal));
const udpTest = chromePath && hasNetworkInterface ? test : test.skip;

let control: Browser | undefined;
afterAll(async () => {
  await control?.close();
  await closeSharedBrowser();
});

/** ページの WebRTC に、手元の受け口を STUN・TURN サーバーとして使わせて、waitMs の間に届いた UDP の数を返す */
async function udpPacketsFrom(browser: Browser, waitMs: number): Promise<number> {
  let packets = 0;
  const socket = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0, socket: { data: () => void packets++ } });
  const page = await browser.newPage();
  try {
    await page.goto('data:text/html,<p>webrtc</p>');
    await page.evaluate(
      async (port: number, ms: number) => {
        const connection = new RTCPeerConnection({
          iceServers: [{ urls: [`stun:127.0.0.1:${port}`] }, { urls: [`turn:127.0.0.1:${port}?transport=udp`], username: 'u', credential: 'p' }],
        });
        connection.createDataChannel('probe');
        await connection.setLocalDescription(await connection.createOffer());
        await new Promise((resolve) => setTimeout(resolve, ms));
        connection.close();
      },
      socket.port,
      waitMs,
    );
    return packets;
  } finally {
    await page.close();
    socket.close();
  }
}

describe('Sora の Chromium の WebRTC', () => {
  udpTest('対照: 指定なしの Chromium は、STUN・TURN サーバーへ UDP を直接送る', async () => {
    control = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    expect(await udpPacketsFrom(control, 3000)).toBeGreaterThan(0);
  }, 60_000);

  udpTest('Sora の起動の指定では、UDP は 1 つも届かない', async () => {
    const { browser } = await getBrowser();
    expect(await udpPacketsFrom(browser, 4000)).toBe(0);
  }, 60_000);
});
