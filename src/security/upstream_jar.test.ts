import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeHttpSession, fetchWithSafeRedirects } from '../http_fetcher.js';
import { createProdMetaHttp, createProdWeiboHttp } from '../services/social/transport.js';
import { dbGetTenantCookies, dbSaveTenantCookies } from '../db.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';
import { withEnv } from '../test_fixtures/env.js';
import { systemRoutes } from '../routes/system.js';

/**
 * strict では、tenant を指定しない取得（Sora 自身の上流への取得。Yahoo・YouTube・歌詞・TikTok の字幕・X・楽曲認識・画像の検査など）は、
 * 取得ごとに新しいセッション（空の Cookie のジャー）で動かし、終われば閉じる。共有の（legacy の）セッションと保存済みの Cookie を使うと、
 * サイトが出した Cookie（訪問者の ID など）が、利用者をまたいで共有される（設計 未決 14）。standard は変えない。
 * tenant を指定した取得（明示の legacy を含む）は、これまでどおり、池のセッションを使う（運営者の Cookie など）。
 */

const HOST = '127.0.0.1';
let server: Server;
let base: string;
let deadPort: number;

/** 2 本そろうまで応答を止め、そろったら同時に放す。そろわないときは、4 秒で自分だけ放す（試験が止まらないように） */
const barriers = new Map<string, Array<() => void>>();
function barrier(key: string, release: () => void): void {
  const list = barriers.get(key) ?? [];
  barriers.set(key, list);
  list.push(release);
  if (list.length === 2) {
    barriers.delete(key);
    for (const r of list.splice(0)) r(); // 空にする（あとから来る 4 秒のタイマーが、放したものをもう一度放さないように）
    return;
  }
  setTimeout(() => {
    const at = list.indexOf(release);
    if (at >= 0) {
      list.splice(at, 1);
      release();
    }
  }, 4000).unref?.();
}

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, HOST, () => r()));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const name = url.searchParams.get('n') ?? '';
    switch (url.pathname) {
      case '/set': // Cookie を 1 つ出す
        res.writeHead(200, { 'set-cookie': `${name}=1; Path=/`, 'content-type': 'text/plain' });
        res.end('ok');
        return;
      case '/setjson': // Cookie を 1 つ出して、JSON を返す（SNS の取得は、JSON を読む）
        res.writeHead(200, { 'set-cookie': `${name}=1; Path=/`, 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      case '/echo': // 受けた Cookie をそのまま返す
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        return;
      case '/hop': // Cookie を出して /echo へ飛ばす（1 回の取得の中のリダイレクト）
        res.writeHead(302, { 'set-cookie': 'hop=1; Path=/', location: '/echo' });
        res.end();
        return;
      case '/pair': { // 2 本の取得が、それぞれの Cookie を受けたあと、そろってから /echo へ進む（共有のジャーなら、互いの Cookie が混ざる形）
        const step = url.searchParams.get('step') ?? '1';
        if (step === '1') {
          barrier('1', () => {
            res.writeHead(302, { 'set-cookie': `${name}=1; Path=/`, location: `/pair?n=${name}&step=2` });
            res.end();
          });
        } else {
          barrier('2', () => {
            res.writeHead(302, { location: '/echo' });
            res.end();
          });
        }
        return;
      }
      case '/slow': { // 本体が、ヘッダーのあと、少しずつ届く（20,000 バイト × 5）
        res.writeHead(200, { 'content-type': 'text/plain' });
        let sent = 0;
        const timer = setInterval(() => {
          res.write('x'.repeat(20_000));
          if (++sent === 5) {
            clearInterval(timer);
            res.end();
          }
        }, 30);
        return;
      }
      case '/dead': // Cookie を出して、閉じたポートへ飛ばす（取得が失敗する）
        res.writeHead(302, { 'set-cookie': 'dead=1; Path=/', location: `http://${HOST}:${deadPort}/` });
        res.end();
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, HOST, () => r()));
  base = `http://${HOST}:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

afterEach(async () => {
  barriers.clear();
  // 池のセッションを閉じ（保存が走る）、保存した Cookie を消して、次の試験に持ち越さない
  for (const tenant of ['legacy', 'tenantA', 'tenantB']) {
    await closeHttpSession(HOST, tenant).catch(() => {});
    dbSaveTenantCookies(tenant, HOST, []);
  }
  resetSecurityMetrics();
});

const strict = <T>(fn: () => Promise<T>) => withEnv({ SORA_ISOLATION: 'strict', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, fn);
const standard = <T>(fn: () => Promise<T>) => withEnv({ SORA_ISOLATION: undefined, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, fn);

/** tenant を渡さない（undefined）取得が、既定。tenantId を渡すと、池のセッション */
const get = async (path: string, tenantId?: string) => {
  const { response } = await fetchWithSafeRedirects(`${base}${path}`, 5000, 5, undefined, undefined, undefined, tenantId);
  return response;
};
const cookieSeen = async (path = '/echo', tenantId?: string): Promise<string | null> => ((await (await get(path, tenantId)).json()) as { cookie: string | null }).cookie;
const settle = async (path: string, tenantId?: string) => { await (await get(path, tenantId)).text(); };
/** 失敗したか。同じプロセスのサーバーに繋ぐ試験では、Bun の expect().rejects を使わない（サーバーの応答を待たせて、時間切れ（5 秒）まで止まる。then で受けると 0.4 秒） */
const fails = (promise: Promise<unknown>) => promise.then(() => false, () => true);
const sessions = () => {
  const metrics = getSecurityMetrics();
  return { opened: metrics['sora_fetch_throwaway_session_opened_total'] ?? 0, closed: metrics['sora_fetch_throwaway_session_closed_total'] ?? 0 };
};

describe('strict で tenant を指定しない取得は、Cookie を持ち越さない', () => {
  test('1 回目の取得で受けた Cookie は、次の取得に付かない', async () => {
    await strict(async () => {
      await settle('/set?n=first');
      expect(await cookieSeen()).toBeNull();
    });
  });

  test('1 回の取得の中のリダイレクトでは、受けた Cookie が付く（Cookie を出してから飛ばすサイトを壊さない）', async () => {
    await strict(async () => {
      expect(await cookieSeen('/hop')).toBe('hop=1');
    });
  });

  test('同時の取得は、互いの Cookie を見ない', async () => {
    await strict(async () => {
      // 先に 1 回取得して、共有の池のセッションを作っておく（作る前に 2 本が同時に来ると、別々のセッションが 2 つできて、たまたま分かれる）
      await settle('/echo');
      const [a, b] = await Promise.all([cookieSeen('/pair?n=a'), cookieSeen('/pair?n=b')]);
      expect(a).toBe('a=1');
      expect(b).toBe('b=1');
    });
  });

  test('応答の本体は、取得が返ったあとも最後まで読める（セッションを閉じても切れない）', async () => {
    await strict(async () => {
      const response = await get('/slow');
      expect((await response.text()).length).toBe(100_000);
    });
  });

  test('取得ごとに新しいセッションを作り、終われば閉じる（成功も、リダイレクトの連なりも、失敗も）', async () => {
    await strict(async () => {
      await settle('/echo');
      await settle('/hop'); // リダイレクトを挟んでも、セッションは 1 つ
      expect(await fails(get('/dead'))).toBe(true);
      expect(sessions()).toEqual({ opened: 3, closed: 3 });
    });
  });

  test('失敗した取得で受けた Cookie も、次の取得に付かない', async () => {
    await strict(async () => {
      expect(await fails(get('/dead'))).toBe(true);
      expect(await cookieSeen()).toBeNull();
    });
  });

  test('保存済みの Cookie を戻さず、受けた Cookie を保存しない', async () => {
    dbSaveTenantCookies('legacy', HOST, [{ name: 'seed', value: '1', domain: HOST }]);
    await strict(async () => {
      expect(await cookieSeen()).toBeNull();
      await settle('/set?n=fresh');
      await closeHttpSession(HOST); // 池のセッションがあれば、ここで保存される。使い捨てなら、何も起きない
      expect(dbGetTenantCookies('legacy', HOST)?.map((c) => c.name)).toEqual(['seed']);
    });
  });

  test('資格情報つきの取得でも同じ（渡した Cookie はその取得に付き、次には残らない）', async () => {
    await strict(async () => {
      const { response } = await fetchWithSafeRedirects(`${base}/echo`, 5000, 5, undefined, [{ name: 'tok', value: 'secret' }]);
      expect(((await response.json()) as { cookie: string | null }).cookie).toBe('tok=secret');
      expect(await cookieSeen()).toBeNull();
      expect(sessions()).toEqual({ opened: 2, closed: 2 });
    });
  });

  test('開いた数と閉じた数が、/metrics（Prometheus 形式）に出る（最初の取得までは、どちらも出ない）', async () => {
    const metrics = async () => (await new Hono().route('/', systemRoutes).request('/metrics?format=prometheus')).text(); // standard の /metrics は、鍵なしで開く
    expect(await metrics()).not.toContain('sora_fetch_throwaway_session');
    await strict(async () => { await settle('/echo'); });
    const text = await metrics();
    expect(text).toContain('sora_fetch_throwaway_session_opened_total 1');
    expect(text).toContain('sora_fetch_throwaway_session_closed_total 1');
  });

  test('tenant を指定した取得（明示の legacy も）は、これまでどおり、池のセッションで Cookie を持ち越す', async () => {
    await strict(async () => {
      await settle('/set?n=op', 'legacy'); // 運営者の Cookie（social/transport.ts の X など）
      expect(await cookieSeen('/echo', 'legacy')).toBe('op=1');
      await settle('/set?n=ta', 'tenantA');
      expect(await cookieSeen('/echo', 'tenantA')).toBe('ta=1');
      expect(await cookieSeen('/echo', 'tenantB')).toBeNull();
      expect(sessions()).toEqual({ opened: 0, closed: 0 });
    });
  });
});

describe('standard は変わらない', () => {
  test('tenant を指定しない取得は、共有の（legacy の）セッションで Cookie を持ち越す', async () => {
    await standard(async () => {
      await settle('/set?n=std');
      expect(await cookieSeen()).toBe('std=1');
      expect(sessions()).toEqual({ opened: 0, closed: 0 });
    });
  });
});

describe('SNS の取得（social/transport.ts）も、tenant を指定しない取得として扱う', () => {
  const signal = () => new AbortController().signal;

  test('strict: Meta の取得は、Cookie を持ち越さない', async () => {
    const meta = createProdMetaHttp();
    await strict(async () => {
      await meta.getPage(`${base}/set?n=meta`, 5000, signal());
      const { data } = await meta.getJson(`${base}/echo`, 5000, signal());
      expect(data.cookie).toBeNull();
      expect(sessions()).toEqual({ opened: 2, closed: 2 });
    });
  });

  test('strict: Weibo の取得は、応答で受けた Cookie を持ち越さず、渡した Cookie だけが付く', async () => {
    const weibo = createProdWeiboHttp();
    const session = [{ name: 'SUB', value: 'v', domain: HOST }];
    await strict(async () => {
      await weibo.getJson(`${base}/setjson?n=w`, {}, session, 5000, signal());
      const { data } = await weibo.getJson(`${base}/echo`, {}, session, 5000, signal());
      expect(data.cookie).toBe('SUB=v');
      expect(sessions()).toEqual({ opened: 2, closed: 2 });
    });
  });

  test('standard: Meta の取得は、これまでどおり、共有のジャーで持ち越す', async () => {
    const meta = createProdMetaHttp();
    await standard(async () => {
      await meta.getPage(`${base}/set?n=meta`, 5000, signal());
      const { data } = await meta.getJson(`${base}/echo`, 5000, signal());
      expect(data.cookie).toBe('meta=1');
      expect(sessions()).toEqual({ opened: 0, closed: 0 });
    });
  });
});
