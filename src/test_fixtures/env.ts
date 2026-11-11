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
