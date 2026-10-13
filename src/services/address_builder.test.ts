import { describe, expect, test } from 'bun:test';
import { ChildProcessBuilder, resolveBuildEntry } from './address_builder.js';
import { AddressUnavailableError } from './address_errors.js';
import type { BuildJob } from './address_store.js';

describe('resolveBuildEntry', () => {
  test('同梱の address-build.js を優先し、無ければ TypeScript の入口を使う', () => {
    expect(resolveBuildEntry('/app', (path) => path === '/app/address-build.js')).toBe('/app/address-build.js');
    expect(resolveBuildEntry('/app', () => true)).toBe('/app/address-build.js');
    expect(resolveBuildEntry('/src', (path) => path === '/src/address_build_main.ts')).toBe('/src/address_build_main.ts');
  });

  test('どちらも無ければ例外', () => {
    expect(() => resolveBuildEntry('/nowhere', () => false)).toThrow('/nowhere');
  });
});

describe('ChildProcessBuilder', () => {
  const job: BuildJob = { kind: 'postal' };
  const script = (source: string) => () => [process.execPath, '-e', source];

  test('既定のコマンドは、入口と --dir と --job を渡す', () => {
    const builder = new ChildProcessBuilder({ dir: '/data/address' });
    expect(builder.command(job)).toEqual([process.execPath, expect.stringMatching(/address_build_main\.ts$/), '--dir', '/data/address', '--job', '{"kind":"postal"}']);
  });

  test('終了コード 0 で解決する', async () => {
    await new ChildProcessBuilder({ dir: '/x', command: script('process.exit(0)') }).run(job);
  });

  test('終了コード 3 は blocked の AddressUnavailableError', async () => {
    const builder = new ChildProcessBuilder({ dir: '/x', command: script('console.error("HTTP 403"); process.exit(3)') });
    const error = await builder.run(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressUnavailableError);
    expect(error).toMatchObject({ blocked: true, artifact: 'postal', message: 'HTTP 403' });
  });

  test('それ以外の失敗は、標準エラーの最後の行をメッセージにする', async () => {
    const builder = new ChildProcessBuilder({ dir: '/x', command: script('console.error("first"); console.error("last line"); process.exit(1)') });
    await expect(builder.run(job)).rejects.toMatchObject({ blocked: false, message: 'last line' });
  });

  test('標準エラーが空なら終了コードをメッセージにする', async () => {
    const builder = new ChildProcessBuilder({ dir: '/x', command: script('process.exit(7)') });
    await expect(builder.run(job)).rejects.toMatchObject({ message: expect.stringContaining('7') });
  });

  test('時間内に終わらなければ kill して AddressUnavailableError', async () => {
    const builder = new ChildProcessBuilder({ dir: '/x', command: script('setTimeout(() => {}, 60000)'), timeoutMs: () => 150 });
    const started = Date.now();
    await expect(builder.run(job)).rejects.toMatchObject({ name: 'AddressUnavailableError', message: expect.stringContaining('終わりませんでした') });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
