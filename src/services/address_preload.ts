import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddressConfig } from './address_config.js';
import type { AddressData } from './address_data.js';
import { AddressUnavailableError } from './address_errors.js';
import { jobArtifactId, type BuildJob } from './address_store.js';

const DAY = 86_400_000;
const MB = 1024 * 1024;

/** 1 市区町村の成果物の大きさの上限の目安（実測の最大は長崎市の約 13MB）。これだけ空きが無ければ、次の市区町村を始めない。 */
const HEADROOM_BYTES = 16 * MB;
/** この期間内に署名を確認した成果物は、起動のたびには確認しない（確認は 1 日に 1 回まで）。 */
const FRESH_MS = DAY;
/** 続けて失敗したらやめる回数。 */
const MAX_FAILURES = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
const LOG_EVERY = 10;
/** 起動直後の通信や初期化と重ならないよう、始めるまで待つ。 */
const START_DELAY_MS = 10_000;

/** 全国の小さい成果物。マスターが無いと市区町村の一覧が分からない。 */
const NATIONAL_JOBS: readonly BuildJob[] = [{ kind: 'master' }, { kind: 'postal' }, { kind: 'index' }];

/** 事前取得の進み具合。保存先の preload.json に書く。 */
export interface PreloadState {
  /** 指定（SORA_ADDRESS_PRELOAD）。 */
  target: string[] | 'all';
  state: 'running' | 'done' | 'stopped';
  /** stopped の理由。budget は予算の不足、blocked は国外 IP の拒否、errors は失敗の連続。 */
  reason?: 'budget' | 'blocked' | 'errors';
  message?: string;
  /** 対象の市区町村の数と、取得を終えた数、失敗した構築の数。 */
  total: number;
  done: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
}

export interface PreloadOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** 次の市区町村を始めるのに必要な予算の空き（バイト）。既定は 16MB。 */
  headroomBytes?: number;
  /** 続けて失敗したらやめる回数。既定は 5。 */
  maxFailures?: number;
}

function writeState(dir: string, state: PreloadState): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'preload.json');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 指定した都道府県（または全国）の市区町村を、使われる前に順に取得して残す。1 件ずつ、構築用の子プロセス（低優先度）で行い、
 * 利用者の要求は同じ待ち行列で割り込める。取得できた成果物には印（pinned）を付け、予算を超えても破棄しない。
 * 止まっても、次の起動で続きから進む（確認が新しい成果物は取り直さない）。進み具合は保存先の preload.json に残す。
 */
export async function runPreload(data: AddressData, options: PreloadOptions = {}): Promise<PreloadState | null> {
  const target = data.config.preload;
  if (!data.enabled || !target) return null;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message: string) => console.log(`[Sora/Address] ${message}`));
  const headroom = options.headroomBytes ?? HEADROOM_BYTES;
  const maxFailures = options.maxFailures ?? MAX_FAILURES;

  const state: PreloadState = { target, state: 'running', total: 0, done: 0, failed: 0, startedAt: now(), updatedAt: now() };
  const save = (): void => {
    state.updatedAt = now();
    try {
      writeState(data.store.dir, state);
    } catch (error) {
      log(`preload の状態を書けません: ${errorText(error)}`);
    }
  };
  const halt = (reason: NonNullable<PreloadState['reason']>, message: string): PreloadState => {
    state.state = 'stopped';
    state.reason = reason;
    state.message = message;
    save();
    log(`事前取得を止めました（${reason}）: ${message}`);
    return state;
  };

  const fresh = (id: string, pinned: boolean): boolean => {
    const meta = data.peek(id)?.meta;
    return meta !== undefined && (!pinned || meta.pinned === true) && now() - meta.checkedAt <= FRESH_MS;
  };
  const used = (): number => Object.values(data.status().artifacts).reduce((sum, meta) => sum + meta.bytes, 0);
  const hasRoom = async (): Promise<boolean> => {
    const limit = data.config.maxBytes - headroom;
    if (used() <= limit) return true;
    await data.evictTo(limit);
    return used() <= limit;
  };

  let consecutive = 0;
  let halted: PreloadState | null = null;
  /** 構築を頼んで終わりを待つ。失敗は数えて間隔を延ばしながら続け、続けられなければ止める。 */
  const build = async (job: BuildJob): Promise<boolean> => {
    try {
      await data.request(job);
      consecutive = 0;
      return true;
    } catch (error) {
      const message = errorText(error);
      state.failed += 1;
      consecutive += 1;
      if (error instanceof AddressUnavailableError && error.blocked) {
        halted = halt('blocked', message);
      } else if (consecutive >= maxFailures) {
        halted = halt('errors', message);
      } else {
        log(`${jobArtifactId(job)} を取得できませんでした（${message}）。次へ進みます`);
        await sleep(Math.min(BASE_BACKOFF_MS * 2 ** (consecutive - 1), MAX_BACKOFF_MS));
      }
      return false;
    }
  };

  save();
  log(`事前取得を始めます（${target === 'all' ? '全国' : `都道府県 ${target.join(', ')}`}）`);
  try {
    for (const job of NATIONAL_JOBS) {
      if (fresh(jobArtifactId(job), false)) continue;
      await build(job);
      if (halted) return halted;
    }
    const master = await data.master();
    const lgCodes = [...master.byLgCode.keys()].filter((lgCode) => target === 'all' || target.includes(lgCode.slice(0, 2))).sort();
    state.total = lgCodes.length;
    save();

    for (const lgCode of lgCodes) {
      const cityId = `city:${lgCode}`;
      const numId = `num:${lgCode}`;
      const mlitId = `mlit:${lgCode}`;
      if (!(fresh(cityId, true) && fresh(numId, true) && fresh(mlitId, true))) {
        if (!(await hasRoom())) {
          return halt('budget', `予算 ${Math.round(data.config.maxBytes / MB)}MB に空きがありません（使用中 ${Math.round(used() / MB)}MB）。SORA_ADDRESS_MAX_MB を増やして再起動すると、続きから取得します`);
        }
        // 町字（段A）、番地・号（段B）、街区レベル位置参照（国土交通省）を別々に頼み、できたそばから印を付ける（段B の構築後の破棄で段A が消えないように）。
        let ok = true;
        for (const job of [{ kind: 'city', lgCode }, { kind: 'num', lgCode }, { kind: 'mlit', lgCode }] as const) {
          const id = jobArtifactId(job);
          if (!ok || fresh(id, true)) continue;
          ok = await build(job);
          if (halted) return halted;
          if (ok) await data.store.pin([id]);
        }
        if (!ok) continue;
      }
      state.done += 1;
      save();
      if (state.done % LOG_EVERY === 0) log(`事前取得 ${state.done}/${state.total} 市区町村`);
    }
    state.state = 'done';
    save();
    log(`事前取得を終えました（${state.done}/${state.total} 市区町村、失敗 ${state.failed} 件）`);
    return state;
  } catch (error) {
    return halt('errors', errorText(error));
  }
}

/**
 * サーバの起動時に呼ぶ。SORA_ADDRESS_PRELOAD の指定があり、住所機能が off でなければ、少し待ってから裏で事前取得を始める予約をする。
 * 指定が無ければ何も読み込まず、予約もしない（null）。
 */
export function startAddressPreload(
  env: Record<string, string | undefined> = process.env,
  options: { delayMs?: number } = {},
): ReturnType<typeof setTimeout> | null {
  const config = loadAddressConfig(env);
  if (config.mode === 'off' || !config.preload) return null;
  const timer = setTimeout(() => {
    void (async () => {
      const { getAddressContext } = await import('./address_context.js');
      await runPreload(getAddressContext().data);
    })().catch((error) => console.warn(`[Sora/Address] preload failed: ${errorText(error)}`));
  }, options.delayMs ?? START_DELAY_MS);
  timer.unref();
  return timer;
}
