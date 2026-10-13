import { ChildProcessBuilder } from './address_builder.js';
import { loadAddressConfig } from './address_config.js';
import { AddressData } from './address_data.js';
import { AddressNormalizer } from './address_normalize.js';

/** 住所機能の道具立て。データの管理役と、それを使う正規化。 */
export interface AddressContext {
  data: AddressData;
  normalizer: AddressNormalizer;
}

export function createAddressContext(data: AddressData): AddressContext {
  return { data, normalizer: new AddressNormalizer(data) };
}

let singleton: AddressContext | null = null;

/** 初めて使われたときに作る（起動時には何もしない）。データの構築は別プロセスで行う。 */
export function getAddressContext(): AddressContext {
  if (singleton) return singleton;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('テストでは setAddressContextForTest で偽の AddressData に差し替えてください（実通信を避けるため）');
  }
  const config = loadAddressConfig();
  singleton = createAddressContext(new AddressData({ config, builder: new ChildProcessBuilder({ dir: config.dir }) }));
  return singleton;
}

export function setAddressContextForTest(context: AddressContext | null): void {
  singleton = context;
}
