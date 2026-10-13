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
      SORA_ADDRESS: 'EAGER', SORA_ADDRESS_DIR: '/tmp/x/../addr', SORA_ADDRESS_MAX_MB: '512',
      SORA_ADDRESS_WAIT_MS: '5000', SORA_ADDRESS_BUILD_CONCURRENCY: '2', SORA_ADDRESS_PRELOAD: '13, 27,1',
    }, '/data/sora.db');
    expect(config).toEqual({
      mode: 'eager', dir: '/tmp/addr', maxBytes: 512 * MB, waitMs: 5000, concurrency: 2, preload: ['13', '27', '01'],
    });
  });

  test('不正な値は既定値に戻す', () => {
    const config = loadAddressConfig({
      SORA_ADDRESS: 'maybe', SORA_ADDRESS_MAX_MB: '-1', SORA_ADDRESS_WAIT_MS: 'abc',
      SORA_ADDRESS_BUILD_CONCURRENCY: '99', SORA_ADDRESS_PRELOAD: 'tokyo',
    }, '/data/sora.db');
    expect(config).toMatchObject({ mode: 'lazy', maxBytes: 2048 * MB, waitMs: 20000, concurrency: 1, preload: null });
  });

  test('PRELOAD は all を受け付ける', () => {
    expect(loadAddressConfig({ SORA_ADDRESS_PRELOAD: 'ALL' }, '/data/sora.db').preload).toBe('all');
  });

  test('addressEnabled は off のときだけ false', () => {
    expect(addressEnabled({})).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'lazy' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'eager' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'off' })).toBe(false);
    expect(addressEnabled({ SORA_ADDRESS: ' OFF ' })).toBe(false);
  });
});
