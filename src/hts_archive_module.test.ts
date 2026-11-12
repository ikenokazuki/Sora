import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from './index.js';
import { isModuleActive } from './mcp/registry.js';
import { generateOpenApiDocument } from './types.js';

const savedModules = process.env.SORA_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.SORA_MODULES;
  else process.env.SORA_MODULES = savedModules;
});

describe('hts-archive module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it; naming it does', () => {
    delete process.env.SORA_MODULES;
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.SORA_MODULES = 'all';
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.SORA_MODULES = '*';
    expect(isModuleActive('hts-archive')).toBe(false);
    expect(isModuleActive('hts-archive', ['all'])).toBe(false);
    process.env.SORA_MODULES = 'all,hts-archive';
    expect(isModuleActive('hts-archive')).toBe(true);
  });
});

describe('hts-archive REST', () => {
  const savedDir = process.env.SORA_HTS_DIR;
  let dir: string;
  const body = '{"id":"2026HTSRev22","release":"2026HTSRev22","records":[]}';
  const entry = {
    id: '2026HTSRev22',
    release: '2026HTSRev22',
    title: 't',
    description: 'd',
    date: '10/26/2026',
    fetchedAt: '2026-11-12T04:00:00.000Z',
    sha256: 'x',
    rowCount: 0,
    bytes: 0,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-hts-archive-rest-'));
    process.env.SORA_HTS_DIR = dir;
    mkdirSync(join(dir, 'releases'));
    writeFileSync(join(dir, 'releases', '2026HTSRev22.json.gz'), Bun.gzipSync(new TextEncoder().encode(body)));
    writeFileSync(join(dir, 'releases', 'index.json'), JSON.stringify({ checkedAt: '2026-11-12T04:00:00.000Z', lastError: null, releases: [entry] }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.SORA_HTS_DIR;
    else process.env.SORA_HTS_DIR = savedDir;
  });

  test('answers 404 MODULE_DISABLED and stays out of the docs unless named', async () => {
    process.env.SORA_MODULES = 'all';
    for (const path of ['/trade/hts/releases', '/trade/hts/releases/2026HTSRev22']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('MODULE_DISABLED');
    }
    expect((generateOpenApiDocument() as any).paths['/trade/hts/releases']).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/trade/hts/releases');
  });

  test('lists saved releases and returns one release, gzip or plain', async () => {
    process.env.SORA_MODULES = 'all,hts-archive';
    const list = await app.request('/trade/hts/releases');
    expect(await list.json()).toEqual({ checkedAt: '2026-11-12T04:00:00.000Z', lastError: null, releases: [entry] });
    const plain = await app.request('/trade/hts/releases/2026HTSRev22');
    expect(plain.headers.get('content-type')).toContain('application/json');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(body);
    const gz = await app.request('/trade/hts/releases/2026HTSRev22', { headers: { 'accept-encoding': 'gzip, br' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(body);
    expect((generateOpenApiDocument() as any).paths['/trade/hts/releases/{id}'].get).toBeDefined();
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('GET /trade/hts/releases');
  });

  test('rejects a malformed id with 400 and an unknown one with 404', async () => {
    process.env.SORA_MODULES = 'all,hts-archive';
    expect((await app.request('/trade/hts/releases/bad.name')).status).toBe(400);
    const missing = await app.request('/trade/hts/releases/2026HTSRev21');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('NOT_FOUND');
  });
});
