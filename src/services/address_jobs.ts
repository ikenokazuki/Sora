import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJaJson, buildTownJson, isSupportedSrid, type Row } from './address_abr.js';
import { parseCsvRows, readZipText, scanZipCsv } from './address_csv.js';
import {
  ABR_BASE, combineSignatures, downloadToFile, headSignature, latestSourceDate, resolveJapanPostLinks, type HttpDeps, type Signature,
} from './address_http.js';
import { buildGeoIndex, type GeoPoint } from './address_geo_index.js';
import { lgCode6, type JaJson, type TownJson } from './address_names.js';
import { MLIT_VERSIONS, buildMlitIndex, mlitCityUrl } from './address_mlit.js';
import { buildNumbers, type NumberFiles } from './address_numbers.js';
import { jobArtifactId, type AddressStore, type BuildJob } from './address_store.js';
import { buildPostalDb, parseJigyosyo, parseKenAll } from './postal_code.js';

export type { BuildJob } from './address_store.js';

/** 構築結果がこれより小さければ、取得元の形式が変わったとみなして公開しない。 */
export interface JobMinimum {
  prefs: number;
  cities: number;
  towns: number;
  general: number;
  office: number;
  /** 町字の点の全国索引の点の数。 */
  points: number;
}
export const DEFAULT_MINIMUM: JobMinimum = { prefs: 47, cities: 1500, towns: 1, general: 100_000, office: 15_000, points: 150_000 };

export interface JobDeps {
  store: AddressStore;
  http?: HttpDeps;
  minimum?: Partial<JobMinimum>;
  nowSeconds?: () => number;
}

const INDEX_CONCURRENCY = 8;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const seconds = (deps: JobDeps): number => (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
const limits = (deps: JobDeps): JobMinimum => ({ ...DEFAULT_MINIMUM, ...deps.minimum });

/** 1 つの構築ジョブを同じプロセスの中で実行する。子プロセスの入口とテストから呼ぶ。 */
export async function runBuildJob(job: BuildJob, deps: JobDeps): Promise<void> {
  try {
    if (job.kind === 'master') await buildMaster(deps);
    else if (job.kind === 'postal') await buildPostal(deps);
    else if (job.kind === 'index') await buildIndex(deps);
    else if (job.kind === 'num') await buildNum(job.lgCode, deps);
    else if (job.kind === 'mlit') await buildMlit(job.lgCode, deps);
    else await buildCity(job.lgCode, deps);
  } catch (error) {
    await deps.store.markError(jobArtifactId(job), errorText(error)).catch(() => undefined);
    throw error;
  }
}

const MASTER_FILES = {
  prefs: 'mt_pref/mt_pref_all',
  prefPos: 'mt_pref_pos/mt_pref_pos_all',
  cities: 'mt_city/mt_city_all',
  cityPos: 'mt_city_pos/mt_city_pos_all',
} as const;

async function buildMaster(deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  const keys = Object.keys(MASTER_FILES) as Array<keyof typeof MASTER_FILES>;
  const urls = keys.map((key) => `${ABR_BASE}/${MASTER_FILES[key]}.csv.zip`);
  const signatures = await Promise.all(urls.map((url) => headSignature(url, http)));
  if (signatures.some((signature) => signature === null)) throw new Error('ABR の全国マスターが見つかりません');
  const sig = combineSignatures(signatures);
  const sourceDate = latestSourceDate(signatures);
  if (store.current('master')?.meta.sig === sig) {
    await store.markChecked('master', sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const rows = {} as Record<keyof typeof MASTER_FILES, Row[]>;
    for (const [index, key] of keys.entries()) {
      const zip = join(work, `${key}.zip`);
      if (!(await downloadToFile(urls[index] as string, zip, http))) throw new Error(`ABR の ${MASTER_FILES[key]} が見つかりません`);
      rows[key] = parseCsvRows(await readZipText(zip));
    }
    const ja = buildJaJson(rows, seconds(deps));
    const min = limits(deps);
    const cityCount = ja.data.reduce((sum, pref) => sum + pref.cities.length, 0);
    if (ja.data.length < min.prefs || cityCount < min.cities) {
      throw new Error(`ABR の全国マスターが想定より小さい（都道府県 ${ja.data.length}、市区町村 ${cityCount}）`);
    }
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'ja.json'), JSON.stringify(ja));
    await store.publish('master', out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function buildCity(lgCode: string, deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  if (!/^\d{6}$/.test(lgCode)) throw new Error(`不正な市区町村コード: ${lgCode}`);
  const id = `city:${lgCode}`;
  const townUrl = `${ABR_BASE}/mt_town/city/mt_town_city${lgCode}.csv.zip`;
  const posUrl = `${ABR_BASE}/mt_town_pos/city/mt_town_pos_city${lgCode}.csv.zip`;
  const [townSig, posSig] = await Promise.all([headSignature(townUrl, http), headSignature(posUrl, http)]);
  if (!townSig) throw new Error(`ABR に ${lgCode} の町字データがありません`);
  const sig = combineSignatures([townSig, posSig]);
  const sourceDate = latestSourceDate([townSig, posSig]);
  if (store.current(id)?.meta.sig === sig) {
    await store.markChecked(id, sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const townZip = join(work, 'town.zip');
    if (!(await downloadToFile(townUrl, townZip, http))) throw new Error(`ABR に ${lgCode} の町字データがありません`);
    let posRows: Row[] = [];
    if (posSig) {
      const posZip = join(work, 'pos.zip');
      if (await downloadToFile(posUrl, posZip, http)) posRows = parseCsvRows(await readZipText(posZip));
    }
    const town = buildTownJson(parseCsvRows(await readZipText(townZip)), posRows, seconds(deps));
    if (town.data.length < limits(deps).towns) throw new Error(`ABR の ${lgCode} の町字データが空です`);
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'town.json'), JSON.stringify(town));
    await store.publish(id, out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 同時に走らせる数を絞って、items を順に処理する。1 件でも失敗したら、それ以降は始めない。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 町字の点の全国索引。全国マスターの都道府県ごとに、町字の位置参照（都道府県単位の zip）を取得して、
 * 近傍検索用の SQLite にまとめる。全国マスターが無ければ先に作る。
 */
async function buildIndex(deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  if (!store.current('master')) await buildMaster(deps);
  const master = store.current('master');
  if (!master) throw new Error('全国マスターを用意できませんでした');
  const ja = JSON.parse(readFileSync(join(master.path, 'ja.json'), 'utf8')) as JaJson;
  const prefCodes = ja.data.map((pref) => lgCode6(pref.code).slice(0, 2));
  const urls = prefCodes.map((code) => `${ABR_BASE}/mt_town_pos/pref/mt_town_pos_pref${code}.csv.zip`);
  const signatures = await mapLimit(urls, INDEX_CONCURRENCY, (url) => headSignature(url, http));
  const missing = prefCodes.filter((_, index) => signatures[index] === null);
  if (missing.length > 0) throw new Error(`ABR の町字位置参照（都道府県 ${missing.join(', ')}）が見つかりません`);
  const sig = combineSignatures(signatures);
  const sourceDate = latestSourceDate(signatures);
  if (store.current('index')?.meta.sig === sig) {
    await store.markChecked('index', sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const zips = await mapLimit(urls, INDEX_CONCURRENCY, async (url) => {
      const zip = join(work, `${url.slice(url.lastIndexOf('/') + 1)}`);
      if (!(await downloadToFile(url, zip, http))) throw new Error(`ABR の町字位置参照が見つかりません: ${url}`);
      return zip;
    });
    const points: GeoPoint[] = [];
    for (const zip of zips) {
      await scanZipCsv(zip, 'ABR の町字位置参照', ['lg_code', 'machiaza_id', 'rsdt_addr_flg', 'rep_lon', 'rep_lat', 'rep_srid'], (cols, row) => {
        if (!isSupportedSrid(row[cols[5] as number])) return;
        points.push({
          lgCode: row[cols[0] as number] ?? '', machiazaId: row[cols[1] as number] ?? '', rsdt: row[cols[2] as number] === '1',
          lon: Number.parseFloat(row[cols[3] as number] ?? ''), lat: Number.parseFloat(row[cols[4] as number] ?? ''),
        });
      });
    }
    const out = join(work, 'out');
    mkdirSync(out);
    const count = buildGeoIndex(join(out, 'geo.sqlite'), points);
    if (count < limits(deps).points) throw new Error(`ABR の町字の点が想定より小さい（${count} 点）`);
    await store.publish('index', out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const NUM_FILES = {
  rsdt: 'mt_rsdtdsp_rsdt/city/mt_rsdtdsp_rsdt_city',
  rsdtPos: 'mt_rsdtdsp_rsdt_pos/city/mt_rsdtdsp_rsdt_pos_city',
  parcel: 'mt_parcel/city/mt_parcel_city',
  parcelPos: 'mt_parcel_pos/city/mt_parcel_pos_city',
} as const;

/**
 * 番地・号（段B）。市区町村の住居表示・地番を取得して、町字ごとの節を並べた txt にする。
 * 町字（段A）が無ければ先に作る。住居表示の町が無ければ住居表示を、それ以外の町が無ければ地番を取得しない。
 * 取得元に無い市区町村は、空の ranges.json だけを公開する（毎回調べ直さないため）。
 */
async function buildNum(lgCode: string, deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  if (!/^\d{6}$/.test(lgCode)) throw new Error(`不正な市区町村コード: ${lgCode}`);
  const id = `num:${lgCode}`;
  const cityId = `city:${lgCode}`;
  if (!store.current(cityId)) await buildCity(lgCode, deps);
  const city = store.current(cityId);
  if (!city) throw new Error(`${cityId} を用意できませんでした`);
  const towns = (JSON.parse(readFileSync(join(city.path, 'town.json'), 'utf8')) as TownJson).data;

  const keys = Object.keys(NUM_FILES) as Array<keyof typeof NUM_FILES>;
  const urls = keys.map((key) => `${ABR_BASE}/${NUM_FILES[key]}${lgCode}.csv.zip`);
  const signatures = await Promise.all(urls.map((url) => headSignature(url, http)));
  const sig = signatures.some((signature): signature is Signature => signature !== null) ? combineSignatures(signatures) : 'none';
  const sourceDate = latestSourceDate(signatures);
  if (store.current(id)?.meta.sig === sig) {
    await store.markChecked(id, sourceDate);
    return;
  }
  const wantRsdt = towns.some((town) => town.rsdt);
  const wantParcel = towns.some((town) => !town.rsdt);
  const work = store.makeWorkDir();
  try {
    const files: NumberFiles = {};
    for (const [index, key] of keys.entries()) {
      const wanted = key === 'rsdt' || key === 'rsdtPos' ? wantRsdt : wantParcel;
      if (!wanted || !signatures[index]) continue;
      const zip = join(work, `${key}.zip`);
      if (await downloadToFile(urls[index] as string, zip, http)) files[key] = zip;
    }
    const out = join(work, 'out');
    mkdirSync(out);
    await buildNumbers({ outDir: out, towns, files });
    await store.publish(id, out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 国土交通省の街区レベル位置参照情報（市区町村単位の zip、Shift_JIS）から、町ごとの街区符号の点の索引を作る。
 * 新しい版から順に試して、最初に見つかった版を使う。どの版にも無い市区町村は、空の索引だけを公開する（毎回調べ直さないため）。
 */
async function buildMlit(lgCode: string, deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  if (!/^\d{6}$/.test(lgCode)) throw new Error(`不正な市区町村コード: ${lgCode}`);
  const id = `mlit:${lgCode}`;
  let found: { url: string; version: string; signature: Signature } | null = null;
  for (const version of MLIT_VERSIONS) {
    const url = mlitCityUrl(lgCode, version);
    const signature = await headSignature(url, http);
    if (signature) {
      found = { url, version, signature };
      break;
    }
  }
  const sig = found ? `${found.version}:${combineSignatures([found.signature])}` : 'none';
  const sourceDate = found ? latestSourceDate([found.signature]) : undefined;
  if (store.current(id)?.meta.sig === sig) {
    await store.markChecked(id, sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    let rows: Row[] = [];
    if (found) {
      const zip = join(work, 'mlit.zip');
      if (!(await downloadToFile(found.url, zip, http))) throw new Error(`国土交通省の街区レベル位置参照情報が見つかりません: ${found.url}`);
      rows = parseCsvRows(await readZipText(zip, 'shift_jis', /\.csv$/i));
    }
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'index.json'), JSON.stringify(buildMlitIndex(rows)));
    await store.publish(id, out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function buildPostal(deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  const links = await resolveJapanPostLinks(http);
  const signatures = await Promise.all([headSignature(links.kenAll, http), headSignature(links.jigyosyo, http)]);
  if (signatures.some((signature) => signature === null)) throw new Error('日本郵便の郵便番号データが見つかりません');
  const sig = combineSignatures(signatures);
  const sourceDate = latestSourceDate(signatures);
  if (store.current('postal')?.meta.sig === sig) {
    await store.markChecked('postal', sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const kenZip = join(work, 'ken_all.zip');
    const jigZip = join(work, 'jigyosyo.zip');
    const kenDone = await downloadToFile(links.kenAll, kenZip, http);
    const jigDone = await downloadToFile(links.jigyosyo, jigZip, http);
    if (!kenDone || !jigDone) throw new Error('日本郵便の郵便番号データが見つかりません');
    const general = parseKenAll(await readZipText(kenZip));
    const office = parseJigyosyo(await readZipText(jigZip, 'shift_jis'));
    const min = limits(deps);
    if (general.length < min.general || office.length < min.office) {
      throw new Error(`郵便番号データが想定より小さい（一般 ${general.length}、事業所 ${office.length}）`);
    }
    if (!general.some((row) => row.zip === '1000001')) throw new Error('郵便番号データに 1000001 がありません');
    const out = join(work, 'out');
    mkdirSync(out);
    buildPostalDb(join(out, 'postal.sqlite'), [...general, ...office]);
    await store.publish('postal', out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
