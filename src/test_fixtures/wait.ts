// テストの待ちの部品

/** 終わらなかったら失敗にする（expect().rejects は、終わらない Promise で時間切れが効かない） */
export async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms}ms 以内に終わらなかった`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** 失敗した理由（成功なら undefined） */
export const failureOf = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e as Error);

export async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('条件を満たさなかった');
    await Bun.sleep(20);
  }
}
