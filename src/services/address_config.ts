import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function intInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function parsePreload(raw: string | undefined): AddressConfig['preload'] {
  const text = raw?.trim().toLowerCase();
  if (!text) return null;
  if (text === 'all') return 'all';
  const codes = [...new Set(text.split(',').map((part) => part.trim()).filter((part) => /^\d{1,2}$/.test(part)).map((part) => part.padStart(2, '0')))];
  return codes.length > 0 ? codes : null;
}

export function loadAddressConfig(
  env: Record<string, string | undefined> = process.env,
  dbPath: string = getDatabasePath(),
): AddressConfig {
  const rawMode = env.SORA_ADDRESS?.trim().toLowerCase();
  const mode: AddressMode = rawMode === 'off' || rawMode === 'eager' ? rawMode : 'lazy';
  const explicitDir = env.SORA_ADDRESS_DIR?.trim();
  const dir = explicitDir
    ? resolve(explicitDir)
    : dbPath === ':memory:'
      ? join(tmpdir(), `sora-address-${process.pid}`)
      : resolve(dirname(dbPath), 'address');
  return {
    mode,
    dir,
    maxBytes: intInRange(env.SORA_ADDRESS_MAX_MB, 64, 1_048_576, 2048) * MB,
    waitMs: intInRange(env.SORA_ADDRESS_WAIT_MS, 1000, 120_000, 20_000),
    concurrency: intInRange(env.SORA_ADDRESS_BUILD_CONCURRENCY, 1, 4, 1),
    preload: parsePreload(env.SORA_ADDRESS_PRELOAD),
  };
}

/** MCP のツール登録など、設定ファイルを読まずに有効かどうかだけ知りたいとき。 */
export function addressEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SORA_ADDRESS?.trim().toLowerCase() !== 'off';
}
