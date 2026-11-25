/**
 * 信頼できない入力を読む子プロセス（PDF の解析・本文の抽出）を、Sora 本体（root）とも Chromium とも、ほかの種類の子とも別の uid に落として動かす部品。
 * pdf_uid.ts と extractor/rs_uid.ts が使う（設計 2 の続き。穴 26）。
 *
 * なぜ: 同じ uid（公開イメージは root）で動くと、子を破られたとき、運用者の秘密（環境変数・DB・鍵ファイル）と、別の利用者の Chromium に届く。
 * Chromium と同じ起動用バイナリ（native/chromium-launcher。uid・gid を落とし、権限を増やせなくして exec する）で落とす。
 *
 * uid: 同時に動く子には、1 つに 1 つ、別の uid を渡す（基準 + 番号）。同じ uid の 2 つが並ぶと、片方を破られたとき、もう片方（別の利用者の入力）の
 * メモリを読める。子が終わったら、その uid のプロセスが残っていないことを確かめて（browser_reap.ts）から、次に渡す。
 */
import { existsSync, readFileSync } from 'node:fs';
import { reapUid } from './browser_reap.js';
import { DEFAULT_LAUNCHER, missingDropCapabilities } from './browser_launch_plan.js';
import { BrowserSlots } from './browser_slots.js';
import { envRaw, type Env, type EnvName } from './config.js';
import { minimalChildEnv } from './security/child_env.js';

/** 4294967295 は、uid_t の -1（変更しない）の意味なので使えない */
const MAX_UID = 4_294_967_294;

/** 別の uid に落とせない（strict）・uid が空かない。運用者への案内の文で、利用者に見せる文ではない */
export class ChildDropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildDropError';
  }
}

/** 子の種類ごとの違い（設定の名前・既定の uid・文の主語） */
export interface ChildUidSpec {
  setting: EnvName;
  defaultUid: number;
  /** 文の主語（例: 「PDF の解析の別プロセス」） */
  child: string;
  /** 短い呼び名（例: 「PDF の解析」）。uid の範囲の重なりの文に使う */
  name: string;
  /** 投げる例外（呼ぶ側が見分けられる型） */
  error: (message: string) => ChildDropError;
}

export interface ChildDrop {
  /** 1 件目の uid。n 件目は、これに n を足した uid */
  baseUid: number;
  launcher: string;
}

/** 重なりを調べる、ほかの uid の範囲（両端を含む） */
export interface UidRange {
  /** 文に出す呼び名（例: 「Chromium」） */
  name: string;
  /** その範囲を決める設定の名前 */
  setting: string;
  first: number;
  last: number;
}

export interface ChildDropPlanInput {
  /** 読む環境（テスト用。省略すると、プロセスの環境） */
  env?: Env;
  /** SORA_ISOLATION=strict か。strict は、落とせないものを警告で済ませず、失敗させる */
  strict: boolean;
  /** Sora 本体の uid。分からなければ undefined */
  currentUid: number | undefined;
  launcherExists: boolean;
  /** uid を落とすのに足りない capability（missingDropCapabilities）。既定は、足りている */
  missingCapabilities?: readonly string[];
  /** 同時に動く子の数の上限（uid は基準 + 0〜size − 1） */
  size: number;
  /** ほかの uid の範囲。重なりを調べる。null は調べない */
  others?: ReadonlyArray<UidRange | null>;
  launcher?: string;
}

/** 呼び名のあとに日本語が続くとき、英数字で終わる名前（Chromium）には空白を入れる */
const spaced = (name: string): string => (/[A-Za-z0-9]$/.test(name) ? `${name} ` : name);

/** explicit = 数を明示した（auto・不正な値は、false） */
function parseChildUid(spec: ChildUidSpec, raw: string | undefined, warnings: string[]): { uid: number; explicit: boolean } | 'off' {
  const text = raw?.trim().toLowerCase();
  if (!text || text === 'auto') return { uid: spec.defaultUid, explicit: false };
  if (text === 'off') return 'off';
  if (/^\d+$/.test(text)) {
    const uid = Number(text);
    if (uid >= 1 && uid <= MAX_UID) return { uid, explicit: true };
  }
  warnings.push(`${spec.setting}=${JSON.stringify(raw)} は、1 以上の整数・auto・off のどれでもないので、auto（${spec.defaultUid}）として扱う`);
  return { uid: spec.defaultUid, explicit: false };
}

/** 設定の値が使う uid の範囲（off は null。不正な値は auto と同じ） */
export function childUidRange(spec: ChildUidSpec, size: number, env?: Env): UidRange | null {
  const uid = parseChildUid(spec, envRaw(spec.setting, env), []);
  return uid === 'off' ? null : { name: spec.name, setting: spec.setting, first: uid.uid, last: uid.uid + size - 1 };
}

/**
 * 別の uid に落とすかを決める。
 * - 設定: auto（既定の uid）・off・数。root で、起動用バイナリがあり、capability が足りているときだけ、落とす。
 *   足りなければ、standard の auto は、警告して従来どおり（Sora と同じ uid）動かす。数を明示したときは、失敗させる。
 * - strict は、落とせないものすべてを失敗させる（off・root でない・起動用バイナリなし・capability 不足・uid の範囲の食い違い）。root のまま動かさない。
 */
export function planChildDrop(spec: ChildUidSpec, options: ChildDropPlanInput): { drop: ChildDrop | null; warnings: string[] } {
  const warnings: string[] = [];
  const strict = (need: string) => spec.error(`SORA_ISOLATION=strict では、${need}`);
  const uid = parseChildUid(spec, envRaw(spec.setting, options.env), warnings);
  const launcher = options.launcher ?? DEFAULT_LAUNCHER;

  if (uid === 'off') {
    if (options.strict) throw strict(`${spec.setting}=off は使えません。${spec.child}を、別の uid に落として、運用者の秘密とほかの利用者のプロセスから離すためです。auto にするか、数を指定してください`);
    return { drop: null, warnings };
  }
  if (options.currentUid !== 0) {
    if (options.strict) {
      const who = options.currentUid === undefined ? '不明' : `uid ${options.currentUid}`;
      throw strict(`Sora を root で起動する必要があります（いまは ${who}）。${spec.child}を、別の uid に落とすためです（公開イメージの既定は root で、Chromium と信頼できない入力を読む子プロセスだけが別の uid に落ちます）`);
    }
    return { drop: null, warnings };
  }
  if (!options.launcherExists) {
    if (options.strict) throw strict(`${spec.child}を別の uid に落とす起動用バイナリ（${launcher}）がありません。公開イメージには入っています。自分でイメージを作るなら、Containerfile の chromium-launcher の段階で作るファイルを、この場所に置いてください`);
    return { drop: null, warnings };
  }
  const missing = options.missingCapabilities ?? [];
  if (missing.length > 0) {
    const list = missing.join(', ');
    const add = missing.map((name) => `--cap-add=${name.slice(4)}`).join(' ');
    if (options.strict) throw strict(`${spec.child}を別の uid に落とすのに要る capability が足りません（${list}）。${add} を足してください（--cap-drop=ALL の運用は、CHOWN・DAC_OVERRIDE・KILL・SETGID・SETUID の 5 つを足します）`);
    if (uid.explicit) throw spec.error(`${spec.setting}=${uid.uid} を指定したが、uid を落とすのに要る capability が足りない（${list}）。コンテナに足すか（${add}）、${spec.setting}=auto・off にする`);
    warnings.push(`${spec.child}を別の uid に落とせない: capability が足りない（${list}。--cap-drop=ALL など）。Sora と同じ uid（root）で動かす。落とすには、${add} を足す。落とさないなら、${spec.setting}=off で、この警告を消せる`);
    return { drop: null, warnings };
  }

  const last = uid.uid + options.size - 1;
  if (last > MAX_UID) {
    throw spec.error(`${spec.setting}=${uid.uid} に、同時の数（${options.size}）の分を足した uid（${last}）が、uid の最大（${MAX_UID}）を超える。${spec.setting} を小さくする`);
  }
  for (const other of options.others ?? []) {
    if (!other || uid.uid > other.last || last < other.first) continue;
    const them = spaced(other.name);
    const message = `${spaced(spec.name)}の uid（${uid.uid}〜${last}）が、${them}の uid（${other.first}〜${other.last}）と重なる。重なると、破られた${spec.child}が、同じ uid の ${them}に届き、終わったあとの片づけ（その uid のプロセスを終わらせる）が、${them}まで終わらせる。${spec.setting} か ${other.setting} を替えて、重ならないようにする`;
    if (options.strict) throw strict(message);
    // standard は、落とさずに（従来どおり）動かす。重なったまま落とすと、片づけがもう一方を終わらせる
    warnings.push(`${message}。重なっているあいだ、${spec.child}は別の uid に落とさず、Sora と同じ uid（root）で動かす`);
    return { drop: null, warnings };
  }
  return { drop: { baseUid: uid.uid, launcher }, warnings };
}

/**
 * 落とした子の作業ディレクトリと HOME。bun は、起動のとき、作業ディレクトリの node_modules/.cache と $HOME/.bun の下に、キャッシュの置き場を作ろうとする
 * （strace で確かめた）。落とした uid は、次の仕事（別の利用者）にも使われるので、書ける場所にあると、前の仕事が置いたものを、次の仕事が読む経路になりうる。
 * 運用者の設定（HOME・Sora の作業ディレクトリ）に頼らず、root の所有の / と、存在しない HOME にする（どちらも、落とした uid は書けない）。
 */
const DROPPED_CWD = '/';
const DROPPED_HOME = '/nonexistent';

/** 起動用バイナリ経由の起動コマンド・環境変数・作業ディレクトリ。本物の実行ファイル（command の先頭）は、環境変数 SORA_LAUNCH_EXEC で伝える（起動用バイナリが、消してから exec する） */
export function droppedChild(
  command: readonly string[],
  launcher: string,
  uid: number,
  gid: number,
  source: Record<string, string | undefined> = process.env,
): { command: string[]; env: Record<string, string>; cwd: string } {
  const [exec, ...rest] = command;
  if (exec === undefined) throw new Error('起動するコマンドが空です');
  return {
    command: [launcher, ...rest],
    env: minimalChildEnv(source, { SORA_LAUNCH_EXEC: exec, SORA_LAUNCH_UID: String(uid), SORA_LAUNCH_GID: String(gid), HOME: DROPPED_HOME }),
    cwd: DROPPED_CWD,
  };
}

export interface ChildUidLease {
  uid: number;
  gid: number;
  /** 子が終わったあとに呼ぶ。その uid のプロセスが残っていないことを確かめて、手放す（2 回目以降は何もしない） */
  done(): Promise<void>;
}

/**
 * 子 1 つに 1 つの uid を渡す。同時に動く子どうしが、同じ uid を持たない（browser_slots.ts の番号の割り当てを使う）。
 * 手放すのは、その uid のプロセスが 1 つも残っていないと確かめてから。片づかなかった uid は、渡さずに隔離し、次に借りるとき、もう一度確かめる。
 */
export class ChildUidPool {
  private readonly slots: BrowserSlots;
  private readonly quarantined = new Map<string, number>();
  private sequence = 0;

  constructor(
    size: number,
    private readonly reap: (uid: number) => Promise<boolean>,
    /** 片づかなかった uid を隔離したときに、運用者へ知らせる */
    private readonly warn: (message: string) => void,
    /** 子の呼び名（隔離の文に使う） */
    private readonly name: string,
    /** 空きが無いときに投げる例外 */
    private readonly unavailable: () => ChildDropError,
  ) {
    this.slots = new BrowserSlots(() => size);
  }

  async lease(baseUid: number): Promise<ChildUidLease> {
    const key = `child:${++this.sequence}`;
    let index = this.slots.allocate(key);
    if (index === undefined) {
      await this.reclaim();
      index = this.slots.allocate(key);
    }
    if (index === undefined) throw this.unavailable();
    const uid = baseUid + index;
    let finished = false;
    return {
      uid,
      gid: uid,
      done: async () => {
        if (finished) return;
        finished = true;
        const clean = await this.safeReap(uid);
        if (clean) {
          this.slots.release(key);
          return;
        }
        this.quarantined.set(key, uid);
        this.warn(`uid ${uid} のプロセスが、${this.name}のあとも残り、終わらせられません。この uid を隔離し、渡しません（次に借りるときに、もう一度確かめます）。残りの uid だけで続けます`);
      },
    };
  }

  private async safeReap(uid: number): Promise<boolean> {
    try {
      return await this.reap(uid);
    } catch {
      return false;
    }
  }

  /** 片づかなかった uid を、もう一度確かめる。片づいていれば、手放す */
  private async reclaim(): Promise<void> {
    for (const [key, uid] of [...this.quarantined]) {
      if (!(await this.safeReap(uid))) continue;
      this.quarantined.delete(key);
      this.slots.release(key);
    }
  }
}

function readSelfStatus(): string | undefined {
  try {
    return readFileSync('/proc/self/status', 'utf8');
  } catch {
    return undefined; // Linux 以外
  }
}

/**
 * 計画の入力（Sora 自身の uid・起動用バイナリ・capability・uid の片づけ）。本番は実際の環境を読む。
 * テストが、root・起動用バイナリありの環境を作るために、差し替えられる（browser_engine.ts の launchProbe と同じ）
 */
export const childDropProbe = {
  currentUid: (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined),
  launcher: (): string => DEFAULT_LAUNCHER,
  launcherExists: (): boolean => existsSync(childDropProbe.launcher()),
  missingCapabilities: (): string[] => missingDropCapabilities(readSelfStatus()),
  reap: (uid: number): Promise<boolean> => reapUid(uid),
};

const warned = new Set<string>();
/** 同じ文の警告は、1 回だけ出す（子を起こすたびに出さない） */
export function warnChildOnce(prefix: string, message: string): void {
  const line = `${prefix} ${message}`;
  if (warned.has(line)) return;
  warned.add(line);
  console.warn(line);
}
/** 試験用: 1 回だけ出す警告を、もう一度出せるようにする */
export function resetChildDropWarnings(): void {
  warned.clear();
}
