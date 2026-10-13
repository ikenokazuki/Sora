import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJaJson, buildTownJson, type Row } from './address_abr.js';
import { parseCsvRows, readZipText } from './address_csv.js';
import {
  ABR_BASE, combineSignatures, downloadToFile, headSignature, latestSourceDate, resolveJapanPostLinks, type HttpDeps,
} from './address_http.js';
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
}
export const DEFAULT_MINIMUM: JobMinimum = { prefs: 47, cities: 1500, towns: 1, general: 100_000, office: 15_000 };

export interface JobDeps {
  store: AddressStore;
  http?: HttpDeps;
  minimum?: Partial<JobMinimum>;
  nowSeconds?: () => number;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const seconds = (deps: JobDeps): number => (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
const limits = (deps: JobDeps): JobMinimum => ({ ...DEFAULT_MINIMUM, ...deps.minimum });

/** 1 つの構築ジョブを同じプロセスの中で実行する。子プロセスの入口とテストから呼ぶ。 */
export async function runBuildJob(job: BuildJob, deps: JobDeps): Promise<void> {
  try {
    if (job.kind === 'master') await buildMaster(deps);
    else if (job.kind === 'postal') await buildPostal(deps);
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
