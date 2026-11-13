// 増幅の上限の値（設計 6。穴 11・21・23・24・26）。水準（SORA_ISOLATION）で、組み込みの 2 組の値を切り替える。個別の環境変数は足さない
// （設定が増えすぎるため）。値の組は、呼ぶたびに水準を読んで選ぶ（起動のあとで環境を変える運用・テストに追従する）。
//
//   standard（既定）: ユーザーが 1 人か、互いに信頼できる少数。今までの使い方を止めない緩い値で、異常な入力（無制限の本文・星だらけのパターンなど）だけを止める
//   strict: 互いに信頼できない利用者に公開する共有のサービス。設計書の値（未決 7）
import { envEnum, envError } from '../config.js';

export type IsolationLevel = 'standard' | 'strict';

export interface Limits {
  /** robots.txt の `Sitemap:` 行のうち、取る数（先頭から） */
  sitemapRobotsLines: number;
  /** サイトマップの索引の子のうち、取る数（先頭から） */
  sitemapChildren: number;
  /** 1 回の map_site で取るサイトマップの数（robots.txt の行・索引の子・入れ子の全部） */
  sitemapFetches: number;
  /** サイトマップ 1 本の本文の大きさ（バイト）。超えたら、そのサイトマップは読めなかったことにする */
  sitemapBytes: number;
  /** 1 回の map_site の全体の時間（ミリ秒）。超えたら、サイトマップを取るのをやめる */
  mapDeadlineMs: number;
  /** crawl の includePatterns・excludePatterns の、それぞれの個数 */
  patternCount: number;
  /** crawl のパターン 1 つの長さ（文字数） */
  patternLength: number;
  /** crawl 1 回で、パターンの照合に使える仕事の量（url_glob.ts の steps）。超えたら、新しいリンクをたどらない */
  patternSteps: number;
  /** scrape の selectors・removeSelectors の、それぞれの個数 */
  selectorCount: number;
  /** セレクタ 1 つの長さ（文字数） */
  selectorLength: number;
}

const MB = 1024 * 1024;

export const STANDARD_LIMITS: Readonly<Limits> = Object.freeze({
  sitemapRobotsLines: 50,
  sitemapChildren: 500,
  sitemapFetches: 1000,
  sitemapBytes: 50 * MB, // サイトマップの規格の上限（展開後 50MB）
  mapDeadlineMs: 120_000,
  patternCount: 100,
  patternLength: 1000,
  patternSteps: 200_000_000,
  selectorCount: 100,
  selectorLength: 2000,
});

export const STRICT_LIMITS: Readonly<Limits> = Object.freeze({
  sitemapRobotsLines: 5,
  sitemapChildren: 20,
  sitemapFetches: 50,
  sitemapBytes: 10 * MB,
  mapDeadlineMs: 30_000,
  patternCount: 20,
  patternLength: 200,
  patternSteps: 20_000_000,
  selectorCount: 20,
  selectorLength: 500,
});

/**
 * 起動の検査（checkEnv）を通らない経路（組み込み・テスト）でも、不正な値（strcit などの打ち間違い）を、黙って緩い側の standard にしない
 * （安全側を選ぶ切り替えなので、打ち間違いが、上限を緩めてはいけない）。登録簿と同じ文（変数名と正しい形）で、エラーにする
 * （src/net/egress.ts の rejectInvalid と同じ）。未設定・空は standard
 */
export function isolationLevel(env?: Parameters<typeof envEnum>[1]): IsolationLevel {
  const problem = envError('SORA_ISOLATION', env);
  if (problem) throw new Error(problem);
  return envEnum('SORA_ISOLATION', env);
}

export function limits(env?: Parameters<typeof envEnum>[1]): Readonly<Limits> {
  return isolationLevel(env) === 'strict' ? STRICT_LIMITS : STANDARD_LIMITS;
}
