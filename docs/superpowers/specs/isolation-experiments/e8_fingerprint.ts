// E8（実行: README.md）。サンドボックス有効・非 root と、--no-sandbox・root で、ブラウザの指紋が同じか
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const sandbox = process.argv[2] === 'sandbox';
const args = [
  ...(sandbox ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
  '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--accept-lang=ja-JP,ja,en-US,en',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  `--user-data-dir=/tmp/ud-e8-${Math.random().toString(36).slice(2)}`,
];
const t0 = Date.now();
const browser = await puppeteer.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true, pipe: true, args, env: { PATH: process.env.PATH ?? '', HOME: '/tmp', TZ: 'Asia/Tokyo' } });
const launchMs = Date.now() - t0;
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.setContent('<html><body style="font-size:30px;font-family:sans-serif">日本語のテスト ABC 123</body></html>');
const data = await page.evaluate(() => {
  const h = (s: string) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return x >>> 0; };
  const c = document.createElement('canvas'); c.width = 300; c.height = 60;
  const ctx = c.getContext('2d')!; ctx.font = '22px sans-serif'; ctx.fillStyle = '#369'; ctx.fillText('日本語 ABC 123 ♪', 8, 36); ctx.beginPath(); ctx.arc(250, 30, 18, 0, 7); ctx.stroke();
  const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
  let webgl: unknown = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    webgl = { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), extensions: gl.getSupportedExtensions()?.length, pixel: Array.from(px) };
  }
  return { canvasHash: h(c.toDataURL()), webgl, ua: navigator.userAgent, cores: navigator.hardwareConcurrency, memory: (navigator as unknown as { deviceMemory?: number }).deviceMemory, plugins: navigator.plugins.length, languages: navigator.languages, platform: navigator.platform, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height, devicePixelRatio], webdriver: navigator.webdriver, fonts: document.fonts.size, audio: typeof AudioContext, hover: matchMedia('(hover: hover)').matches };
});
const shot = await page.screenshot({ type: 'png' });
const sb = await browser.newPage(); await sb.goto('chrome://sandbox').catch(() => {});
const sandboxLine = (await sb.evaluate(() => document.body.innerText).catch(() => '')).split('\n').find((l) => /adequately|NOT|not sandboxed|You are/i.test(l)) ?? '(none)';
console.log(JSON.stringify({ mode: sandbox ? 'sandbox(非root)' : 'no-sandbox(root)', uid: process.getuid?.(), launchMs, screenshotSha: createHash('sha256').update(shot).digest('hex').slice(0, 12), sandboxLine, ...data }));
await browser.close(); process.exit(0);
