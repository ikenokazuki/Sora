import { LEGACY } from '../config.js';

/** 環境変数を書き換えて fn を回し、元に戻す（undefined は消す。失敗しても戻す）。 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const set = (entries: [string, string | undefined][]) => {
    for (const [k, v] of entries) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const saved = Object.keys(vars).map((k): [string, string | undefined] => [k, process.env[k]]);
  set(Object.entries(vars));
  try {
    return await fn();
  } finally {
    set(saved);
  }
}

/**
 * 廃止した名前（置き換え先の無い旧名と、リリースされなかった名前）の全部を、同じ値にした環境。
 * 廃止した設定が残っていても、動きが変わらないことを、名前を書かずに確かめる（旧名は、登録簿とそのテスト以外に書かない。env_invariants.test.ts）。
 */
export function removedSettings(value = 'true'): Record<string, string> {
  return Object.fromEntries(Object.entries(LEGACY).filter(([, entry]) => !entry.to).map(([name]) => [name, value]));
}
