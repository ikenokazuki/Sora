/** Weibo匿名セッションの取得・再利用・失効。メモリ保持のみ、Cookie値は外へ出さない。 */
export interface SimpleCookie { name: string; value: string; domain: string; }

export interface WeiboSessionOpener {
  openWeiboSession(signal: AbortSignal): Promise<SimpleCookie[]>;
}

export interface WeiboSession {
  cookies: SimpleCookie[];
  issuedAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export function createWeiboSessionStore(opener: WeiboSessionOpener, now: () => number = Date.now) {
  let current: WeiboSession | undefined;
  let inflight: Promise<WeiboSession> | undefined;

  const valid = (s: WeiboSession | undefined): s is WeiboSession =>
    !!s && now() < s.expiresAt;

  async function get(signal: AbortSignal): Promise<WeiboSession> {
    if (valid(current)) return current as WeiboSession;
    if (!inflight) {
      inflight = (async (): Promise<WeiboSession> => {
        const cookies = await opener.openWeiboSession(signal);
        if (!cookies.some((c) => c.name === 'SUB')) throw new Error('Weibo session open failed: no SUB');
        const issuedAt = now();
        let expiresAt = issuedAt + SESSION_TTL_MS;
        return { cookies, issuedAt, expiresAt };
      })();
      inflight.then(
        (s) => { current = s; inflight = undefined; },
        () => { inflight = undefined; },
      );
    }
    return inflight;
  }

  /** 使ったセッションと同一のものだけ破棄する。429時は呼ばない。 */
  function invalidate(session: WeiboSession): void {
    if (current === session) current = undefined;
  }

  return { get, invalidate };
}

export type WeiboSessionStore = ReturnType<typeof createWeiboSessionStore>;
