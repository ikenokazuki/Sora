import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import {
  CpscCertificateCheckRequestSchema,
  FdaRegulatedCheckRequestSchema,
  MusicSearchRequestSchema,
  ProductComplianceRequestSchema,
  TrackingRequestSchema,
  WatchRegisterRequestSchema,
} from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'trade-tracking-watch-params', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 消した引数: ここに無い引数は MCP のスキーマに出ない
const expectedProps: Record<string, string[]> = {
  check_cpsc_certificate: ['htsCode', 'targetAge', 'material'],
  check_fda_regulated: ['htsCode', 'foodContact'],
  check_product_compliance: ['url', 'productName', 'description', 'htsCode', 'targetAge', 'material', 'productCategory', 'foodContact', 'hasBattery', 'batteryType'],
  verify_hts_code: ['htsCode', 'productDescription'],
  track_package: ['trackingNumber', 'carrier', 'preferredCarriers', 'noCache'],
  watch_register: ['url', 'title', 'selector', 'webhookUrl'],
};

describe('貿易・荷物・監視の MCP の引数', () => {
  test('消した引数はスキーマに無い。verify_hts_code の productDescription は必須のまま', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const [name, keys] of Object.entries(expectedProps)) {
        const schema = tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        expect(Object.keys(schema.properties ?? {}).sort(), name).toEqual([...keys].sort());
      }
      const verify = tools.find((t) => t.name === 'verify_hts_code')?.inputSchema as { required?: string[] };
      expect(verify.required).toContain('productDescription');
    });
  });

  test('消した引数を MCP に送っても通り、サービスには届かない', async () => {
    const cpsc = spyOn(scraper, 'checkCpscCertificate').mockResolvedValue({ certificateRequired: 'unknown' } as never);
    const fda = spyOn(scraper, 'checkFdaRegulated').mockReturnValue({ fdaRegulatedLikely: false } as never);
    const track = spyOn(scraper, 'trackPackage').mockResolvedValue({ carrier: 'yamato', trackingNumber: '1' } as never);
    const reg = spyOn(scraper, 'registerWatchTarget').mockResolvedValue({ target: {} } as never);
    restore.push(() => cpsc.mockRestore(), () => fda.mockRestore(), () => track.mockRestore(), () => reg.mockRestore());
    await withClient(async (client) => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['check_cpsc_certificate', { htsCode: '9503.00.0073', targetAge: 'child', productCategory: 'toy', description: 'x' }],
        ['check_fda_regulated', { htsCode: '3004.90.0000', productDescription: 'x' }],
        ['track_package', { trackingNumber: '123456789012', originCountry: 'JP', destinationCountry: 'US' }],
        ['watch_register', { url: 'https://example.com/', intervalSeconds: 60 }],
      ];
      for (const [name, args] of calls) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError, name).toBeFalsy();
      }
    });
    const sent = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls[0][0] as Record<string, unknown>;
    expect(sent(cpsc).productCategory).toBeUndefined();
    expect(sent(cpsc).description).toBeUndefined();
    expect(sent(fda).productDescription).toBeUndefined();
    expect(sent(track).originCountry).toBeUndefined();
    expect(sent(track).destinationCountry).toBeUndefined();
    expect(sent(reg).intervalSeconds).toBeUndefined();
  });
});

describe('貿易・荷物・監視の REST の引数', () => {
  test('消した引数を送っても通り、その項目は捨てられる', () => {
    const cpsc = CpscCertificateCheckRequestSchema.parse({ htsCode: '9503.00.0073', targetAge: 'child', productCategory: 'toy', description: 'x' }) as Record<string, unknown>;
    expect(cpsc.productCategory).toBeUndefined();
    expect(cpsc.description).toBeUndefined();
    const fda = FdaRegulatedCheckRequestSchema.parse({ htsCode: '3004.90.0000', productDescription: 'x' }) as Record<string, unknown>;
    expect(fda.productDescription).toBeUndefined();
    const tracking = TrackingRequestSchema.parse({ trackingNumber: '123456789012', originCountry: 'JP', destinationCountry: 'US', verbose: true }) as Record<string, unknown>;
    for (const field of ['originCountry', 'destinationCountry', 'verbose']) expect(tracking[field], field).toBeUndefined();
    const watch = WatchRegisterRequestSchema.parse({ url: 'https://example.com/', intervalSeconds: 60 }) as Record<string, unknown>;
    expect(watch.intervalSeconds).toBeUndefined();
  });

  test('ProductComplianceRequestSchema drops the GCC fields', () => {
    const parsed = ProductComplianceRequestSchema.parse({ productName: 'x', generateGcc: true, sku: 'S', certifier: { name: 'n' } }) as Record<string, unknown>;
    for (const field of ['generateGcc', 'sku', 'certifier']) expect(parsed[field], field).toBeUndefined();
  });

  test('POST /trade/cpsc-check と /trade/fda-check は、消した引数を送ってもエラーにならない', async () => {
    const cpsc = await post('/trade/cpsc-check', { htsCode: '9503.00.0073', targetAge: 'child', productCategory: 'toy', description: 'x' });
    expect(cpsc.status).toBe(200);
    const fda = await post('/trade/fda-check', { htsCode: '3004.90.0000', productDescription: 'x' });
    expect(fda.status).toBe(200);
  });
});

describe('search_music の attribute', () => {
  test('REST のスキーマは 3 つの値だけを通す', () => {
    for (const attribute of ['songTerm', 'artistTerm', 'albumTerm']) {
      expect(MusicSearchRequestSchema.safeParse({ query: 'x', attribute }).success, attribute).toBe(true);
    }
    expect(MusicSearchRequestSchema.safeParse({ query: 'x', attribute: 'bogus' }).success).toBe(false);
  });

  test('POST /search/music は、ほかの値を iTunes に問い合わせず 400 にする', async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; return new Response('{}', { status: 400 }); }) as unknown as typeof fetch;
    restore.push(() => { globalThis.fetch = realFetch; });
    const res = await post('/search/music', { query: 'x', attribute: 'bogus' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT');
    expect(fetched).toBe(0);
  });

  test('MCP のスキーマは 3 つの値の enum で、ほかの値は searchMusic に届かない', async () => {
    const spy = spyOn(scraper, 'searchMusic').mockResolvedValue({ query: 'x', items: [] } as never);
    restore.push(() => spy.mockRestore());
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'search_music')?.inputSchema as { properties?: Record<string, { enum?: string[] }> } | undefined;
      expect(schema?.properties?.attribute?.enum).toEqual(['songTerm', 'artistTerm', 'albumTerm']);
      const bad = await client.callTool({ name: 'search_music', arguments: { query: 'x', attribute: 'bogus' } });
      expect(bad.isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const ok = await client.callTool({ name: 'search_music', arguments: { query: 'x', attribute: 'songTerm' } });
      expect(ok.isError).toBeFalsy();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('search_diet_minutes は keyword・speaker・nameOfMeeting のどれか 1 つが要る', () => {
  const fetchSpy = () => {
    const realFetch = globalThis.fetch;
    const state = { calls: 0 };
    globalThis.fetch = (async () => { state.calls++; return new Response(JSON.stringify({ numberOfRecords: 0, speechRecord: [] })); }) as unknown as typeof fetch;
    restore.push(() => { globalThis.fetch = realFetch; });
    return state;
  };

  test('POST は 400（INVALID_INPUT）で、国会会議録 API に問い合わせない', async () => {
    const state = fetchSpy();
    for (const body of [{}, { nameOfHouse: '衆議院', from: '2025-01-01', until: '2025-12-31' }, { keyword: '  ' }]) {
      const res = await post('/gov/diet-minutes', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = (await res.json()) as { code: string; error: string };
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.error).toContain('keyword, speaker, または nameOfMeeting');
    }
    expect(state.calls).toBe(0);
  });

  test('GET も 400 になる', async () => {
    const state = fetchSpy();
    const res = await app.request('/gov/diet-minutes?nameOfHouse=' + encodeURIComponent('衆議院'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT');
    expect(state.calls).toBe(0);
  });

  test('どれか 1 つあれば通る', async () => {
    const state = fetchSpy();
    for (const body of [{ keyword: '人工知能' }, { speaker: '河野太郎' }, { nameOfMeeting: '予算委員会' }]) {
      const res = await post('/gov/diet-minutes', { ...body, noCache: true });
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    expect(state.calls).toBe(3);
  });

  test('引数の説明と OpenAPI の 400 にも、どれか 1 つが要ることを書く', async () => {
    const rule = 'keyword・speaker・nameOfMeeting のどれか 1 つは必須';
    const spec = (await (await app.request('/openapi.json')).json()) as any;
    const path = spec.paths['/gov/diet-minutes'];
    for (const method of ['post', 'get']) {
      const description = path[method].responses['400']?.description as string;
      expect(description, method).toContain('INVALID_INPUT');
      expect(description, method).toContain(rule);
    }
    const bodyProps = path.post.requestBody.content['application/json'].schema.properties;
    const queryParams = new Map<string, string>(path.get.parameters.map((p: any) => [p.name, p.description]));
    for (const name of ['keyword', 'speaker', 'nameOfMeeting']) {
      expect(bodyProps[name].description, `POST ${name}`).toContain(rule);
      expect(queryParams.get(name), `GET ${name}`).toContain(rule);
    }
    await withClient(async (client) => {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'search_diet_minutes');
      const props = (tool?.inputSchema as any)?.properties;
      for (const name of ['keyword', 'speaker', 'nameOfMeeting']) expect(props[name].description, `MCP ${name}`).toContain(rule);
      for (const name of ['nameOfHouse', 'from', 'until', 'limit']) expect(props[name].description, `MCP ${name}`).not.toContain(rule);
    });
  });

  test('MCP は、どれも無いときはエラーの応答を返す', async () => {
    const state = fetchSpy();
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'search_diet_minutes', arguments: { nameOfHouse: '参議院' } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('keyword, speaker, または nameOfMeeting');
    });
    expect(state.calls).toBe(0);
  });
});
