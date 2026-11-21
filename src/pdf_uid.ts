/**
 * PDF の解析の別プロセス（pdf_child.ts）を、Sora 本体（root）とも Chromium とも別の uid に落として動かす（設計 2 の続き。穴 26）。
 *
 * なぜ: 別プロセスは、メモリと時間の暴走を止めるが、本体と同じ uid（公開イメージは root）で動くと、pdf.js を破られたとき、運用者の秘密
 * （環境変数・DB・鍵ファイル）と、別の利用者の Chromium・PDF に届く。Chromium と同じ起動用バイナリ（native/chromium-launcher。
 * uid・gid を落とし、権限を増やせなくして、bun を exec する）で、別の uid に落とす。
 *
 * uid: 同時に動く PDF の解析は PDF_CONCURRENCY 件で、1 件に 1 つ、別の uid を渡す（基準 + 番号。既定の基準 65530 なら 65530・65531）。
 * 同じ uid の 2 つの解析が並ぶと、片方を破られたとき、もう片方（別の利用者の PDF）のメモリを読める。解析が終わったら、その uid のプロセスが
 * 残っていないことを確かめて（browser_reap.ts）から、次に渡す。Chromium の uid の範囲（SORA_BROWSER_UID の基準から）とは重ならないようにする。
 */
import { existsSync, readFileSync } from 'node:fs';
import { reapUid } from './browser_reap.js';
import { browserUidRange, DEFAULT_LAUNCHER, missingDropCapabilities } from './browser_launch_plan.js';
import { BrowserSlots } from './browser_slots.js';
import { envRaw, type Env } from './config.js';
import { pdfChildEnv } from './pdf_child.js';
import { isolationLevel, strictBrowserProcessMax } from './security/limits.js';

/** 同時に動かす PDF の解析の数（全員で共有。pdf.ts の順番の枠）。1 件に 1 つの uid が要るので、uid の数でもある */
export const PDF_CONCURRENCY = 2;
/** 落とし先の uid の基準の既定。Chromium の既定（65532〜）の、すぐ下 */
export const DEFAULT_PDF_UID = 65530;
/** 4294967295 は、uid_t の -1（変更しない）の意味なので使えない */
const MAX_UID = 4_294_967_294;

/** 別の uid に落とせない（strict）・uid が空かない。運用者への案内の文で、利用者に見せる文ではない */
export class PdfDropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfDropError';
  }
}

export interface PdfDrop {
  /** 1 件目の uid。n 件目は、これに n を足した uid */
  baseUid: number;
  launcher: string;
}

/** explicit = 数を明示した（auto・不正な値は、false） */
function parsePdfUid(raw: string | undefined, warnings: string[]): { uid: number; explicit: boolean } | 'off' {
  const text = raw?.trim().toLowerCase();
  if (!text || text === 'auto') return { uid: DEFAULT_PDF_UID, explicit: false };
  if (text === 'off') return 'off';
  if (/^\d+$/.test(text)) {
    const uid = Number(text);
    if (uid >= 1 && uid <= MAX_UID) return { uid, explicit: true };
  }
  warnings.push(`SORA_PDF_UID=${JSON.stringify(raw)} は、1 以上の整数・auto・off のどれでもないので、auto（${DEFAULT_PDF_UID}）として扱う`);
  return { uid: DEFAULT_PDF_UID, explicit: false };
}

export interface PdfDropPlanInput {
  /** 読む環境（テスト用。省略すると、プロセスの環境） */
  env?: Env;
  /** SORA_ISOLATION=strict か。strict は、落とせないものを警告で済ませず、失敗させる */
  strict: boolean;
  /** Sora 本体の uid。分からなければ undefined */
  currentUid: number | undefined;
  launcherExists: boolean;
  /** uid を落とすのに足りない capability（missingDropCapabilities）。既定は、足りている */
  missingCapabilities?: readonly string[];
  /** 同時に動く解析の数（uid は基準 + 0〜size − 1） */
  size: number;
  /** Chromium の uid の範囲（browserUidRange）。重なりを調べる。省略・null は調べない */
  browser?: { first: number; last: number } | null;
  launcher?: string;
}

/**
 * 別の uid に落とすかを決める。
 * - SORA_PDF_UID: auto（既定: 65530）・off・数。root で、起動用バイナリがあり、capability が足りているときだけ、落とす。
 *   足りなければ、standard の auto は、警告して従来どおり（Sora と同じ uid）動かす。数を明示したときは、失敗させる。
 * - strict は、落とせないものすべてを失敗させる（off・root でない・起動用バイナリなし・capability 不足・uid の範囲の食い違い）。
 *   PDF の解析を、root のまま動かさない。起動の確認（browser_startup.ts の verifyStrictPdf）が、ここで気づいて止める。
 */
export function planPdfDrop(options: PdfDropPlanInput): { drop: PdfDrop | null; warnings: string[] } {
  const warnings: string[] = [];
  const strict = (need: string) => new PdfDropError(`SORA_ISOLATION=strict では、${need}`);
  const uid = parsePdfUid(envRaw('SORA_PDF_UID', options.env), warnings);
  const launcher = options.launcher ?? DEFAULT_LAUNCHER;

  if (uid === 'off') {
    if (options.strict) throw strict('SORA_PDF_UID=off は使えません。PDF の解析の別プロセスを、別の uid に落として、運用者の秘密とほかの利用者のプロセスから離すためです。auto にするか、数を指定してください');
    return { drop: null, warnings };
  }
  if (options.currentUid !== 0) {
    if (options.strict) {
      const who = options.currentUid === undefined ? '不明' : `uid ${options.currentUid}`;
      throw strict(`Sora を root で起動する必要があります（いまは ${who}）。PDF の解析の別プロセスを、別の uid に落とすためです（公開イメージの既定は root で、Chromium と PDF の解析だけが別の uid に落ちます）`);
    }
    return { drop: null, warnings };
  }
  if (!options.launcherExists) {
    if (options.strict) throw strict(`PDF の解析の別プロセスを別の uid に落とす起動用バイナリ（${launcher}）がありません。公開イメージには入っています。自分でイメージを作るなら、Containerfile の chromium-launcher の段階で作るファイルを、この場所に置いてください`);
    return { drop: null, warnings };
  }
  const missing = options.missingCapabilities ?? [];
  if (missing.length > 0) {
    const list = missing.join(', ');
    const add = missing.map((name) => `--cap-add=${name.slice(4)}`).join(' ');
    if (options.strict) throw strict(`PDF の解析の別プロセスを別の uid に落とすのに要る capability が足りません（${list}）。${add} を足してください（--cap-drop=ALL の運用は、CHOWN・DAC_OVERRIDE・KILL・SETGID・SETUID の 5 つを足します）`);
    if (uid.explicit) throw new PdfDropError(`SORA_PDF_UID=${uid.uid} を指定したが、uid を落とすのに要る capability が足りない（${list}）。コンテナに足すか（${add}）、SORA_PDF_UID=auto・off にする`);
    warnings.push(
      `PDF の解析の別プロセスを別の uid に落とせない: capability が足りない（${list}。--cap-drop=ALL など）。Sora と同じ uid（root）で動かす。落とすには、${add} を足す。落とさないなら、SORA_PDF_UID=off で、この警告を消せる`,
    );
    return { drop: null, warnings };
  }

  const last = uid.uid + options.size - 1;
  if (last > MAX_UID) {
    throw new PdfDropError(`SORA_PDF_UID=${uid.uid} に、同時の解析の数（${options.size}）の分を足した uid（${last}）が、uid の最大（${MAX_UID}）を超える。SORA_PDF_UID を小さくする`);
  }
  const browser = options.browser;
  if (browser && uid.uid <= browser.last && last >= browser.first) {
    const message = `PDF の解析の uid（${uid.uid}〜${last}）が、Chromium の uid（${browser.first}〜${browser.last}）と重なる。重なると、破られた PDF の解析のプロセスが、同じ uid の Chromium に届き、解析のあとの片づけ（その uid のプロセスを終わらせる）が、Chromium まで終わらせる。SORA_PDF_UID か SORA_BROWSER_UID を替えて、重ならないようにする`;
    if (options.strict) throw strict(message);
    // standard は、落とさずに（従来どおり）動かす。重なったまま落とすと、片づけが Chromium を終わらせる
    warnings.push(`${message}。重なっているあいだ、PDF の解析は別の uid に落とさず、Sora と同じ uid（root）で動かす`);
    return { drop: null, warnings };
  }
  return { drop: { baseUid: uid.uid, launcher }, warnings };
}

/** 起動用バイナリ経由の起動コマンドと環境変数。本物の実行ファイル（command の先頭）は、環境変数 SORA_LAUNCH_EXEC で伝える（起動用バイナリが、消してから exec する） */
export function droppedChild(
  command: readonly string[],
  launcher: string,
  uid: number,
  gid: number,
  source: Record<string, string | undefined> = process.env,
): { command: string[]; env: Record<string, string> } {
  const [exec, ...rest] = command;
  if (exec === undefined) throw new Error('起動するコマンドが空です');
  return {
    command: [launcher, ...rest],
    env: pdfChildEnv(source, { SORA_LAUNCH_EXEC: exec, SORA_LAUNCH_UID: String(uid), SORA_LAUNCH_GID: String(gid) }),
  };
}

export interface PdfUidLease {
  uid: number;
  gid: number;
  /** 解析が終わった（別プロセスが終わった）あとに呼ぶ。その uid のプロセスが残っていないことを確かめて、手放す（2 回目以降は何もしない） */
  done(): Promise<void>;
}

/**
 * 解析 1 件に 1 つの uid を渡す。同時に動く解析どうしが、同じ uid を持たない（browser_slots.ts の番号の割り当てを使う）。
 * 手放すのは、その uid のプロセスが 1 つも残っていないと確かめてから。片づかなかった uid は、渡さずに隔離し、次に借りるとき、もう一度確かめる。
 */
export class PdfUidPool {
  private readonly slots: BrowserSlots;
  private readonly quarantined = new Map<string, number>();
  private sequence = 0;

  constructor(
    size: number,
    private readonly reap: (uid: number) => Promise<boolean>,
    /** 片づかなかった uid を隔離したときに、運用者へ知らせる */
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.slots = new BrowserSlots(() => size);
  }

  async lease(baseUid: number): Promise<PdfUidLease> {
    const key = `pdf:${++this.sequence}`;
    let index = this.slots.allocate(key);
    if (index === undefined) {
      await this.reclaim();
      index = this.slots.allocate(key);
    }
    if (index === undefined) {
      throw new PdfDropError('PDF の解析に使える uid が空いていません（前の解析のプロセスが uid に残り、終わらせられません）。Sora を再起動してください');
    }
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
        this.warn(`uid ${uid} のプロセスが、PDF の解析のあとも残り、終わらせられません。この uid を隔離し、渡しません（次に借りるときに、もう一度確かめます）。残りの uid だけで解析を続けます`);
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
export const pdfDropProbe = {
  currentUid: (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined),
  launcher: (): string => DEFAULT_LAUNCHER,
  launcherExists: (): boolean => existsSync(pdfDropProbe.launcher()),
  missingCapabilities: (): string[] => missingDropCapabilities(readSelfStatus()),
  reap: (uid: number): Promise<boolean> => reapUid(uid),
};

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[Sora/PDF] ${message}`);
}

const pool = new PdfUidPool(PDF_CONCURRENCY, (uid) => pdfDropProbe.reap(uid), warnOnce);
/** 試験用: 1 回だけ出す警告を、もう一度出せるようにする */
export function resetPdfDropWarnings(): void {
  warned.clear();
}

/**
 * 別プロセスを起動する側（run）に、起動コマンドと環境変数を渡して動かす。落とすときは、uid を 1 つ借りて、起動用バイナリ経由のコマンドを渡し、
 * 終わったら（run が失敗しても）、その uid のプロセスを片づけて返す。落とさないときは、コマンドをそのまま渡す（環境変数は指定しない）。
 * strict で落とせないなら、run を呼ばずに失敗する（root のまま動かさない）。
 */
export async function withPdfUid<T>(
  command: readonly string[],
  run: (launch: { command: string[]; env?: Record<string, string> }) => Promise<T>,
  /** 設定を読む環境（テスト用。省略すると、プロセスの環境） */
  env: Env = process.env,
): Promise<T> {
  const strict = isolationLevel(env) === 'strict';
  const { drop, warnings } = planPdfDrop({
    env,
    strict,
    currentUid: pdfDropProbe.currentUid(),
    launcherExists: pdfDropProbe.launcherExists(),
    missingCapabilities: pdfDropProbe.missingCapabilities(),
    size: PDF_CONCURRENCY,
    // standard の Chromium は共有の 1 つ（番号 0）、strict は利用者ごと（最大 browserProcessMax 個）
    browser: browserUidRange(env, strict ? strictBrowserProcessMax(env) : 1),
    launcher: pdfDropProbe.launcher(),
  });
  for (const warning of warnings) warnOnce(warning);
  if (!drop) return run({ command: [...command] });
  const lease = await pool.lease(drop.baseUid);
  try {
    return await run(droppedChild(command, drop.launcher, lease.uid, lease.gid));
  } finally {
    await lease.done();
  }
}
