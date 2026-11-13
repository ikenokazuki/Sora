import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { closeSharedBrowser, getBrowser, resolveChromiumPath, wreqAlignDisabledFeatures } from './browser_engine.js';
import { applyStealthEvasions, chromeBrandList, getAlignedChromeMajorVersion } from './browser_stealth.js';
import { ACCEPT_LANGUAGE, EMULATION_OS, MAX_SUPPORTED_CHROME_PROFILE_VERSION, fetchWithSafeRedirects } from './http_fetcher.js';
import { scrapeUrl } from './scraper.js';

// ブラウザの偽装は、JS で上書きするより Chromium 本体のフラグと CDP で直す方が、見破られにくい
// （上書きした getter は toString が native でなく、Worker や別オリジンの iframe には届かない）。
// 外部の検出サイト（CreepJS・deviceandbrowserinfo・tls.peet.ws）で確かめた結果を、ここで固定する。

type Seen = { path: string; headers: Array<[string, string]> };

/** 受け取ったヘッダを、名前の大文字小文字も順序もそのまま記録する HTTP/1.1 サーバー */
async function rawServer(respond: (path: string) => { type: string; text: string }) {
  const seen: Seen[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = buf.slice(0, end).split('\r\n');
      buf = '';
      const path = lines[0].split(' ')[1] ?? '/';
      const headers = lines.slice(1).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string];
      });
      seen.push({ path, headers });
      const { type, text } = respond(path);
      const body = Buffer.from(text);
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      sock.end(body);
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    last: (pathPrefix: string) => [...seen].reverse().find((s) => s.path.startsWith(pathPrefix)),
  };
}
const names = (r: Seen | undefined) => (r?.headers ?? []).map(([k]) => k);
const headerValue = (r: Seen | undefined, name: string) => r?.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const FILLER = 'padding text to stay above the little-content threshold of the scraper. '.repeat(4);
const STATIC_PAGE = `<!doctype html><html><body><p>${FILLER}</p></body></html>`;

let prevAllow: string | undefined;
beforeAll(() => {
  prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
});
afterAll(async () => {
  if (prevAllow !== undefined) process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
  else delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  await closeSharedBrowser();
});

// ページの中で測る値。同期で測れるものだけを書き、Worker は別のページで測る
const SYNC_PROBE = `
const native = (f) => /\\[native code\\]/.test(Function.prototype.toString.call(f));
const out = [];
const add = (k, v) => out.push(k + '=' + v);
add('webdriver', navigator.webdriver);
add('webdriverGetterNative', native(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get));
add('languagesOwn', Object.getOwnPropertyDescriptor(navigator, 'languages') === undefined ? 'none' : 'own');
add('languagesSame', navigator.languages === navigator.languages);
add('languagesFrozen', Object.isFrozen(navigator.languages));
add('languageMatches', navigator.language === navigator.languages[0]);
add('languageJa', navigator.language.startsWith('ja'));
add('intlJa', Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ja'));
add('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
add('chromeRuntime', typeof (window.chrome && window.chrome.runtime));
add('getImageDataNative', native(CanvasRenderingContext2D.prototype.getImageData));
add('hover', matchMedia('(hover: hover)').matches);
add('pointerFine', matchMedia('(pointer: fine)').matches);
`;
const probePage = (extra = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><p>${FILLER}</p><p id="r">pending</p><script>${SYNC_PROBE}${extra}
document.getElementById('r').textContent = out.join(' ') + ' done=1';</script></body></html>`;

// Worker と SharedWorker の中の値が、本スレッドと一致するか（Service Worker も同じ経路で UA を読む）
const WORKER_PROBE = `
const mainVals = { language: navigator.language, languages: navigator.languages.join(','), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
const body = "const d = Intl.DateTimeFormat().resolvedOptions(); const v = { ua: navigator.userAgent, language: navigator.language, languages: navigator.languages.join(','), tz: d.timeZone };";
const dedicated = new Promise((resolve) => {
  const w = new Worker(URL.createObjectURL(new Blob([body + 'self.postMessage(v);'], { type: 'application/javascript' })));
  w.onmessage = (e) => resolve(e.data);
  setTimeout(() => resolve({ ua: 'timeout' }), 4000);
});
const shared = new Promise((resolve) => {
  try {
    const sw = new SharedWorker(URL.createObjectURL(new Blob([body + 'onconnect = (e) => e.ports[0].postMessage(v);'], { type: 'application/javascript' })));
    sw.port.onmessage = (e) => resolve(e.data);
    sw.port.start();
  } catch (e) { resolve({ ua: 'error' }); }
  setTimeout(() => resolve({ ua: 'timeout' }), 4000);
});
Promise.all([dedicated, shared]).then(([w, s]) => {
  const out = [];
  const add = (k, v) => out.push(k + '=' + v);
  add('workerLanguage', w.language === mainVals.language);
  add('workerLanguages', w.languages === mainVals.languages);
  add('workerTz', w.tz === mainVals.tz);
  add('workerUaHeadless', /Headless/.test(w.ua));
  add('sharedUaHeadless', /Headless/.test(s.ua));
  add('sharedUaWindows', /Windows NT 10\\.0/.test(s.ua));
  document.getElementById('r').textContent = out.join(' ') + ' done=1';
});
`;
const workerPage = `<!doctype html><html><head><meta charset="utf-8"><title>worker</title></head><body><p id="r">pending</p><script>${WORKER_PROBE}</script></body></html>`;

/** 実行中の Chromium のメジャーバージョン */
async function chromiumMajor(): Promise<number> {
  const { browser } = await getBrowser();
  return parseInt((await browser.version()).match(/\/(\d+)\./)?.[1] ?? '0', 10);
}

// hover / pointer は --blink-settings で揃える。手元の 148 と本番の 156 では効くが、CI の Chrome for Testing 141 は無視する（実測）
const BLINK_SETTINGS_HOVER_FROM = 148;

function expectNativeTokens(text: string, major: number) {
  for (const token of [
    'webdriver=false',
    'webdriverGetterNative=true',
    'languagesOwn=none',
    'languagesSame=true',
    'languagesFrozen=true',
    'languageMatches=true',
    'languageJa=true',
    'intlJa=true',
    'tz=Asia/Tokyo',
    'chromeRuntime=undefined',
    'getImageDataNative=true',
    ...(major >= BLINK_SETTINGS_HOVER_FROM ? ['hover=true', 'pointerFine=true'] : []),
  ]) {
    expect(text).toContain(token);
  }
}

describe.skipIf(!resolveChromiumPath())('ブラウザの偽装は Chromium 本体の仕組みで行う', () => {
  test('applyStealthEvasions の後、navigator や canvas は native のまま日本語・東京・デスクトップのマウスに揃う', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: probePage() }));
    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto(`${server.base}/native`);
      await page.waitForFunction(() => document.getElementById('r')?.textContent?.includes('done=1'), { timeout: 10000 });
      expectNativeTokens(await page.evaluate(() => document.getElementById('r')!.textContent!), await chromiumMajor());
    } finally {
      await page.close();
      server.close();
    }
  }, 30000);

  test('Worker と SharedWorker の言語・タイムゾーンは本スレッドと一致し、UA に Headless が漏れない', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: workerPage }));
    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await applyStealthEvasions(page);
      await page.goto(`${server.base}/workers`);
      await page.waitForFunction(() => document.getElementById('r')?.textContent?.includes('done=1'), { timeout: 15000 });
      const text = await page.evaluate(() => document.getElementById('r')!.textContent!);
      for (const token of ['workerLanguage=true', 'workerLanguages=true', 'workerTz=true', 'workerUaHeadless=false', 'sharedUaHeadless=false', 'sharedUaWindows=true']) {
        expect(text).toContain(token);
      }
    } finally {
      await page.close();
      server.close();
    }
  }, 40000);

  test('Accept-Language は日本語で送られ、位置は偽装を入れない素のページと同じ（ヘッダを後から足して動かさない）', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: '<!doctype html><body>ok</body>' }));
    const { browser } = await getBrowser();
    const plain = await browser.newPage();
    const stealth = await browser.newPage();
    try {
      await plain.goto(`${server.base}/plain`);
      await applyStealthEvasions(stealth);
      await stealth.goto(`${server.base}/stealth`);
      const plainOrder = names(server.last('/plain')).map((n) => n.toLowerCase());
      const stealthSeen = server.last('/stealth');
      const stealthOrder = names(stealthSeen).map((n) => n.toLowerCase());
      expect(headerValue(stealthSeen, 'accept-language')?.startsWith('ja-JP')).toBe(true);
      // 標準の位置はビルドごとに違う（Chrome for Testing 141 は前の方、148 以降は Accept-Encoding の後）。
      // setExtraHTTPHeaders で後から足すと、これより後ろに並ぶヘッダが変わる
      expect(stealthOrder.slice(stealthOrder.indexOf('accept-language'))).toEqual(plainOrder.slice(plainOrder.indexOf('accept-language')));
    } finally {
      await plain.close();
      await stealth.close();
      server.close();
    }
  }, 30000);

  test('起動引数に、言語・UA・hover / pointer のフラグが入っている', async () => {
    const { browser } = await getBrowser();
    const args = browser.process()?.spawnargs ?? [];
    expect(args).toContain('--accept-lang=ja-JP,ja,en-US,en');
    expect(args.some((a) => a.startsWith('--blink-settings=primaryHoverType=2'))).toBe(true);
    const ua = args.find((a) => a.startsWith('--user-agent='));
    expect(ua).toContain('Windows NT 10.0');
    expect(ua).not.toContain('Headless');
  });

  test('起動引数で、wreq-js（静的取得）に無い TLS 拡張・署名の GREASE・image/jxl を止めている（Puppeteer の既定の機能の指定と 1 つにまとまる）', async () => {
    const { browser } = await getBrowser();
    const args = browser.process()?.spawnargs ?? [];
    const flags = args.filter((a) => a.startsWith('--disable-features='));
    // Chromium は --disable-features を 2 つ並べると最後だけを読む。Puppeteer が自分の分とまとめて 1 つにしていることを確かめる
    expect(flags).toHaveLength(1);
    const disabled = flags[0].slice('--disable-features='.length).split(',');
    // 止める機能は、名乗る版（静的取得のプロファイルの版）で決まる。152 未満は、拡張 51764・署名の GREASE・image/jxl を止める
    const expected = wreqAlignDisabledFeatures(Number(getAlignedChromeMajorVersion()));
    for (const feature of expected) expect(disabled).toContain(feature);
    expect(expected).toContain('JXLImageFormat');
    if (Number(getAlignedChromeMajorVersion()) < 152) expect(expected).toContain('TLSTrustAnchorIDs');
  });

  test('ブラウザ経路が送る UA・sec-ch-ua・Accept 系のヘッダは、静的取得（wreq-js）が送るものと同じ', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    const { browser } = await getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await applyStealthEvasions(page);
      await page.goto(`${server.base}/from-browser`, { waitUntil: 'domcontentloaded' });
      const { response } = await fetchWithSafeRedirects(`${server.base}/from-static`, 8000, 1);
      await response.text();
      const fromBrowser = server.last('/from-browser');
      const fromStatic = server.last('/from-static');
      for (const name of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'user-agent', 'accept', 'accept-encoding', 'upgrade-insecure-requests']) {
        expect(`${name}: ${headerValue(fromBrowser, name)}`).toBe(`${name}: ${headerValue(fromStatic, name)}`);
      }
      // 言語は、シークレット系のコンテキストで先頭 1 つに減らす Chromium がある（手元の 148）ので、完全一致でなく「ブラウザ側が静的側の先頭部分」で見る
      expect(headerValue(fromStatic, 'accept-language')).toBe(ACCEPT_LANGUAGE);
      expect(ACCEPT_LANGUAGE.startsWith(headerValue(fromBrowser, 'accept-language') ?? '\0')).toBe(true);
      expect(headerValue(fromBrowser, 'sec-ch-ua-platform')).toBe('"Windows"');
    } finally {
      await context.close();
      server.close();
    }
  }, 30000);

  test('fetchWithStealthBrowser（scrapeUrl の renderJs）でも同じく native のまま揃う', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: probePage() }));
    try {
      const result = await scrapeUrl({ tenantId: 'legacy', url: `${server.base}/render`, renderJs: true, noCache: true });
      expect(result.content).toContain('done=1');
      expectNativeTokens(result.content, await chromiumMajor());
    } finally {
      server.close();
    }
  }, 60000);
});

describe('静的取得のヘッダは Chrome の順序と大文字小文字のまま、Accept-Language だけが日本語', () => {
  test('Accept-Language は Accept-Encoding の後に置かれ、名前は Chrome の HTTP/1.1 と同じ表記', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    try {
      const { response } = await fetchWithSafeRedirects(`${server.base}/static-order`, 8000, 1);
      await response.text();
      const seen = server.last('/static-order');
      expect(headerValue(seen, 'accept-language')).toBe(ACCEPT_LANGUAGE);
      const order = names(seen);
      expect(order[0]).toBe('Host');
      expect(order.indexOf('Accept-Language')).toBeGreaterThan(order.indexOf('Accept-Encoding'));
      expect(order).toContain('User-Agent');
      expect(order).toContain('Upgrade-Insecure-Requests');
    } finally {
      server.close();
    }
  });

  test('呼び出し側が渡した Referer は、Sec-Fetch-Dest の後・Accept-Encoding の前（Chrome と同じ位置）に置かれる', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    try {
      const { response } = await fetchWithSafeRedirects(`${server.base}/static-referer`, 8000, 1, { Referer: 'https://example.com/from' });
      await response.text();
      const order = names(server.last('/static-referer'));
      expect(order.indexOf('Referer')).toBeGreaterThan(order.indexOf('Sec-Fetch-Dest'));
      expect(order.indexOf('Referer')).toBeLessThan(order.indexOf('Accept-Encoding'));
    } finally {
      server.close();
    }
  });
});

describe('ブラウザが名乗る sec-ch-ua のブランド（GREASE の名前・版・並び順）は、wreq-js の各 Chrome プロファイルと同じ', () => {
  test(`chrome_136〜${MAX_SUPPORTED_CHROME_PROFILE_VERSION} の全プロファイルで、chromeBrandList の結果が wreq-js の送る sec-ch-ua と一致する`, async () => {
    const { createSession } = await import('wreq-js');
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    const mismatches: string[] = [];
    try {
      for (let major = 136; major <= MAX_SUPPORTED_CHROME_PROFILE_VERSION; major++) {
        const session = await createSession({ browser: `chrome_${major}` as never, os: EMULATION_OS });
        try {
          await (await session.fetch(`${server.base}/wreq-${major}`)).text();
        } finally {
          await session.close();
        }
        const sent = headerValue(server.last(`/wreq-${major}`), 'sec-ch-ua');
        const mine = chromeBrandList(major, String(major)).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
        if (sent !== mine) mismatches.push(`chrome_${major}: wreq=${sent} / 計算=${mine}`);
      }
    } finally {
      server.close();
    }
    expect(mismatches).toEqual([]);
  }, 30000);

  test('fullVersionList の GREASE の版は「<版>.0.0.0」になる', () => {
    const list = chromeBrandList(149, '149.0.7827.155', '.0.0.0');
    expect(list.map((b) => `${b.brand} ${b.version}`)).toEqual(['Google Chrome 149.0.7827.155', 'Chromium 149.0.7827.155', 'Not)A;Brand 24.0.0.0']);
  });
});

describe('ページ取得の 1 回目は、検索経由の閲覧に見せる Referer を付ける', () => {
  const GOOGLE = 'https://www.google.com/';
  let prevReferer: string | undefined;
  beforeAll(() => {
    prevReferer = process.env.SORA_FETCH_DEFAULT_REFERER;
    delete process.env.SORA_FETCH_DEFAULT_REFERER;
  });
  afterAll(() => {
    if (prevReferer !== undefined) process.env.SORA_FETCH_DEFAULT_REFERER = prevReferer;
    else delete process.env.SORA_FETCH_DEFAULT_REFERER;
  });

  test('既定では Google の Referer と、それに合う Sec-Fetch-Site: cross-site を付ける', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    try {
      await scrapeUrl({ tenantId: 'legacy', url: `${server.base}/ref-default`, noCache: true });
      const seen = server.last('/ref-default');
      expect(headerValue(seen, 'referer')).toBe(GOOGLE);
      expect(headerValue(seen, 'sec-fetch-site')).toBe('cross-site');
      // 付けた Referer も、Chrome と同じ位置に入る
      const order = names(seen);
      expect(order.indexOf('Referer')).toBeGreaterThan(order.indexOf('Sec-Fetch-Dest'));
      expect(order.indexOf('Referer')).toBeLessThan(order.indexOf('Accept-Encoding'));
    } finally {
      server.close();
    }
  });

  test('呼び出し側が Referer を指定したら、そちらを優先する', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    try {
      await scrapeUrl({ tenantId: 'legacy', url: `${server.base}/ref-caller`, noCache: true, headers: { referer: 'https://example.com/mine' } });
      const seen = server.last('/ref-caller');
      expect(headerValue(seen, 'referer')).toBe('https://example.com/mine');
      expect(headerValue(seen, 'sec-fetch-site')).toBe('none');
    } finally {
      server.close();
    }
  });

  test('Cookie などの資格情報を運ぶ取得には付けない', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    try {
      await scrapeUrl({ tenantId: 'legacy', url: `${server.base}/ref-cred`, noCache: true, cookies: [{ name: 'sid', value: 'abc', domain: '127.0.0.1', path: '/' }] });
      expect(headerValue(server.last('/ref-cred'), 'referer')).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test('SORA_FETCH_DEFAULT_REFERER=off なら付けない', async () => {
    const server = await rawServer(() => ({ type: 'text/html; charset=utf-8', text: STATIC_PAGE }));
    process.env.SORA_FETCH_DEFAULT_REFERER = 'off';
    try {
      await scrapeUrl({ tenantId: 'legacy', url: `${server.base}/ref-off`, noCache: true });
      expect(headerValue(server.last('/ref-off'), 'referer')).toBeUndefined();
    } finally {
      delete process.env.SORA_FETCH_DEFAULT_REFERER;
      server.close();
    }
  });

  test('fetchWithSafeRedirects そのもの（robots.txt・sitemap・画像・JSON API が使う）は付けない', async () => {
    const server = await rawServer(() => ({ type: 'text/plain', text: 'ok' }));
    try {
      const { response } = await fetchWithSafeRedirects(`${server.base}/robots.txt`, 8000, 1);
      await response.text();
      expect(headerValue(server.last('/robots.txt'), 'referer')).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
