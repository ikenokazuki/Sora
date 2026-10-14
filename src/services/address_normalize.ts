import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressData } from './address_data.js';
import { lookupMlit } from './address_mlit.js';
import { AddressDisabledError, AddressInputError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import { lgCode6, type TownJson } from './address_names.js';
import type { NumberRanges } from './address_numbers.js';

/** 住所の各階層のキー。町字・郵便番号・逆引きの結合に使う。 */
export interface AddressKeys {
  prefCode?: string;
  /** 6 桁の全国地方公共団体コード。 */
  lgCode?: string;
  /** ABR の町字 ID。 */
  machiazaId?: string;
  /** 住居表示の街区符号・住居番号・住居番号2。 */
  blk?: string;
  rsdt?: string;
  rsdt2?: string;
  /** 地番（本番・枝番・孫番のうち値のあるもの）。 */
  prc?: string[];
}

export interface NormalizedAddress {
  input: string;
  /** 先頭の〒nnn-nnnn / nnn-nnnn を外した 7 桁。 */
  postalCode?: string;
  pref?: string;
  city?: string;
  town?: string;
  addr?: string;
  other: string;
  /** pref + city + town + addr。 */
  normalized: string;
  /** 0 都道府県も不明 / 1 都道府県 / 2 市区町村 / 3 町字 / 8 番地・号。 */
  level: number;
  /**
   * 番地・号を何で照合したか。null は整形だけで未照合。
   * mlit は国土交通省の街区レベル位置参照情報で、街区符号（住居表示でない町は地番の本番）まで。号は未照合で、点は街区の代表点（point.level 7）。
   */
  numberSource: 'rsdt' | 'chiban' | 'mlit' | null;
  keys: AddressKeys;
  point?: { lat: number; lon: number; level: number };
  /** 待ち時間までにデータが揃わず、取れている範囲で答えた。 */
  incomplete?: true;
  pending?: string[];
  unavailable?: Array<{ artifact: string; message: string }>;
}

export interface NormalizeOptions {
  /** ライブラリに渡す最大の正規化レベル（既定 8）。 */
  level?: number;
  /** データの取得を待つ上限。省略時は設定の waitMs。 */
  waitMs?: number;
}

export interface AddressNormalizerOptions {
  /** ライブラリを読み直すまでの時間。メモリの上限を兼ねる（既定 24 時間）。 */
  maxAgeMs?: number;
  now?: () => number;
}

// ---------- 郵便番号の分離 ----------

const FULL_WIDTH_DIGITS = /[０-９]/g;
const POSTAL_PREFIX = /^[\s　]*(?:〒[\s　]*)?([0-9０-９]{3})[-‐‑–—―−－ー]?([0-9０-９]{4})(?![0-9０-９])[\s　,、]*/;
const MAX_INPUT_LENGTH = 300;

/** 先頭の郵便番号（〒の有無、ハイフンの有無、全角を許す）を外す。ライブラリは〒付きだと住所を読めないため。 */
export function splitPostalCode(input: string): { postalCode?: string; address: string } {
  const match = input.match(POSTAL_PREFIX);
  if (!match) return { address: input.trim() };
  const postalCode = `${match[1]}${match[2]}`.replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  return { postalCode, address: input.slice(match[0].length).trim() };
}

// ---------- ライブラリの結果の整形 ----------

/** Geolonia ライブラリの結果のうち、このモジュールが読む部分。 */
export interface LibraryResult {
  pref?: string;
  city?: string;
  town?: string;
  addr?: string;
  other: string;
  level: number;
  point?: { lat: number; lng: number; level: number };
  metadata: {
    prefecture?: { code: number | string };
    city?: { code: number | string };
    machiAza?: { machiaza_id: string };
    rsdt?: { blk_num: string; rsdt_num: string; rsdt_num2: string };
    chiban?: { prc_num1: string; prc_num2: string; prc_num3: string };
    /** 国土交通省の街区レベル位置参照情報で補った街区符号。 */
    mlit?: { block: string };
  };
}

interface Notes {
  pending?: string[];
  unavailable?: Array<{ artifact: string; message: string }>;
}

export function shapeResult(input: string, postalCode: string | undefined, result: LibraryResult, notes: Notes): NormalizedAddress {
  const { metadata } = result;
  const keys: AddressKeys = {};
  const cityCode = metadata.city ? lgCode6(metadata.city.code) : undefined;
  const prefCode = cityCode?.slice(0, 2) ?? (metadata.prefecture ? lgCode6(metadata.prefecture.code).slice(0, 2) : undefined);
  if (prefCode) keys.prefCode = prefCode;
  if (cityCode) keys.lgCode = cityCode;
  if (metadata.machiAza) keys.machiazaId = metadata.machiAza.machiaza_id;
  let numberSource: NormalizedAddress['numberSource'] = null;
  if (metadata.rsdt) {
    numberSource = 'rsdt';
    keys.blk = metadata.rsdt.blk_num;
    keys.rsdt = metadata.rsdt.rsdt_num;
    if (metadata.rsdt.rsdt_num2) keys.rsdt2 = metadata.rsdt.rsdt_num2;
  } else if (metadata.chiban) {
    numberSource = 'chiban';
    keys.prc = [metadata.chiban.prc_num1, metadata.chiban.prc_num2, metadata.chiban.prc_num3].filter((part) => part !== '');
  } else if (metadata.mlit) {
    numberSource = 'mlit';
    keys.prc = [metadata.mlit.block];
  }
  const shaped: NormalizedAddress = {
    input,
    pref: result.pref,
    city: result.city,
    town: result.town,
    addr: result.addr,
    other: result.other.trim(),
    normalized: [result.pref, result.city, result.town, result.addr].filter(Boolean).join(''),
    level: result.level,
    numberSource,
    keys,
  };
  if (postalCode) shaped.postalCode = postalCode;
  if (result.point) shaped.point = { lat: result.point.lat, lon: result.point.lng, level: result.point.level };
  if (notes.pending || notes.unavailable) {
    shaped.incomplete = true;
    if (notes.pending) shaped.pending = notes.pending;
    if (notes.unavailable) shaped.unavailable = notes.unavailable;
  }
  return shaped;
}

// ---------- 言い換え ----------

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 漢数字（〇一二…九十百）をアラビア数字にする。百・十の位取りを読む。 */
function kanjiToNumber(text: string): number {
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = current * 10 + (KANJI_DIGITS[ch] ?? 0);
    }
  }
  return total + current;
}

/**
 * 入力のままでは番地・号に届かないときに試す、言い換えた入力の候補。ライブラリが読めない表記を補う。
 * 街区表記（6街区21号 → 6-21）、番地・線・号の漢数字（六十七番 → 67番。一番町のような地名は変えない）、葦と芦の異体字（葦北郡芦北町）。
 */
export function addressVariants(address: string): string[] {
  const variants = [
    address.replace(/(\d+)街区(\d+)号/, '$1-$2'),
    address.replace(/([〇一二三四五六七八九十百]+)(線|号(?!館)|番(?!町))/g, (_, digits: string, unit: string) => `${kanjiToNumber(digits)}${unit}`),
    // ABR は郡を「葦北郡」、町や大字を「芦北」と書く（葦北郡芦北町）。どちらの字で書かれた入力もこの綴りに合わせる。
    address.replaceAll('葦', '芦').replaceAll('芦北郡', '葦北郡'),
  ];
  return [...new Set(variants)].filter((variant) => variant !== address);
}

// ---------- ライブラリの読み込みと仮想ファイル ----------

interface FileResponse {
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

interface Library {
  normalize(input: string, option?: { level?: number }): Promise<LibraryResult>;
  config: { japaneseAddressesApi: string };
  requestHandlers: { file: (url: URL, options?: { offset?: number; length?: number }) => Promise<FileResponse> };
}

interface Generation {
  lib: Library;
  /** この世代に配ったデータの版（成果物 ID → 版）。番地・号のデータを渡せなかったものは空文字。 */
  served: Map<string, string>;
  /** 番地・号（段B）が間に合わず、段A だけを配った市区町村。この世代の答えは level 3 までになる。 */
  missing: Map<string, { pending: boolean; message: string }>;
  startedAt: number;
}

const VIRTUAL_ROOT = '/sora-address';
const CITY_FILE = new RegExp(`^${VIRTUAL_ROOT}/ja/([^/]+)/([^/]+)\\.json$`);
const NUMBER_FILE = new RegExp(`^${VIRTUAL_ROOT}/ja/([^/]+)/([^/]+)-(住居表示|地番)\\.txt$`);
const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;
/** 呼び出しごとの締め切り。仮想ファイルの中でデータの取得を待てる残り時間になる。 */
const callState = new AsyncLocalStorage<{ deadline: number }>();

const requireCache = createRequire(import.meta.url).cache;
let libraryChain: Promise<unknown> = Promise.resolve();

/**
 * ライブラリの新しいインスタンスを読む。ライブラリは町の一覧などをモジュールの中に残し続けて消せないため、
 * 配るデータが変わったときはモジュールごと読み直す。Bun は require.cache から消すと次の import で ESM も評価し直し、
 * 古いインスタンスは参照が無くなれば回収される（`?query` を付けた import は同じインスタンスのままなので使えない）。
 * 消して読むまでを 1 件ずつ行い、並行する読み込み同士でインスタンスを共有しないようにする。
 */
function importFreshLibrary(): Promise<Library> {
  const url = import.meta.resolve('@geolonia/normalize-japanese-addresses');
  const run = libraryChain.then(async () => {
    delete requireCache[fileURLToPath(url)];
    return (await import(url)) as Library;
  });
  libraryChain = run.catch(() => undefined);
  return run;
}

const textResponse = (text: string): FileResponse => ({ ok: true, text: async () => text, json: async () => JSON.parse(text) });
const NOT_FOUND: FileResponse = {
  ok: false,
  text: async () => '',
  json: async () => {
    throw new Error('not found');
  },
};

/**
 * 住所の正規化。アルゴリズムは Geolonia のライブラリに任せ、データの読み取りだけを差し替えて、
 * ローカルに取得した ABR のデータ（必要な市区町村だけ）を読ませる。
 */
export class AddressNormalizer {
  private current: Promise<Generation> | null = null;
  private loaded = 0;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(private readonly data: AddressData, options: AddressNormalizerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** ライブラリを何回読み込んだか（テスト用）。 */
  get generation(): number {
    return this.loaded;
  }

  async normalize(input: string, options: NormalizeOptions = {}): Promise<NormalizedAddress> {
    if (!this.data.enabled) throw new AddressDisabledError();
    const { postalCode, address } = splitPostalCode(input);
    if (address === '' && postalCode === undefined) throw new AddressInputError('住所が空です');
    if (address.length > MAX_INPUT_LENGTH) throw new AddressInputError(`住所は ${MAX_INPUT_LENGTH} 文字以内で指定してください`);
    if (address === '') return shapeResult(input, postalCode, { other: '', level: 0, metadata: {} }, {});

    const level = options.level ?? 8;
    const deadline = this.now() + (options.waitMs ?? this.data.config.waitMs);
    const generation = await this.acquire();
    const run = (maxLevel: number): Promise<LibraryResult> =>
      callState.run({ deadline }, () => generation.lib.normalize(address, { level: maxLevel }));

    // まず市区町村までで読む。ここでは市区町村のデータを使わない。市区町村までの入力は、これで答えが出る。
    const notes: Notes = {};
    let result = await run(Math.min(level, 2));
    if (level >= 3 && result.level >= 2 && result.other.trim() !== '') {
      try {
        result = await run(level);
      } catch (error) {
        // 市区町村のデータが揃わなくても、市区町村までの答えは返せる。
        if (error instanceof AddressPendingError && error.pending.startsWith('city:')) {
          notes.pending = [error.pending];
        } else if (error instanceof AddressUnavailableError && error.artifact?.startsWith('city:')) {
          notes.unavailable = [{ artifact: error.artifact, message: error.message }];
        } else {
          throw error;
        }
      }
    }
    // 番地・号に届かず、データの不足でもないときは、言い換えた入力を試し、より深く届いたものを採る。
    if (level >= 4 && result.level < 8 && !notes.pending && !notes.unavailable) {
      for (const variant of addressVariants(address)) {
        try {
          const retried = await callState.run({ deadline }, () => generation.lib.normalize(variant, { level }));
          if (retried.level > result.level) result = retried;
        } catch {
          // 言い換えで失敗しても、入力のままの答えを返す。
        }
      }
    }
    // 住所が解釈できず、先頭に郵便番号があるときは、郵便番号から都道府県・市区町村を補って解決し直す
    // （日本郵便は、正しい7桁の郵便番号があれば市区町村名を省略してよいとしている）。
    if (result.level === 0 && postalCode) {
      const city = await this.cityOfPostalCode(postalCode, options.waitMs);
      if (city) {
        const filled = await this.normalize(`${city}${address}`, options);
        if (filled.level > 0) return { ...filled, input, postalCode };
      }
    }
    this.data.store.touch('master');
    if (result.metadata.city) {
      const lgCode = lgCode6(result.metadata.city.code);
      this.data.store.touch(`city:${lgCode}`);
      this.data.store.touch(`num:${lgCode}`);
      // 番地・号のデータが無いまま配った市区町村の答えは、番地・号まで照合できていない。
      const gap = level >= 4 && result.level >= 3 ? generation.missing.get(`num:${lgCode}`) : undefined;
      if (gap?.pending) notes.pending = [...(notes.pending ?? []), `num:${lgCode}`];
      else if (gap) notes.unavailable = [...(notes.unavailable ?? []), { artifact: `num:${lgCode}`, message: gap.message }];
    }
    // ABR で番地・号に届かず、データの不足でもないときは、国土交通省の街区レベル位置参照情報で街区符号を補う。
    if (level >= 4 && result.level >= 3 && result.level < 8 && result.metadata.city && result.other.trim() !== '' && !notes.pending && !notes.unavailable) {
      result = await this.supplementFromMlit(result, deadline, notes);
    }
    return shapeResult(input, postalCode, result, notes);
  }

  /** 街区符号を国土交通省のデータで補う。取得できなくても、ABR だけの答えをそのまま返す（取得中のときだけ pending を記録する）。 */
  private async supplementFromMlit(result: LibraryResult, deadline: number, notes: Notes): Promise<LibraryResult> {
    const city = result.metadata.city;
    if (!city) return result;
    try {
      const { index } = await this.data.mlit(lgCode6(city.code), Math.max(0, deadline - this.now()));
      const hit = lookupMlit(index, result.town ?? '', result.other);
      if (!hit) return result;
      return {
        ...result, level: 8, addr: hit.block, other: hit.rest,
        point: { lat: hit.lat, lng: hit.lon, level: 7 }, metadata: { ...result.metadata, mlit: { block: hit.block } },
      };
    } catch (error) {
      if (error instanceof AddressPendingError) notes.pending = [error.pending];
      return result;
    }
  }

  /** 郵便番号が 1 つの市区町村に決まるとき、その都道府県と市区町村。決まらない、データが無いときは null。 */
  private async cityOfPostalCode(zipcode: string, waitMs?: number): Promise<string | null> {
    try {
      const { reader } = await this.data.postal(waitMs);
      const cities = new Set(reader.byZip(zipcode).map((row) => `${row.pref}${row.city}`));
      return cities.size === 1 ? ([...cities][0] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** 使えるライブラリの世代を返す。配ったデータが更新・破棄されたか、古くなっていれば読み直す。 */
  private async acquire(): Promise<Generation> {
    const promise = this.current;
    if (promise) {
      const generation = await promise;
      if (!this.outdated(generation)) return generation;
    }
    // 待っている間に他の呼び出しが先に読み直していれば、それを使う。
    if (this.current === promise) {
      const loading = this.load();
      this.current = loading;
      // 読み込みに失敗した世代を残さない（次の呼び出しでやり直す）。
      loading.catch(() => {
        if (this.current === loading) this.current = null;
      });
      return loading;
    }
    return this.current as Promise<Generation>;
  }

  private outdated(generation: Generation): boolean {
    if (this.now() - generation.startedAt > this.maxAgeMs) return true;
    const artifacts = this.data.status().artifacts;
    for (const [id, ver] of generation.served) {
      if ((artifacts[id]?.ver ?? '') !== ver) return true;
    }
    return false;
  }

  private async load(): Promise<Generation> {
    const lib = await importFreshLibrary();
    const generation: Generation = { lib, served: new Map(), missing: new Map(), startedAt: this.now() };
    lib.config.japaneseAddressesApi = `file://${VIRTUAL_ROOT}/ja`;
    lib.requestHandlers.file = (url, options) => this.serve(generation, url, options);
    this.loaded += 1;
    return generation;
  }

  /** ライブラリが読もうとするファイルを、ローカルのデータに対応づける。 */
  private async serve(generation: Generation, url: URL, options?: { offset?: number; length?: number }): Promise<FileResponse> {
    const deadline = callState.getStore()?.deadline ?? this.now() + this.data.config.waitMs;
    const remaining = (): number => Math.max(0, deadline - this.now());
    const path = decodeURI(url.pathname);
    if (path === `${VIRTUAL_ROOT}/ja.json`) {
      const ready = await this.data.ensure({ kind: 'master' }, remaining());
      generation.served.set(ready.id, ready.ver);
      return textResponse(await Bun.file(join(ready.path, 'ja.json')).text());
    }
    const cityMatch = path.match(CITY_FILE);
    if (cityMatch) return this.serveCity(generation, `${cityMatch[1]}/${cityMatch[2]}`, remaining);
    const numberMatch = path.match(NUMBER_FILE);
    if (numberMatch) return this.serveNumbers(generation, `${numberMatch[1]}/${numberMatch[2]}`, numberMatch[3] as '住居表示' | '地番', options);
    return NOT_FOUND;
  }

  /** 市区町村の町字（段A）に、番地・号（段B）の節の範囲を入れて返す。段B が間に合わなければ、範囲なしで返して記録する。 */
  private async serveCity(generation: Generation, name: string, remaining: () => number): Promise<FileResponse> {
    const city = (await this.data.master(remaining())).byName.get(name);
    if (!city) return NOT_FOUND;
    const ready = await this.data.ensure({ kind: 'city', lgCode: city.lgCode }, remaining());
    generation.served.set(ready.id, ready.ver);
    const towns = JSON.parse(await Bun.file(join(ready.path, 'town.json')).text()) as TownJson;

    const numId = `num:${city.lgCode}`;
    try {
      const numbers = await this.data.ensure({ kind: 'num', lgCode: city.lgCode }, remaining());
      generation.served.set(numId, numbers.ver);
      generation.missing.delete(numId);
      const ranges = JSON.parse(await Bun.file(join(numbers.path, 'ranges.json')).text()) as NumberRanges;
      for (const town of towns.data) {
        const range = ranges[town.machiaza_id];
        if (range) town.csv_ranges = range;
      }
    } catch (error) {
      if (error instanceof AddressPendingError) generation.missing.set(numId, { pending: true, message: error.message });
      else if (error instanceof AddressUnavailableError) generation.missing.set(numId, { pending: false, message: error.message });
      else throw error;
      // 段B が揃ったとき（版が空文字でなくなったとき）に、この世代を読み直す。
      generation.served.set(numId, '');
    }
    return textResponse(JSON.stringify(towns));
  }

  /** 配った版の rsdt.txt / chiban.txt から、ライブラリが指定したバイト範囲の節を返す。 */
  private async serveNumbers(
    generation: Generation, name: string, kind: '住居表示' | '地番', options?: { offset?: number; length?: number },
  ): Promise<FileResponse> {
    const city = (await this.data.master()).byName.get(name);
    const ver = city ? generation.served.get(`num:${city.lgCode}`) : undefined;
    if (!city || !ver) return NOT_FOUND;
    const file = Bun.file(join(this.data.store.artifactPath(`num:${city.lgCode}`, ver), kind === '住居表示' ? 'rsdt.txt' : 'chiban.txt'));
    if (!(await file.exists())) return NOT_FOUND;
    const blob = options?.offset !== undefined && options.length !== undefined ? file.slice(options.offset, options.offset + options.length) : file;
    return textResponse(await blob.text());
  }
}
