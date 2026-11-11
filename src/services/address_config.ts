import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Env, envEnum, envInt, envList, envPath } from '../config.js';
import { getDatabasePath } from '../db.js';

export type AddressMode = 'off' | 'lazy' | 'eager';

export interface AddressConfig {
  mode: AddressMode;
  /** 保存先（絶対パス）。 */
  dir: string;
  /** ディスク予算（バイト）。 */
  maxBytes: number;
  /** 住所ツールがデータの取得を待つ上限（ミリ秒）。 */
  waitMs: number;
  /** 構築の同時実行数。 */
  concurrency: number;
  /** 事前取得する都道府県コード（2 桁）。'all' は全国。 */
  preload: string[] | 'all' | null;
}

const MB = 1024 * 1024;

/** 事前取得の範囲。`all` は列のどこにあっても全国。正しい都道府県コードが無ければ null（事前取得しない）。 */
function preloadOf(env: Env): AddressConfig['preload'] {
  const codes = envList('SORA_ADDRESS_PRELOAD', env);
  if (codes.includes('all')) return 'all';
  return codes.length > 0 ? codes : null;
}

/** 呼び出しのたびに環境を読む（不正な値は既定値。止めるのは起動時の検査）。 */
export function loadAddressConfig(env: Env = process.env, dbPath: string = getDatabasePath()): AddressConfig {
  const explicitDir = envPath('SORA_ADDRESS_DIR', env);
  const dir = explicitDir
    ? resolve(explicitDir)
    : dbPath === ':memory:'
      ? join(tmpdir(), `sora-address-${process.pid}`)
      : resolve(dirname(dbPath), 'address');
  return {
    mode: envEnum('SORA_ADDRESS_MODE', env),
    dir,
    maxBytes: envInt('SORA_ADDRESS_MAX_MB', env) * MB,
    waitMs: envInt('SORA_ADDRESS_WAIT_MS', env),
    concurrency: envInt('SORA_ADDRESS_BUILD_CONCURRENCY', env),
    preload: preloadOf(env),
  };
}

/** MCP のツール登録など、設定ファイルを読まずに有効かどうかだけ知りたいとき。 */
export function addressEnabled(env: Env = process.env): boolean {
  return envEnum('SORA_ADDRESS_MODE', env) !== 'off';
}
