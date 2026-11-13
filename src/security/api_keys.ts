// 名前つきの複数の鍵（鍵ファイル。SORA_AUTH_KEYS_FILE）。設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 4。
// 共有のサービスとして、鍵ごとに別の tenant で動かすための入口。tenant の ID は、鍵でなく name から作る（鍵を入れ替えても、tenant の状態が消えない）。
//
//   { "keys": [ { "name": "alice", "key": "<16〜256 字の ASCII>" }, { "name": "bob", "keyHash": "sha256:<64 桁の 16 進>" } ] }
//
// 誤りは、鍵の値もハッシュも文に入れず（標準エラーに残る）、すべてを一度に知らせる。1 つでもあれば、鍵の表は作らない（読めない鍵ファイルを、匿名にしない）。
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { envPath, type Env } from '../config.js';

export interface ApiKeyEntry {
  /** tenant の名前（tenant の ID は `name:<name>`） */
  name: string;
  /** 鍵の UTF-8 の SHA-256（小文字の 16 進） */
  digest: string;
  /** 平文の key で書かれていた（ハッシュの keyHash ではない） */
  plain: boolean;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PLAIN_KEY = /^[\x21-\x7e]{16,256}$/;
const KEY_HASH = /^sha256:([0-9a-fA-F]{64})$/;
const ENTRY_FIELDS: readonly string[] = ['name', 'key', 'keyHash'];

export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 項目の名前を文に入れる。名前の形をしたものだけ（ファイルの中身を、そのまま標準エラーに出さない） */
const shown = (field: string) => (/^[A-Za-z0-9_.-]{1,40}$/.test(field) ? field : '（読めない名前）');

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
      if (!ENTRY_FIELDS.includes(field)) errors.push(`${at} に、未対応の項目 ${shown(field)} があります（対応しているのは name・key・keyHash）`);
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

    if (name === undefined || digest === undefined) return;
    const earlier = firstIndexOfDigest.get(digest);
    if (earlier !== undefined) {
      errors.push(`${at} の鍵は、keys[${earlier}] と同じです`);
      return;
    }
    firstIndexOfDigest.set(digest, index);
    entries.push({ name, digest, plain });
  });
  return { entries: errors.length > 0 ? [] : entries, errors };
}

/**
 * 鍵の表。提示された鍵を SHA-256 にしてから表を引くので、鍵の数にも、一致する位置にも、比べる時間が依存しない
 * （攻撃者は、表のハッシュの値を作れないので、表の引き方の時間の差から、鍵を絞れない）。
 */
export class ApiKeyStore {
  private readonly owners = new Map<string, string>();

  constructor(entries: readonly ApiKeyEntry[]) {
    for (const { digest, name } of entries) this.owners.set(digest, name);
  }

  /** 鍵の持ち主の name。知らない鍵は undefined */
  lookup(token: string): string | undefined {
    return this.owners.get(digestOf(token));
  }

  get size(): number {
    return this.owners.size;
  }

  /** tenant の name（重複なし・並べ替え済み） */
  names(): string[] {
    return [...new Set(this.owners.values())].sort();
  }
}

export interface LoadedApiKeys {
  /** 誤りが無いときだけ */
  store?: ApiKeyStore;
  errors: string[];
  warnings: string[];
}

const loaded = new Map<string, LoadedApiKeys>();

function readApiKeyFile(path: string): LoadedApiKeys {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(path, 'utf8');
    mode = statSync(path).mode;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'エラー';
    return { errors: [`鍵ファイル（${JSON.stringify(path)}）を読めません（${code}）。パスと権限を確かめてください`], warnings: [] };
  }
  const { entries, errors } = parseApiKeyFile(text);
  if (errors.length > 0) return { errors, warnings: [] };
  const warnings: string[] = [];
  if (entries.some((entry) => entry.plain) && (mode & 0o077) !== 0) {
    warnings.push(`鍵ファイル（${JSON.stringify(path)}）に平文の鍵があり、所有者以外も読めます（権限 ${(mode & 0o777).toString(8)}）。chmod 600 にするか、keyHash で書いてください`);
  }
  return { store: new ApiKeyStore(entries), errors: [], warnings };
}

/**
 * 鍵ファイルを読んで、鍵の表を作る。同じパスは 1 回だけ読んで覚える（起動の検査が読んだ表を、要求のたびに引き直さない。鍵を変えたら再起動する）。
 */
export function loadApiKeyStore(path: string): LoadedApiKeys {
  const known = loaded.get(path);
  if (known) return known;
  const result = readApiKeyFile(path);
  loaded.set(path, result);
  return result;
}

/** 覚えた鍵の表を捨てる（テスト用） */
export function resetApiKeyStoreCache(): void {
  loaded.clear();
}

/**
 * 認証が使う鍵の表。SORA_AUTH_KEYS_FILE が無ければ undefined（従来どおり SORA_API_KEY か、認証なし）。
 * 誤りがあれば例外（読めない鍵ファイルを、匿名にしない）。起動の検査（startup_check.ts）が先に読んで検査するので、
 * ここで失敗するのは、起動の検査を通さずに使うときだけ。
 */
export function getApiKeyStore(env?: Env): ApiKeyStore | undefined {
  const path = envPath('SORA_AUTH_KEYS_FILE', env);
  if (!path) return undefined;
  const { store, errors } = loadApiKeyStore(path);
  if (!store) throw new Error(errors.join(' / '));
  return store;
}
