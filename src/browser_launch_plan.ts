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

/** explicit = 数を明示した（auto・不正な値は、false） */
function parseUid(raw: string | undefined, warnings: string[]): { uid: number; explicit: boolean } | 'off' {
  const text = raw?.trim().toLowerCase();
  if (!text || text === 'auto') return { uid: DEFAULT_BROWSER_UID, explicit: false };
  if (text === 'off') return 'off';
  if (/^\d+$/.test(text)) {
    const uid = Number(text);
    if (uid >= 1 && uid <= MAX_UID) return { uid, explicit: true };
  }
  warnings.push(`SORA_BROWSER_UID=${JSON.stringify(raw)} は、1 以上の整数・auto・off のどれでもないので、auto（${DEFAULT_BROWSER_UID}）として扱う`);
  return { uid: DEFAULT_BROWSER_UID, explicit: false };
}

/**
 * uid を落とすのに要る capability: プロファイルを渡す chown、Chromium の終了後に、別 uid 所有の 0700 のプロファイルを消す DAC_OVERRIDE、
 * 別 uid の Chromium に信号を送る KILL（無いと、puppeteer の後始末の process.kill が EPERM になり、プロセスが異常終了する）、
 * 起動用バイナリの setgroups・setgid・setuid。Docker の既定にはあるが、--cap-drop=ALL では無い。
 */
const DROP_CAPABILITIES = [
  ['CAP_CHOWN', 0],
  ['CAP_DAC_OVERRIDE', 1],
  ['CAP_KILL', 5],
  ['CAP_SETGID', 6],
  ['CAP_SETUID', 7],
] as const;

/**
 * /proc/self/status の CapEff（いまの実効 capability）から、uid を落とすのに足りない capability を返す。
 * 読めなければ（Linux 以外など）、足りているとみなす: 試して、失敗すれば、起動のエラーになる。
 */
export function missingDropCapabilities(procStatus: string | undefined): string[] {
  const hex = procStatus?.match(/^CapEff:\s*([0-9a-fA-F]+)\s*$/m)?.[1];
  if (!hex) return [];
  const effective = BigInt(`0x${hex}`);
  return DROP_CAPABILITIES.filter(([, bit]) => ((effective >> BigInt(bit)) & 1n) === 0n).map(([name]) => name);
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
 * - SORA_BROWSER_UID: auto（既定: 65532）・off・数。root で、起動用バイナリがあるときだけ、落とす。
 *   落とすのに要る capability が足りなければ（--cap-drop=ALL）、auto は、警告して、落とさずに従来どおり起動する（既定の挙動を壊さない）。数を明示したときは、失敗させる
 * - SORA_BROWSER_SANDBOX: auto（既定）・on・off。root のまま（落とせない）の Chromium は、サンドボックスを使えない
 */
export function planBrowserLaunch(options: {
  env: Record<string, string | undefined>;
  /** Sora 本体の uid。分からなければ undefined */
  currentUid: number | undefined;
  launcherExists: boolean;
  nodeEnv: string | undefined;
  launcher?: string;
  /** uid を落とすのに足りない capability（missingDropCapabilities）。既定は、足りている */
  missingCapabilities?: readonly string[];
}): { plan: LaunchPlan; warnings: string[] } {
  const warnings: string[] = [];
  const uid = parseUid(options.env.SORA_BROWSER_UID, warnings);
  const mode = parseSandbox(options.env.SORA_BROWSER_SANDBOX, options.nodeEnv, warnings);
  const isRoot = options.currentUid === 0;
  const wantsDrop = isRoot && uid !== 'off' && options.launcherExists;
  const missing = wantsDrop ? (options.missingCapabilities ?? []) : [];
  if (uid !== 'off' && missing.length > 0) {
    const list = missing.join(', ');
    if (uid.explicit) {
      throw new Error(`SORA_BROWSER_UID=${uid.uid} を指定したが、uid を落とすのに要る capability が足りない（${list}）。コンテナに足すか（--cap-add）、SORA_BROWSER_UID=auto・off にする`);
    }
    warnings.push(
      `Chromium を別の uid に落とせない: capability が足りない（${list}。--cap-drop=ALL など）。Sora と同じ uid（root）で起動する。落とすには、${missing.map((name) => `--cap-add=${name.slice(4)}`).join(' ')} を足す。落とさないなら、SORA_BROWSER_UID=off で、この警告を消せる`,
    );
  }
  const drop = wantsDrop && missing.length === 0 ? { uid: uid.uid, gid: uid.uid, launcher: options.launcher ?? DEFAULT_LAUNCHER } : null;
  const canUseSandbox = !isRoot || drop !== null;

  let sandbox: SandboxPolicy;
  if (mode === 'off') sandbox = 'none';
  else if (mode === 'on') {
    if (!canUseSandbox) {
      throw new Error('SORA_BROWSER_SANDBOX=on だが、Chromium を root のまま起動する（起動用バイナリがない、SORA_BROWSER_UID=off、または uid を落とす capability が足りない）ので、サンドボックスを有効にできない');
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
    // 先に 0700 にする: chown のあとは所有者でなくなるので、chmod に CAP_FOWNER が要る（--cap-drop=ALL では無い）
    deps.chmod(dir, 0o700);
    deps.chown(dir, owner.uid, owner.gid);
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
