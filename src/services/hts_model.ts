// 関税分類モデル zeiban（https://github.com/ikenokazuki/zeiban、Apache-2.0）。商品の文から米国 HTS の 10 桁の候補を出す。
// WebAssembly（外からの取り込みが無く、ファイルにも通信にも触れない）として、同じプロセスの中で動かす。子プロセスは使わない。
// 判例の索引と同じく、使われたときだけ取得する（起動時の処理やタイマーは持たない）。取得するのは 3 つ（実行部の zeiban.wasm・目録の zeiban.json・
// 重みと表の zeiban.bin）で、SHA-256 はここに固定してある。初めての呼び出しは、取得と読み込みが済むまで待つ。
// 1 件の計算は同期で、数十ミリ秒のあいだ、ほかの処理を止める。
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envError, envUrl } from '../config.js';
import { errorMessage } from '../errors.js';
import { htsDirectory } from './hts_data.js';

export const HTS_MODEL_NAME = 'zeiban';
export const HTS_MODEL_VERSION = '0.2.1';
export const HTS_MODEL_HOMEPAGE = 'https://github.com/ikenokazuki/zeiban';
/** 3 つのファイルを置いた場所。SORA_HTS_MODEL_URL で、鏡や手元のフォルダ（file://）に替えられる。SHA-256 は替えられない（応答の組み立てが、この版に合わせてあるため）。 */
export const HTS_MODEL_URL = `${HTS_MODEL_HOMEPAGE}/releases/download/v${HTS_MODEL_VERSION}/`;
export const HTS_MODEL_FILES = {
  'zeiban.wasm': '99a73553df45a426e28a122754cfb1c1cd7e3c828b2d08093eb8796691a73bf0',
  'zeiban.json': '9f41f627cbfacc3a37efdec0da1e85c6afadb1578cebdde0acc4d5cd1779677e',
  'zeiban.bin': 'ba2f7883e9d37315c2c64137bd3fbe8d420eb0d552aa9e808b6e43b78a9653e0',
} as const;
type ModelFile = keyof typeof HTS_MODEL_FILES;
/** 上位の件数。モデルの確度は、この件数で合わせ込んである。 */
const TOP_K = 5;
const FETCH_TIMEOUT_MS = 300_000;
const RETRY_MS = 60 * 60 * 1000;

/** モデルに渡す 1 件。素材と分類は、説明の中に書くより、欄で渡すほうがよく効く。prefix は、もう分かっている頭の桁（2・4・6・8・10 桁）。 */
export interface HtsModelRequest {
  name: string;
  material?: string;
  categories?: string;
  description?: string;
  prefix?: string;
}

export interface HtsModelDuty {
  general: string;
  special: string;
  other: string;
}

/** モデルの応答（zeiban の README の「使い方」の形）。コードは数字だけの 10 桁。 */
export interface HtsModelResponse {
  /** 上位の 10 桁（点の高い順）。 */
  codes: string[];
  scores: number[];
  /** モデルが持つ関税率表の版（例: 2026HTSRev22）。 */
  htsRelease: string;
  hsCode: { code: string; description: string };
  sixDigit: string;
  /** 1 位の 10 桁が正しい確率。 */
  confidenceScore: number;
  /** 6 桁までが正しい確率。 */
  sixDigitConfidence: number;
  dutyRate: HtsModelDuty;
  /** 2 位からの候補。probabilityMass は、候補の中での割合。 */
  alternates: { code: string; description: string; probabilityMass: number; dutyRate: HtsModelDuty }[];
  /** 候補が分かれる最初の段の質問（0 か 1 個）。ask は、聞いたほうがよいという印。 */
  questions: {
    digits: number;
    ask: boolean;
    confidence: number;
    options: { prefix: string; label: string; code: string; probabilityMass: number; dutyRate: HtsModelDuty }[];
  }[];
  /** 日本語用の層で読んだときだけ 'ja'。 */
  reader?: 'ja';
}

export type HtsClassifier = (req: HtsModelRequest) => HtsModelResponse;

function baseUrl(): string {
  const invalid = envError('SORA_HTS_MODEL_URL');
  if (invalid) throw new Error(invalid);
  const url = envUrl('SORA_HTS_MODEL_URL') ?? HTS_MODEL_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const CHUNK = 1 << 20;

/** ファイルを少しずつ読んで、each に渡す（一式は 61MB あるので、丸ごとの写しを JS の側に作らない）。 */
function readChunks(path: string, each: (chunk: Uint8Array, offset: number) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = new Uint8Array(CHUNK);
    for (let offset = 0; ; ) {
      const n = readSync(fd, buf, 0, CHUNK, offset);
      if (n === 0) break;
      each(buf.subarray(0, n), offset);
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  readChunks(path, (chunk) => hash.update(chunk));
  return hash.digest('hex');
}

/** 取得して、SHA-256 を確かめる。 */
async function fetchFile(name: ModelFile): Promise<Uint8Array> {
  const want = HTS_MODEL_FILES[name];
  const url = baseUrl() + name;
  const res = await fetch(url, { headers: { 'User-Agent': 'Sora-Trade-Compliance-Fetcher/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`関税分類モデルの取得に失敗しました (HTTP ${res.status}): ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== want) throw new Error(`関税分類モデルの ${name} の SHA-256 が違います（期待 ${want.slice(0, 12)}…、実際 ${got.slice(0, 12)}…）`);
  return bytes;
}

/** 保存先に、SHA-256 の合うファイルを用意する（無いか、中身が違えば取得して、tmp に書いてから置き換える）。 */
async function ensureSaved(name: ModelFile, dir: string): Promise<string> {
  const path = join(dir, name);
  if (existsSync(path) && sha256File(path) === HTS_MODEL_FILES[name]) return path;
  const bytes = await fetchFile(name);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return path;
}

interface ZeibanExports {
  memory: WebAssembly.Memory;
  zb_alloc(n: number): number;
  zb_free(p: number, n: number): void;
  zb_load(man: number, manLen: number, bin: number, binLen: number): number;
  zb_classify(req: number, len: number, k: number): number;
  zb_out_ptr(): number;
  zb_out_len(): number;
}

/**
 * wasm を立ち上げ、目録と一式を渡して読み込ませる。一式は、中身（Uint8Array）か、保存したファイルのパスで渡す。
 * パスのときは、wasm のメモリへ直に読み込む（JS の側に 61MB の写しを残さない）。一式の場所は wasm の側が持ち続ける。
 */
export async function instantiateHtsModel(wasm: Uint8Array, manifest: Uint8Array, bundle: Uint8Array | string): Promise<HtsClassifier> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const ex = instance.exports as unknown as ZeibanExports;
  // wasm のメモリは伸びると付け替わるので、使うたびに ex.memory.buffer を取り直す
  const put = (bytes: Uint8Array) => {
    const p = ex.zb_alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
    return p;
  };
  const out = () => new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.zb_out_ptr(), ex.zb_out_len()));
  let bundlePtr: number;
  let bundleLen: number;
  if (typeof bundle === 'string') {
    bundleLen = statSync(bundle).size;
    bundlePtr = ex.zb_alloc(bundleLen);
    const target = new Uint8Array(ex.memory.buffer, bundlePtr, bundleLen); // 読み込みの間は、wasm のメモリを伸ばす呼び出しをしない
    readChunks(bundle, (chunk, offset) => target.set(chunk, offset));
  } else {
    bundleLen = bundle.length;
    bundlePtr = put(bundle);
  }
  const mp = put(manifest);
  const rc = ex.zb_load(mp, manifest.length, bundlePtr, bundleLen);
  ex.zb_free(mp, manifest.length);
  if (rc !== 0) throw new Error(`関税分類モデルを読み込めませんでした（${out()}）`);
  const encoder = new TextEncoder();
  return (req) => {
    const bytes = encoder.encode(JSON.stringify(req));
    const p = put(bytes);
    const code = ex.zb_classify(p, bytes.length, TOP_K);
    ex.zb_free(p, bytes.length);
    const text = out();
    if (code !== 0) throw new Error(`関税分類モデルが失敗しました（${text}）`);
    return JSON.parse(text) as HtsModelResponse;
  };
}

let current: HtsClassifier | undefined;
let loading: Promise<HtsClassifier> | undefined;
let lastError: string | undefined;
let retryAt = 0;

/** モデルを用意する（取得・確かめ・読み込み）。同時の要求は 1 回にまとめる。失敗したら 1 時間は取り直さず、同じ失敗を返す。 */
export function ensureHtsModel(): Promise<HtsClassifier> {
  if (current) return Promise.resolve(current);
  if (lastError && Date.now() < retryAt) return Promise.reject(new Error(`関税分類モデルを用意できませんでした（${lastError}）。しばらくしてから再実行してください`));
  if (!loading) {
    loading = (async () => {
      const root = htsDirectory();
      if (root) {
        // 保存してから読む。一式は、保存したファイルから wasm のメモリへ直に読み込む
        const dir = join(root, HTS_MODEL_NAME);
        const [wasm, manifest, bundle] = await Promise.all((Object.keys(HTS_MODEL_FILES) as ModelFile[]).map((name) => ensureSaved(name, dir)));
        current = await instantiateHtsModel(readFileSync(wasm), readFileSync(manifest), bundle);
      } else {
        // 保存先が無い（DB がメモリ上）ときは、取得した中身をそのまま渡す
        const [wasm, manifest, bundle] = await Promise.all((Object.keys(HTS_MODEL_FILES) as ModelFile[]).map((name) => fetchFile(name)));
        current = await instantiateHtsModel(wasm, manifest, bundle);
      }
      lastError = undefined;
      return current;
    })()
      .catch((err) => {
        lastError = errorMessage(err);
        retryAt = Date.now() + RETRY_MS;
        throw err;
      })
      .finally(() => {
        loading = undefined;
      });
  }
  return loading;
}

/** 1 件を分類する。初めての呼び出しは、モデルの取得と読み込みを待つ。 */
export async function classifyHts(req: HtsModelRequest): Promise<HtsModelResponse> {
  return (await ensureHtsModel())(req);
}

/** テスト用: モデルを差し替える（undefined で、読み込み前の状態に戻す）。 */
export function setHtsModelForTest(classifier?: HtsClassifier): void {
  current = classifier;
  loading = undefined;
  lastError = undefined;
  retryAt = 0;
}
