import { describe, expect, test } from 'bun:test';
import { addressEnabled, loadAddressConfig } from './address_config.js';

const MB = 1024 * 1024;

describe('loadAddressConfig', () => {
  test('既定は lazy で、保存先はデータベースの隣', () => {
    expect(loadAddressConfig({}, '/data/sora.db')).toEqual({
      mode: 'lazy', dir: '/data/address', maxBytes: 2048 * MB, waitMs: 20000, concurrency: 1, preload: null,
    });
  });

  test('インメモリのデータベースでは一時ディレクトリを使う', () => {
    expect(loadAddressConfig({}, ':memory:').dir).toContain('sora-address-');
  });

  test('すべての設定を環境変数から読む', () => {
    const config = loadAddressConfig({
      SORA_ADDRESS_MODE: 'EAGER', SORA_ADDRESS_DIR: ' /tmp/x/../addr ', SORA_ADDRESS_MAX_MB: '512',
      SORA_ADDRESS_WAIT_MS: ' 5000 ', SORA_ADDRESS_BUILD_CONCURRENCY: '2', SORA_ADDRESS_PRELOAD: '13, 27,1',
    }, '/data/sora.db');
    expect(config).toEqual({
      mode: 'eager', dir: '/tmp/addr', maxBytes: 512 * MB, waitMs: 5000, concurrency: 2, preload: ['13', '27', '01'],
    });
  });

  test('不正な値は既定値に戻す', () => {
    const config = loadAddressConfig({
      SORA_ADDRESS_MODE: 'maybe', SORA_ADDRESS_MAX_MB: '-1', SORA_ADDRESS_WAIT_MS: 'abc',
      SORA_ADDRESS_BUILD_CONCURRENCY: '99', SORA_ADDRESS_PRELOAD: 'tokyo',
    }, '/data/sora.db');
    expect(config).toMatchObject({ mode: 'lazy', maxBytes: 2048 * MB, waitMs: 20000, concurrency: 1, preload: null });
  });

  test('整数は前後の空白を除いて ^\\d+$ だけ（小数・指数・単位つきは既定）', () => {
    for (const value of ['5000.0', '5e3', '5000ms', '0x1388']) {
      expect(loadAddressConfig({ SORA_ADDRESS_WAIT_MS: value }, '/data/sora.db').waitMs, value).toBe(20000);
    }
  });

  test('PRELOAD は all を受け付け、列のどこにあっても全国。不正な要素（範囲外を含む）は除く', () => {
    const preload = (value: string) => loadAddressConfig({ SORA_ADDRESS_PRELOAD: value }, '/data/sora.db').preload;
    expect(preload('ALL')).toBe('all');
    expect(preload('13,all')).toBe('all');
    expect(preload('13,tokyo,48,0,13')).toEqual(['13']);
    expect(preload(' , ')).toBeNull();
  });

  test('addressEnabled は off のときだけ false', () => {
    expect(addressEnabled({})).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS_MODE: 'lazy' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS_MODE: 'eager' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS_MODE: 'maybe' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS_MODE: 'off' })).toBe(false);
    expect(addressEnabled({ SORA_ADDRESS_MODE: ' OFF ' })).toBe(false);
  });
});
