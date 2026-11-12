/**
 * Chromium の起動の計画: root の Sora 本体から、別の uid に落として起動するか、Chromium 自身のサンドボックスを使うか。
 *
 * - 落とす: root のまま Chromium を動かすと、サンドボックスを使えず（--no-sandbox が要る）、ページの renderer が破られたとき、
 *   同じ uid の運用者の秘密（プロセスの環境・DB）に届く。そこで、起動用バイナリ（native/chromium-launcher）で、既定の uid 65532
 *   （distroless の nonroot）に落としてから Chromium を exec する。
 * - サンドボックス: 非 root なら、Chromium は自身のサンドボックスを使える。ただし、Docker の既定の seccomp などでは、ユーザー名前空間を
 *   作れず、起動に失敗する。auto（既定）は、試して、起動できなければ --no-sandbox に戻す。
 *
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 2）
 */
import { chmodSync, chownSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 落とし先の既定の uid・gid。distroless の `nonroot` */
export const DEFAULT_BROWSER_UID = 65532;
/** 起動用バイナリの場所（Containerfile で置く） */
export const DEFAULT_LAUNCHER = '/usr/local/bin/sora-chromium-launch';

/** try = 試して、起動できなければ --no-sandbox に戻す。require = 起動できなければ失敗させる。none = --no-sandbox */
export type SandboxPolicy = 'try' | 'require' | 'none';

export interface LaunchPlan {
  /** 落とすときの uid・gid と起動用バイナリ。null なら、Sora と同じ uid で起動する */
  drop: { uid: number; gid: number; launcher: string } | null;
  sandbox: SandboxPolicy;
}

/** 4294967295 は、uid_t の -1（変更しない）の意味なので使えない */
const MAX_UID = 4_294_967_294;

function parseUid(raw: string | undefined, warnings: string[]): number | 'off' {
  const text = raw?.trim().toLowerCase();
  if (!text || text === 'auto') return DEFAULT_BROWSER_UID;
  if (text === 'off') return 'off';
  if (/^\d+$/.test(text)) {
    const uid = Number(text);
    if (uid >= 1 && uid <= MAX_UID) return uid;
  }
  warnings.push(`SORA_BROWSER_UID=${JSON.stringify(raw)} は、1 以上の整数・auto・off のどれでもないので、auto（${DEFAULT_BROWSER_UID}）として扱う`);
  return DEFAULT_BROWSER_UID;
}

function parseSandbox(raw: string | undefined, nodeEnv: string | undefined, warnings: string[]): 'auto' | 'on' | 'off' {
  const text = raw?.trim().toLowerCase();
  // テストの既定は、サンドボックスなし（全テストの挙動を変えない）。明示すれば、テストでも試せる
  if (!text) return nodeEnv === 'test' ? 'off' : 'auto';
  if (text === 'auto' || text === 'on' || text === 'off') return text;
  warnings.push(`SORA_BROWSER_SANDBOX=${JSON.stringify(raw)} は、auto・on・off のどれでもないので、auto として扱う`);
  return 'auto';
}

/**
 * 起動の計画を決める。
 * - SORA_BROWSER_UID: auto（既定: 65532）・off・数。root で、起動用バイナリがあるときだけ、落とす
 * - SORA_BROWSER_SANDBOX: auto（既定）・on・off。root のまま（落とせない）の Chromium は、サンドボックスを使えない
 */
export function planBrowserLaunch(options: {
  env: Record<string, string | undefined>;
  /** Sora 本体の uid。分からなければ undefined */
  currentUid: number | undefined;
  launcherExists: boolean;
  nodeEnv: string | undefined;
  launcher?: string;
}): { plan: LaunchPlan; warnings: string[] } {
  const warnings: string[] = [];
  const uid = parseUid(options.env.SORA_BROWSER_UID, warnings);
  const mode = parseSandbox(options.env.SORA_BROWSER_SANDBOX, options.nodeEnv, warnings);
  const isRoot = options.currentUid === 0;
  const drop = isRoot && uid !== 'off' && options.launcherExists ? { uid, gid: uid, launcher: options.launcher ?? DEFAULT_LAUNCHER } : null;
  const canUseSandbox = !isRoot || drop !== null;

  let sandbox: SandboxPolicy;
  if (mode === 'off') sandbox = 'none';
  else if (mode === 'on') {
    if (!canUseSandbox) {
      throw new Error('SORA_BROWSER_SANDBOX=on だが、Chromium を root のまま起動する（起動用バイナリがない、または SORA_BROWSER_UID=off）ので、サンドボックスを有効にできない');
    }
    sandbox = 'require';
  } else sandbox = canUseSandbox ? 'try' : 'none';
  return { plan: { drop, sandbox }, warnings };
}

/** サンドボックスを有効にするために、起動の引数から --no-sandbox と --disable-setuid-sandbox を外す（元の配列は書き換えない）。 */
export function withoutNoSandbox(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== '--no-sandbox' && arg !== '--disable-setuid-sandbox');
}

export function removeProfileDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 後始末の失敗で、呼び出し側を止めない
  }
}

export interface ProfileDirDeps {
  mkdtemp(prefix: string): string;
  chown(path: string, uid: number, gid: number): void;
  chmod(path: string, mode: number): void;
  remove?(path: string): void;
}

const realProfileDirDeps: ProfileDirDeps = { mkdtemp: mkdtempSync, chown: chownSync, chmod: chmodSync };

/**
 * 別 uid の Chromium が書ける、プロファイルのディレクトリを作る（その uid だけが読み書きできる 0700）。
 * puppeteer は、userDataDir を渡さないと、起動した側（root）の所有で作るので、落とした Chromium は書けない。
 */
export function createProfileDir(owner: { uid: number; gid: number }, deps: ProfileDirDeps = realProfileDirDeps): string {
  const dir = deps.mkdtemp(join(tmpdir(), 'sora-chromium-'));
  try {
    deps.chown(dir, owner.uid, owner.gid);
    deps.chmod(dir, 0o700);
  } catch (error) {
    (deps.remove ?? removeProfileDir)(dir);
    throw error;
  }
  return dir;
}

/**
 * サンドボックスを試して、起動できなければ戻す。試した結果は、このインスタンス（プロセス）で 1 回だけ決める
 * （毎回試すと、使えない環境で、起動のたびに 1 回余計に失敗する）。サンドボックスで起動できたあとの失敗は、戻さずに投げる（一時的な失敗かもしれない）。
 */
export class SandboxFallback {
  private decision: boolean | undefined;
  private used: boolean | undefined;

  /** 直近に起動したときの状態。起動する前は unknown */
  status(): 'on' | 'off' | 'unknown' {
    return this.used === undefined ? 'unknown' : this.used ? 'on' : 'off';
  }

  async launch<T>(policy: SandboxPolicy, launch: (sandbox: boolean) => Promise<T>, warn: (message: string) => void): Promise<T> {
    const run = async (sandbox: boolean): Promise<T> => {
      const result = await launch(sandbox);
      this.used = sandbox;
      return result;
    };
    if (policy === 'none') return run(false);
    if (policy === 'require') {
      try {
        return await run(true);
      } catch (error) {
        // 起動の失敗の文（Target closed など）だけでは、サンドボックスのせいだと分からない
        throw new Error(`SORA_BROWSER_SANDBOX=on だが、サンドボックスを有効にして Chromium を起動できなかった（ユーザー名前空間を作れない環境では、auto にするか、seccomp・AppArmor を緩める）: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    if (this.decision !== undefined) return run(this.decision);
    try {
      const result = await run(true);
      this.decision = true;
      return result;
    } catch (error) {
      // なしでも起動できなかったら、サンドボックスのせいではない（一時的な失敗かもしれない）ので、決めずに投げる。次の起動で、もう一度サンドボックスから試す
      const result = await run(false);
      this.decision = false;
      warn(`Chromium のサンドボックスを有効にして起動できなかったので、サンドボックスなし（--no-sandbox）で起動する: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }
}
