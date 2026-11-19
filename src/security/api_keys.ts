// 名前つきの複数の鍵（鍵ファイル。SORA_AUTH_KEYS_FILE）。設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 4。
// 共有のサービスとして、鍵ごとに別の tenant で動かすための入口。tenant の ID は、鍵でなく name から作る（鍵を入れ替えても、tenant の状態が消えない）。
//
//   { "keys": [ { "name": "alice", "key": "<16〜256 字の ASCII>" }, { "name": "bob", "keyHash": "sha256:<64 桁の 16 進>" }, { "name": "ops", "key": "…", "admin": true } ] }
//
// admin: true の鍵だけが、全体に効く操作（全員分のキャッシュの消去など）をできる。鍵ごとの属性で、同じ name の別の鍵には及ばない。
//
// 誤りは、鍵の値もハッシュも文に入れず（標準エラーに残る）、すべてを一度に知らせる。1 つでもあれば、鍵の表は作らない（読めない鍵ファイルを、匿名にしない）。
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { envPath, type Env } from '../config.js';
import { incrementSecurityCounter } from './metrics.js';

export interface ApiKeyEntry {
  /** tenant の名前（tenant の ID は `name:<name>`） */
  name: string;
  /** 鍵の UTF-8 の SHA-256（小文字の 16 進） */
  digest: string;
  /** 平文の key で書かれていた（ハッシュの keyHash ではない） */
  plain: boolean;
  /** 全体に効く操作を許す鍵（admin: true）。鍵ごとの属性 */
  admin: boolean;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PLAIN_KEY = /^[\x21-\x7e]{16,256}$/;
const KEY_HASH = /^sha256:([0-9a-fA-F]{64})$/;
const ENTRY_FIELDS: readonly string[] = ['name', 'key', 'keyHash', 'admin'];

export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 項目の名前を文に入れる。名前の形をしたものだけ（ファイルの中身を、そのまま標準エラーに出さない） */
// 項目の名前を、誤りの文に出すのは、名前の形で、15 字までのとき。鍵は 16 字以上なので、鍵が項目の名前に書かれても(name と key の取り違え)、文に出ない
const shown = (field: string) => (/^[A-Za-z0-9_.-]{1,15}$/.test(field) ? field : '（読めない名前）');

/** 鍵ファイルの文字列を読む。誤りが 1 つでもあれば、entries は空 */
export function parseApiKeyFile(text: string): { entries: ApiKeyEntry[]; errors: string[] } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    // JSON.parse の文は、ファイルの断片（鍵かもしれない）を含みうるので使わない
    return { entries: [], errors: ['JSON として読めません（カンマ・引用符・括弧を確かめてください）'] };
  }
  if (!isObject(root)) return { entries: [], errors: ['最上位は {"keys": [{"name": …, "key": …}, …]} の形にしてください'] };

  const errors: string[] = [];
  for (const field of Object.keys(root)) {
    if (field !== 'keys') errors.push(`最上位に、未対応の項目 ${shown(field)} があります（対応しているのは keys だけ）`);
  }
  const rows = root.keys;
  if (rows === undefined) errors.push('最上位に keys（配列）がありません');
  else if (!Array.isArray(rows)) errors.push('keys は配列にしてください');
  else if (rows.length === 0) errors.push('鍵が 1 つもありません（鍵ファイルを設定したときは、1 つ以上の鍵が要ります。匿名にはしません）');

  const entries: ApiKeyEntry[] = [];
  const firstIndexOfDigest = new Map<string, number>();
  (Array.isArray(rows) ? rows : []).forEach((row: unknown, index: number) => {
    const at = `keys[${index}]`;
    if (!isObject(row)) {
      errors.push(`${at} はオブジェクトにしてください`);
      return;
    }
    for (const field of Object.keys(row)) {
      if (!ENTRY_FIELDS.includes(field)) errors.push(`${at} に、未対応の項目 ${shown(field)} があります（対応しているのは name・key・keyHash・admin）`);
    }

    let name: string | undefined;
    if (row.name === undefined) errors.push(`${at}.name がありません`);
    else if (typeof row.name !== 'string') errors.push(`${at}.name は文字列にしてください`);
    else if (!NAME.test(row.name)) errors.push(`${at}.name は、英小文字・数字・-・_ の 1〜64 字にしてください（先頭は英小文字か数字）`);
    else name = row.name;

    let digest: string | undefined;
    let plain = false;
    if (row.key !== undefined && row.keyHash !== undefined) errors.push(`${at} に key と keyHash の両方は書けません（どちらか 1 つ）`);
    else if (row.key === undefined && row.keyHash === undefined) errors.push(`${at} に key か keyHash が要ります（どちらか 1 つ）`);
    else if (row.key !== undefined) {
      if (typeof row.key !== 'string') errors.push(`${at}.key は文字列にしてください`);
      else if (!PLAIN_KEY.test(row.key)) errors.push(`${at}.key は、16〜256 字の、空白を含まない ASCII の印字可能な文字にしてください`);
      else {
        digest = digestOf(row.key);
        plain = true;
      }
    } else if (typeof row.keyHash !== 'string') errors.push(`${at}.keyHash は文字列にしてください`);
    else {
      const matched = KEY_HASH.exec(row.keyHash);
      if (!matched) errors.push(`${at}.keyHash は、sha256: と 64 桁の 16 進にしてください（printf %s "$KEY" | sha256sum の値）`);
      else digest = matched[1].toLowerCase();
    }

    let admin = false;
    if (row.admin !== undefined) {
      if (typeof row.admin !== 'boolean') errors.push(`${at}.admin は true か false にしてください`);
      else admin = row.admin;
    }

    if (name === undefined || digest === undefined) return;
    const earlier = firstIndexOfDigest.get(digest);
    if (earlier !== undefined) {
      errors.push(`${at} の鍵は、keys[${earlier}] と同じです`);
      return;
    }
    firstIndexOfDigest.set(digest, index);
    entries.push({ name, digest, plain, admin });
  });
  return { entries: errors.length > 0 ? [] : entries, errors };
}

/**
 * 鍵の表。提示された鍵を SHA-256 にしてから表を引くので、鍵の数にも、一致する位置にも、比べる時間が依存しない
 * （攻撃者は、表のハッシュの値を作れないので、表の引き方の時間の差から、鍵を絞れない）。
 */
export class ApiKeyStore {
  private readonly owners = new Map<string, { name: string; admin: boolean }>();

  constructor(entries: readonly ApiKeyEntry[]) {
    for (const { digest, name, admin } of entries) this.owners.set(digest, { name, admin });
  }

  /** 鍵の持ち主の name と、全体に効く操作を許す鍵か。知らない鍵は undefined */
  lookupEntry(token: string): { name: string; admin: boolean } | undefined {
    return this.owners.get(digestOf(token));
  }

  /** 鍵の持ち主の name。知らない鍵は undefined */
  lookup(token: string): string | undefined {
    return this.lookupEntry(token)?.name;
  }

  get size(): number {
    return this.owners.size;
  }

  /** tenant の name（重複なし・並べ替え済み） */
  names(): string[] {
    return [...new Set([...this.owners.values()].map((owner) => owner.name))].sort();
  }
}

export interface LoadedApiKeys {
  /**
   * 鍵の表。最初の 1 回は、誤りが無いときだけ。2 回目以降は、最後に読めた表(いまのファイルが誤りでも、前の表を使い続けるので、errors には、いまの誤りが出ない)
   */
  store?: ApiKeyStore;
  errors: string[];
  warnings: string[];
}

/** ファイルの読み方。テストで、読む前後の置き換えや、読み取りの失敗を再現するために、差し替えられる */
export interface KeyFileFs {
  stat(path: string): { mtimeMs: number; ctimeMs: number; size: number; ino: number; mode: number };
  read(path: string): string;
}

const realFs: KeyFileFs = { stat: (path) => statSync(path), read: (path) => readFileSync(path, 'utf8') };

/** 変わったかを見分ける署名と、権限。見つからない・調べられないときは、そのコード */
type KeyFileStat = { ok: true; signature: string; mode: number } | { ok: false; code: string; missing: boolean };

/** ファイルを調べる。署名は、読む前に取る(読む間に置き換わっても、古い内容に新しい署名を付けて、永久に見逃さないため) */
function statKeyFile(path: string, fs: KeyFileFs): KeyFileStat {
  try {
    const stat = fs.stat(path);
    return { ok: true, signature: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`, mode: stat.mode };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'エラー';
    return { ok: false, code, missing: code === 'ENOENT' || code === 'ENOTDIR' };
  }
}

const unreadableMessage = (path: string, code: string) => `鍵ファイル（${JSON.stringify(path)}）を読めません（${code}）。パスと権限を確かめてください`;

/**
 * 中身を読んで、鍵の表を作る(調べたあとに呼ぶ)。unreadable は、読み取りそのものの失敗(EMFILE・EIO など。一時的かもしれない)。
 * 中身の誤りは unreadable ではない(同じファイルを読み直しても、同じ誤りになるので、署名を覚えてよい)。
 */
function readKeyFile(path: string, fs: KeyFileFs, mode: number): { loaded: LoadedApiKeys; unreadable: boolean } {
  let text: string;
  try {
    text = fs.read(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'エラー';
    return { loaded: { errors: [unreadableMessage(path, code)], warnings: [] }, unreadable: true };
  }
  const { entries, errors } = parseApiKeyFile(text);
  if (errors.length > 0) return { loaded: { errors, warnings: [] }, unreadable: false };
  const warnings: string[] = [];
  if (entries.some((entry) => entry.plain) && (mode & 0o077) !== 0) {
    warnings.push(`鍵ファイル（${JSON.stringify(path)}）に平文の鍵があり、所有者以外も読めます（権限 ${(mode & 0o777).toString(8)}）。chmod 600 にするか、keyHash で書いてください`);
  }
  // 読み直しで、鍵ファイルに書ける人は、管理者の鍵を足せる。だれでも書けるファイルは、警告する
  if ((mode & 0o002) !== 0) {
    warnings.push(`鍵ファイル（${JSON.stringify(path)}）を、だれでも書けます（権限 ${(mode & 0o777).toString(8)}）。書ける人は、管理者の鍵を足せます。chmod 600 にして、書ける人を限ってください`);
  }
  return { loaded: { store: new ApiKeyStore(entries), errors: [], warnings }, unreadable: false };
}

/**
 * 鍵ファイルの変更を調べる間隔(ミリ秒)。要求のたびには調べない(stat を 1 秒に 1 回まで)。
 * 鍵の追加・削除は、再起動なしで、この間隔のうちに効く。
 */
const RECHECK_MS = 1000;

/** 古い表で動いている間、知らせ直す間隔(ミリ秒) */
const STALE_REMINDER_MS = 60_000;

/** ログに出す、失敗の理由の長さの上限(巨大なファイルの誤りで、ログを埋めない) */
const NOTICE_LIMIT = 1500;

/** 1 つの鍵ファイルの、読んだ結果と、見張りの状態 */
interface WatchedKeyFile {
  /** 使っている結果。読み直しに失敗しても、前の(読めた)表のまま。最初の読み込みが誤りなら、その誤り */
  current: LoadedApiKeys;
  /**
   * 最後に「中身を読んだ」ファイルの署名(読む前に取ったもの。誤りの中身も覚える)。undefined は、まだ読めていない
   * (読み取りそのものが失敗したときは、覚えない。次の確認で、読み直す)
   */
  signature: string | undefined;
  /** いま使っている表の元になった、ファイルの署名(最初の読み込みが誤りなら undefined)。ファイルがこの署名に戻れば、古い表ではなくなる */
  appliedSignature: string | undefined;
  checkedAt: number;
  /** ファイルが見つからないことを、すでに知らせたか(戻るまで、繰り返さない) */
  missingReported: boolean;
  /** 読み取り・調べるのに失敗した理由を、すでに知らせたか(同じ理由を、繰り返さない) */
  unreadableReported: string | undefined;
  /** 古い表で動き始めた時刻(いまのファイルを、使えていない間)。使えていれば undefined */
  staleSince: number | undefined;
  lastReminderAt: number;
  /** すでに出した警告(読み直しのたびに、同じ警告を繰り返さない) */
  shownWarnings: Set<string>;
}

const watched = new Map<string, WatchedKeyFile>();

/** 運用者への知らせは標準エラー(stdio では標準出力が JSON-RPC の流れ)。鍵の値は出さない */
function notice(message: string): void {
  console.warn(`[Sora/Auth] ${message}`);
}

const clip = (text: string): string => (text.length > NOTICE_LIMIT ? `${text.slice(0, NOTICE_LIMIT)}…(長いので、ここまで)` : text);

/** いまのファイルを使えていない(前の表で動いている)ことを覚える。1 分ごとに、知らせ直す */
function markStale(entry: WatchedKeyFile, now: number): void {
  if (entry.staleSince === undefined) {
    entry.staleSince = now;
    entry.lastReminderAt = now;
  }
}

function remindIfStale(entry: WatchedKeyFile, now: number): void {
  if (entry.staleSince === undefined || !entry.current.store || now - entry.lastReminderAt < STALE_REMINDER_MS) return;
  entry.lastReminderAt = now;
  const minutes = Math.max(1, Math.round((now - entry.staleSince) / 60_000));
  notice(`鍵ファイルを、${minutes} 分前から使えていません。前の鍵を使い続けています(消した鍵・管理者から外した鍵も、まだ有効です)。ファイルを直してください`);
}

/** 読み取り・調べるのに失敗した(一時的かもしれない)。署名は覚えず、次の確認で、読み直す。同じ理由は、繰り返し知らせない */
function reportUnreadable(entry: WatchedKeyFile, message: string, now: number): void {
  markStale(entry, now);
  if (entry.unreadableReported === message || !entry.current.store) return;
  entry.unreadableReported = message;
  incrementSecurityCounter('sora_auth_keys_reload_failed_total');
  notice(`鍵ファイルを読み直せませんでした。前の鍵を使い続けます: ${clip(message)}`);
}

/**
 * 変わっていれば読み直す。読み直しに失敗したら、前の表を使い続ける(匿名にも、全部を断る状態にもしない)。
 * 中身の誤りは、署名を覚えるので、同じファイルを何度も読み直さず、同じ理由を繰り返し出さない。読み取りそのものの失敗は、覚えない(再試行する)。
 */
function recheck(path: string, entry: WatchedKeyFile, now: number, fs: KeyFileFs): void {
  const stat = statKeyFile(path, fs);
  if (!stat.ok) {
    if (stat.missing) {
      // 消えた。置き換えの途中かもしれないので、前の表を使い続ける。署名は変えない(戻ったら、読み直す)
      markStale(entry, now);
      if (!entry.missingReported && entry.current.store) {
        entry.missingReported = true;
        incrementSecurityCounter('sora_auth_keys_missing_total');
        notice(`鍵ファイル(${JSON.stringify(path)})が見つかりません。置き換えの途中なら、まもなく戻ります。前の鍵を使い続けます`);
      }
    } else {
      reportUnreadable(entry, `鍵ファイル(${JSON.stringify(path)})を調べられません(${stat.code})。権限(親のディレクトリを含む)を確かめてください`, now);
    }
    remindIfStale(entry, now);
    return;
  }
  // あった。署名が前と同じでも(同じ大きさのファイルを、同じ時刻の刻みで作り直したとき)、戻ったことは覚える(また消えたら、知らせ直す)
  entry.missingReported = false;
  if (stat.signature === entry.signature) {
    // 変わっていない。直前に、調べるのに失敗していたなら、それは解けた
    entry.unreadableReported = undefined;
    // 使っている表の元のファイルに戻った(消えたあとに、同じファイルが戻った、など)なら、古い表ではない
    if (stat.signature === entry.appliedSignature) entry.staleSince = undefined;
    remindIfStale(entry, now);
    return;
  }
  const result = readKeyFile(path, fs, stat.mode);
  if (result.unreadable) {
    reportUnreadable(entry, result.loaded.errors.join(' / '), now);
    remindIfStale(entry, now);
    return;
  }
  entry.unreadableReported = undefined;
  entry.signature = stat.signature;
  if (!result.loaded.store) {
    markStale(entry, now);
    incrementSecurityCounter('sora_auth_keys_reload_failed_total');
    notice(`鍵ファイルを読み直せませんでした。前の鍵を使い続けます: ${clip(result.loaded.errors.join(' / '))}`);
    return;
  }
  const before = entry.current.store;
  entry.current = result.loaded;
  entry.appliedSignature = stat.signature;
  entry.staleSince = undefined;
  incrementSecurityCounter('sora_auth_keys_reload_total');
  notice(
    `鍵ファイルを読み直しました(鍵 ${result.loaded.store.size} 件・利用者 ${result.loaded.store.names().length} 人${before ? `。前は 鍵 ${before.size} 件・利用者 ${before.names().length} 人` : ''})`,
  );
  for (const warning of result.loaded.warnings) {
    if (!entry.shownWarnings.has(warning)) notice(warning);
  }
  entry.shownWarnings = new Set(result.loaded.warnings);
}

/**
 * 鍵ファイルを読んで、鍵の表を作る。同じパスは覚えて、ファイルが変わったかを、1 秒に 1 回まで調べる(起動の検査が読んだ表を、
 * 要求のたびに引き直さない)。鍵の追加・削除は、再起動が要らない。now は、確認の間隔の判定用(テストで渡す。有限の数でなければ、いまの時刻)。
 * fs は、テストで、読み方を差し替える(既定は、実際のファイル)。
 */
export function loadApiKeyStore(path: string, now: number = Date.now(), fs: KeyFileFs = realFs): LoadedApiKeys {
  const at = Number.isFinite(now) ? now : Date.now();
  const entry = watched.get(path);
  if (!entry) {
    const stat = statKeyFile(path, fs);
    const read = stat.ok ? readKeyFile(path, fs, stat.mode) : undefined;
    const loaded: LoadedApiKeys = read ? read.loaded : { errors: [unreadableMessage(path, stat.ok ? 'エラー' : stat.code)], warnings: [] };
    const created: WatchedKeyFile = {
      current: loaded,
      // 読めたときだけ、署名を覚える(読み取りの失敗は、覚えない。次の確認で、読み直す)。署名は、読む前に取ったもの
      signature: stat.ok && read && !read.unreadable ? stat.signature : undefined,
      appliedSignature: stat.ok && read?.loaded.store ? stat.signature : undefined,
      checkedAt: at,
      missingReported: false,
      unreadableReported: undefined,
      staleSince: undefined,
      lastReminderAt: at,
      shownWarnings: new Set(loaded.warnings),
    };
    watched.set(path, created);
    return created.current;
  }
  // 時計が戻ったときも、調べる
  if (at - entry.checkedAt >= RECHECK_MS || at < entry.checkedAt) {
    entry.checkedAt = at;
    recheck(path, entry, at, fs);
  }
  return entry.current;
}

/** 覚えた鍵の表を捨てる(テスト用) */
export function resetApiKeyStoreCache(): void {
  watched.clear();
}

/**
 * 認証が使う鍵の表。SORA_AUTH_KEYS_FILE が無ければ undefined（従来どおり SORA_API_KEY か、認証なし）。
 * 誤りがあれば例外（読めない鍵ファイルを、匿名にしない）。起動の検査（startup_check.ts）が先に読んで検査するので、
 * ここで失敗するのは、起動の検査を通さずに使うときだけ。ファイルが変わっていれば（1 秒に 1 回まで調べる）読み直す。読み直しに失敗したら、前の表を返す。
 */
export function getApiKeyStore(env?: Env, now: number = Date.now()): ApiKeyStore | undefined {
  const path = envPath('SORA_AUTH_KEYS_FILE', env);
  if (!path) return undefined;
  const { store, errors } = loadApiKeyStore(path, now);
  if (!store) throw new Error(errors.join(' / '));
  return store;
}
