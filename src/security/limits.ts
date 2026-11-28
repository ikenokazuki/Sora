// 増幅の上限と、ブラウザの枠・browser_action の値（設計 6。穴 11・21・23〜26）。水準（SORA_ISOLATION）で、組み込みの 2 組の値を切り替える。個別の環境変数は足さない
// （設定が増えすぎるため）。値の組は、呼ぶたびに水準を読んで選ぶ（起動のあとで環境を変える運用・テストに追従する）。
//
//   standard（既定）: ユーザーが 1 人か、互いに信頼できる少数。今までの使い方を止めない緩い値で、異常な入力（無制限の本文・星だらけのパターンなど）だけを止める
//   strict: 互いに信頼できない利用者に公開する共有のサービス。設計書の値（未決 7）
import { type Env, envEnum, envError, envInt } from '../config.js';

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
  /** ブラウザの枠（browserSemaphore）を待つ要求の数の上限。tenant ごと。超えたら、待たせずに断る（429） */
  browserQueuePerTenant: number;
  /** ブラウザの枠を待つ要求の数の上限。全体（tenant の合計）。超えたら、待たせずに断る（429） */
  browserQueueTotal: number;
  /** ブラウザの枠を待つ時間の上限（ミリ秒）。超えたら断る（429） */
  browserQueueWaitMs: number;
  /** 1 つの tenant が、同時に持てる枠の割合（1〜100 のパーセント。枠の数に掛けて切り捨て、最低 1 枠）。100 は制限なし */
  browserTenantSharePercent: number;
  /** browser_action の actions の件数 */
  browserActionCount: number;
  /** browser_action の wait の ms（セレクタを待つときの待ち時間も）の上限（ミリ秒） */
  browserActionWaitMs: number;
  /** browser_action の delay（click の後の待ち・fill/type の 1 文字ごとの間隔）の上限（ミリ秒） */
  browserActionDelayMs: number;
  /** browser_action の text・script の長さ（文字数） */
  browserActionTextLength: number;
  /** browser_action の timeout（ページ遷移の待ち）の上限（ミリ秒） */
  browserActionTimeoutMs: number;
  /** browser_action 1 回の呼び出しの全体の時間（ミリ秒）。超えたら、残りのアクションは実行しない */
  browserActionTotalMs: number;
  /** browser_action の extract.maxChars（抽出する本文の最大文字数）の上限 */
  browserExtractChars: number;
  /** ブラウザセッションを持てる数。tenant ごと（作成中を含む）。超えたら、その tenant の一番使われていないセッションを閉じて作る */
  browserSessionsPerTenant: number;
  /** ブラウザセッションを持てる数。全体（tenant の合計。作成中を含む）。超えたら、ほかの tenant のセッションは閉じずに、断る（429） */
  browserSessionsTotal: number;
  /** ウォッチ（watch）の登録数の上限。tenant ごと。超える登録は断る（既存の id の更新は数えない） */
  watchTargetsPerTenant: number;
  /** 同じウォッチを確認できる最小の間隔（ミリ秒）。前の確認（登録の初回も、失敗も含む）からこの間隔が過ぎるまで、取得せずに断る（一括の確認は見送る）。0 は制限なし。下限なので、standard が小さい */
  watchMinIntervalMs: number;
  /** ブラウザセッションの最長の時間（ミリ秒）。作成からの時間で、使い続けても延びない。過ぎたら、使っていないときに閉じる */
  browserSessionMaxMs: number;
  /**
   * tenant ごとに別のブラウザのプロセス（と、別の uid）で動かすときの、同時に持てるプロセスの数（設計 2。穴 4・I5）。0 は、全員で 1 つの共有プロセス（今までどおり）。
   * 超えるとき、使っていない（開いているページ・セッション・枠が無い）プロセスのうち、いちばん長く使われていないものを閉じて渡す。閉じられるものが無ければ、断る（429）
   */
  browserProcessMax: number;
  /** tenant ごとのブラウザのプロセスが、すべて使用中のとき、新しい利用者が、空くのを待つ時間の上限（ミリ秒）。0 は、待たずに断る。超えたら断る（429） */
  browserProcessWaitMs: number;
  /** tenant ごとのブラウザのプロセスを、使われなくなってから閉じるまでの時間（ミリ秒）。環境変数 SORA_BROWSER_IDLE_TTL_MS が、これより小さければそちら（0 は、閉じない） */
  browserProcessIdleMs: number;
  /** DB のキャッシュ（cache_entries）の行数の上限。超えたら、期限の近い（期限切れが先の）行から消す */
  cacheDbMaxRows: number;
  /** DB のキャッシュの容量（JSON の UTF-8 のバイト数の合計）の上限。超えたら、期限の近い行から消す。1 件がこれより大きいときは、その 1 件を入れない */
  cacheDbMaxBytes: number;
  /** メモリのキャッシュの容量（JSON の UTF-8 のバイト数の合計）の上限。超えたら、古い（長く使われていない）エントリから外す。DB の行は消さない */
  cacheMemoryMaxBytes: number;
  /** 保存した Cookie・localStorage（domain_cookies_v2・domain_storage_v2）の 1 行の大きさ（JSON の UTF-8 のバイト数）の上限。超える保存はしない（同じ場所の前の保存も消す） */
  savedStateMaxBytes: number;
  /** 保存した Cookie・localStorage の行数の上限。tenant ごと、表ごと（場所 scope が違えば別の行）。超えたら、保存した時刻の古い行から消す */
  savedStateRowsPerTenant: number;
  /** 保存した Cookie・localStorage を持つ期間（ミリ秒）。最後に保存してからこれを過ぎた行は、読まず、定期の掃除で消す */
  savedStateMaxAgeMs: number;
  /** ホスト名で引く Map（throttleDomain の覚え・DNS の検証結果の覚え）の件数の上限。それぞれの Map ごと。超えたら、役目を終えた項目を先に、次に入れた順に古い方から外す */
  hostMapMaxEntries: number;
  /** ウォッチの履歴（watch_history）の件数の上限。対象ごと。超えたら、書いた時刻の古い行から消す（いま足した行は消さない） */
  watchHistoryPerTarget: number;
  /** 地名の検索（Nominatim。geocoding.ts）の順番を待つ要求の数の上限。tenant ごと。超えたら、待たせずに断る（429） */
  geocodeQueuePerTenant: number;
  /** 地名の検索の順番を待つ要求の数の上限。全体（tenant の合計）。超えたら、待たせずに断る（429） */
  geocodeQueueTotal: number;
  /** 地名の検索の順番を待つ時間の上限（ミリ秒）。超えたら断る（429） */
  geocodeQueueWaitMs: number;
  /** 地名の検索で、1 人の利用者が 1 分に Nominatim へ出せる回数。キャッシュ・ローカルで解決した分は数えない。超えたら断る（429）。0 は制限なし */
  geocodeBudgetPerMinute: number;
  /** Yahoo（同梱バイナリ・動画の直取得。yahoo.ts）の順番を待つ要求の数の上限。tenant ごと。超えたら、待たせずに断る（429） */
  yahooQueuePerTenant: number;
  /** Yahoo の順番を待つ要求の数の上限。全体（tenant の合計）。超えたら、待たせずに断る（429） */
  yahooQueueTotal: number;
  /** Yahoo の順番を待つ時間の上限（ミリ秒）。超えたら断る（429） */
  yahooQueueWaitMs: number;
  /** 1 人の利用者が 1 分に Yahoo へ出せる問い合わせの回数（同梱バイナリ・Web 検索の直取得・動画の直取得。キャッシュは数えない）。超えたら断る（429）。0 は制限なし */
  yahooBudgetPerMinute: number;
  /** 国の情報の提供元（country_intel/provider_http.ts）への取得の順番を待つ要求の数の上限。tenant ごと。超えたら、待たせずに断る（その提供元は rate_limited / PROVIDER_BUSY）。1 回の報告は、取得を約 20 件（SNS ありで 24 件）、ほぼ同時に出すので、1 回分が通る大きさにする */
  countryIntelQueuePerTenant: number;
  /** 国の情報の提供元への取得の順番を待つ要求の数の上限。全体（tenant の合計）。超えたら、待たせずに断る */
  countryIntelQueueTotal: number;
  /** 国の情報の提供元への取得の順番を待つ時間の上限（ミリ秒）。超えたら断る。提供元ごとの時間切れ（8〜18 秒）が先に来れば、そちらで中止される */
  countryIntelQueueWaitMs: number;
  /** 1 人の利用者が 1 分に国の情報の提供元へ出せる取得の回数（キャッシュは数えない。再試行も 1 回と数える）。超えたら断る。0 は制限なし */
  countryIntelBudgetPerMinute: number;
  /** 住所データの構築（address_data.ts）の順番を待つ構築の数の上限。tenant ごと（その tenant が新しく頼んだ構築。実行中は数えない）。超えたら、待たせずに断る（429）。1 回の問い合わせが頼む構築は、最大で 15 件（逆ジオコーディング。全国の 3 件と、最大 4 市区町村 × 町字・番地・街区の 3 種） */
  addressQueuePerTenant: number;
  /** 住所データの構築の順番を待つ構築の数の上限。全体（tenant の合計。システムの事前取得は数えない）。超えたら、待たせずに断る（429） */
  addressQueueTotal: number;
  /** 1 人の利用者が 1 分に頼める、新しい構築の回数（構築を始める回。同じ ID の 2 回目・できあがっている成果物は数えない）。超えたら断る（429）。0 は制限なし */
  addressBudgetPerMinute: number;
  /** PDF から 1 回に読むページ数の上限（先頭から。超えたぶんは読まず、結果に isTruncated と metadata.pagesRead を付ける）。読んだ文字が必要な量（ハイライトの元の 20 万字）に達したら、これより前に止める */
  pdfMaxPages: number;
  /** PDF の 1 回の解析に使う時間の上限（ミリ秒）。ページごとに調べ、超えたら、読んだページまでで止める（結果に isTruncated と警告）。1 ページが重い PDF（ページ数 × 重さ）が、枠を握り続けないため */
  pdfMaxParseMs: number;
  /** PDF の解析の別プロセスの、メモリ（RSS）の上限（MB）。超えたら、そのプロセスだけを止める（読めたページまでを返す。1 ページも読めなければ失敗）。Flate で膨らむ PDF などが、本体ごと落とすのを防ぐ。実在の論文（最大 11MB）で 94〜154MB */
  pdfMaxChildMemoryMb: number;
  /** PDF の解析（同時 2 件。全員で共有）の順番を待つ解析の数の上限。tenant ごと。超えたら、待たせずに断る（429） */
  pdfQueuePerTenant: number;
  /** PDF の解析の順番を待つ解析の数の上限。全体（tenant の合計）。超えたら、待たせずに断る（429） */
  pdfQueueTotal: number;
  /** PDF の解析の順番を待つ時間の上限（ミリ秒）。超えたら断る（429） */
  pdfQueueWaitMs: number;
  /** 1 つの tenant が、同時に持てる PDF の解析の枠の割合（1〜100 のパーセント。枠の数 2 に掛けて切り捨て、最低 1 枠）。100 は制限なし。重い PDF や、本文が遅い PDF を並べても、ほかの tenant が使える枠を残す */
  pdfTenantSharePercent: number;
  /** 取得したページの HTML の変換を、別プロセスで動かすときの、1 件の時間の上限（ミリ秒）。超えたら、その変換のプロセスだけを止めて失敗にする（408）。strict はすべてのページ、standard は要素の多いページだけを別プロセスで変換する（html_convert.ts） */
  convertMaxMs: number;
  /** 変換の別プロセスの順番を待つ変換の数の上限。tenant ごと。超えたら、待たせずに断る（429） */
  convertQueuePerTenant: number;
  /** 変換の別プロセスの順番を待つ変換の数の上限。全体（tenant の合計）。超えたら、待たせずに断る（429） */
  convertQueueTotal: number;
  /** 変換の別プロセスの順番を待つ時間の上限（ミリ秒）。超えたら断る（429） */
  convertQueueWaitMs: number;
  /** 1 つの tenant が、同時に持てる変換の枠の割合（1〜100 のパーセント。枠の数〔機械のメモリから 1 か 2〕に掛けて切り捨て、最低 1 枠）。100 は制限なし */
  convertTenantSharePercent: number;
  /**
   * 出口のゲートウェイ（SORA_EGRESS_GATEWAY）で、1 人の利用者が同時に持てる接続の、全体（2,048 本）に対する割合（1〜100 のパーセント）。超えたら、その利用者の新しい接続だけを断る。
   * 本体の取得とブラウザのプロセスの接続を、合わせて数える（net/egress.ts）。100 は制限なし。接続は、閉じるまで、その利用者の数に入る
   */
  egressTenantSharePercent: number;
  /**
   * MCP のセッションのうち、1 人の利用者が持てる数の、全体（SORA_MCP_MAX_SESSIONS。既定 100）に対する割合（1〜100 のパーセント。掛けて切り捨て、最低 1）。
   * 超える initialize は、その利用者の、最も長く使われていないセッションを閉じて受け入れる（ほかの利用者のセッションは閉じない）。100 は制限なし
   */
  mcpSessionTenantSharePercent: number;
  /**
   * 読み込み中の本文の量のうち、1 人の利用者の分の上限（MB。net/body_budget.ts）。超える読み込みは、その読み込みだけを止めて断る（429）。0 は制限なし。
   * 全体の上限は、水準によらず、機械のメモリの 25%（256MB〜1GB）
   */
  bodyBytesPerTenantMb: number;
  /** 音声・動画のファイルの長さの上限（秒）。デコードの前に、ファイルの先頭の情報で調べて、超えるものはデコードせずに断る（デコードは全体を PCM にするので、長いとメモリを使い切る） */
  audioMaxDurationSec: number;
  /** 利用者が送る文字列の欄（検索語・名前など。下の 2 つ以外のすべて。欄の名前も）の長さの上限（字）。超えたら処理の前に断る（400）。長い入力は、全員の要求を処理するメインスレッドを、二乗の時間の処理で止められる（security/input_limits.ts） */
  inputTextChars: number;
  /** 長い文章の欄（description・productDescription・text・script・headers・cookies と、その中の値）の長さの上限（字） */
  inputLongTextChars: number;
  /** URL の欄（url・urls・webhookUrl）の長さの上限（字） */
  inputUrlChars: number;
  /** 1 回の要求の文字列（欄の名前を含む）の合計の上限（字）。短い欄を大量に並べる入力を止める */
  inputTotalChars: number;
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
  browserQueuePerTenant: 100,
  browserQueueTotal: 500,
  browserQueueWaitMs: 600_000,
  browserTenantSharePercent: 100,
  browserActionCount: 100,
  browserActionWaitMs: 120_000,
  browserActionDelayMs: 10_000,
  browserActionTextLength: 100_000,
  browserActionTimeoutMs: 180_000,
  browserActionTotalMs: 600_000,
  browserExtractChars: 1_000_000,
  browserSessionsPerTenant: 20,
  browserSessionsTotal: 20,
  browserSessionMaxMs: 86_400_000,
  browserProcessMax: 0,
  browserProcessWaitMs: 0,
  browserProcessIdleMs: 300_000,
  watchTargetsPerTenant: 1000,
  watchMinIntervalMs: 0,
  cacheDbMaxRows: 20_000,
  cacheDbMaxBytes: 512 * MB,
  cacheMemoryMaxBytes: 256 * MB,
  savedStateMaxBytes: 256 * 1024,
  savedStateRowsPerTenant: 5000,
  savedStateMaxAgeMs: 90 * 86_400_000,
  hostMapMaxEntries: 10_000,
  watchHistoryPerTarget: 1000,
  geocodeQueuePerTenant: 100,
  geocodeQueueTotal: 300,
  geocodeQueueWaitMs: 120_000,
  geocodeBudgetPerMinute: 0,
  yahooQueuePerTenant: 100,
  yahooQueueTotal: 300,
  yahooQueueWaitMs: 120_000,
  yahooBudgetPerMinute: 0,
  countryIntelQueuePerTenant: 100,
  countryIntelQueueTotal: 300,
  countryIntelQueueWaitMs: 30_000,
  countryIntelBudgetPerMinute: 0,
  addressQueuePerTenant: 100,
  addressQueueTotal: 300,
  addressBudgetPerMinute: 0,
  pdfMaxPages: 1000,
  pdfMaxParseMs: 60_000,
  pdfMaxChildMemoryMb: 1536,
  pdfQueuePerTenant: 50,
  pdfQueueTotal: 200,
  pdfQueueWaitMs: 60_000,
  pdfTenantSharePercent: 100,
  convertMaxMs: 60_000,
  convertQueuePerTenant: 100,
  convertQueueTotal: 400,
  convertQueueWaitMs: 120_000,
  convertTenantSharePercent: 100,
  egressTenantSharePercent: 100,
  mcpSessionTenantSharePercent: 100,
  bodyBytesPerTenantMb: 0,
  audioMaxDurationSec: 3600,
  inputTextChars: 10_000,
  inputLongTextChars: 100_000, // browser_action の text・script の上限（standard）と同じ
  inputUrlChars: 32_768,
  inputTotalChars: 5_000_000,
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
  browserQueuePerTenant: 10,
  browserQueueTotal: 100,
  browserQueueWaitMs: 60_000,
  browserTenantSharePercent: 50,
  browserActionCount: 20,
  browserActionWaitMs: 15_000,
  browserActionDelayMs: 2_000,
  browserActionTextLength: 10_000,
  browserActionTimeoutMs: 60_000,
  browserActionTotalMs: 120_000,
  browserExtractChars: 100_000,
  browserSessionsPerTenant: 5,
  browserSessionsTotal: 20,
  browserSessionMaxMs: 3_600_000,
  browserProcessMax: 4,
  browserProcessWaitMs: 5_000,
  browserProcessIdleMs: 60_000,
  watchTargetsPerTenant: 50,
  watchMinIntervalMs: 900_000,
  cacheDbMaxRows: 5_000,
  cacheDbMaxBytes: 128 * MB,
  cacheMemoryMaxBytes: 64 * MB,
  savedStateMaxBytes: 128 * 1024,
  savedStateRowsPerTenant: 100,
  savedStateMaxAgeMs: 14 * 86_400_000,
  hostMapMaxEntries: 2000,
  watchHistoryPerTarget: 100,
  geocodeQueuePerTenant: 5,
  geocodeQueueTotal: 30,
  geocodeQueueWaitMs: 20_000,
  geocodeBudgetPerMinute: 20,
  yahooQueuePerTenant: 5,
  yahooQueueTotal: 30,
  yahooQueueWaitMs: 20_000,
  yahooBudgetPerMinute: 60,
  countryIntelQueuePerTenant: 30,
  countryIntelQueueTotal: 120,
  countryIntelQueueWaitMs: 10_000,
  countryIntelBudgetPerMinute: 120,
  addressQueuePerTenant: 30,
  addressQueueTotal: 120,
  addressBudgetPerMinute: 60,
  pdfMaxPages: 200,
  pdfMaxParseMs: 15_000,
  pdfMaxChildMemoryMb: 768,
  pdfQueuePerTenant: 20,
  pdfQueueTotal: 80,
  pdfQueueWaitMs: 30_000,
  pdfTenantSharePercent: 50,
  convertMaxMs: 30_000,
  convertQueuePerTenant: 30,
  convertQueueTotal: 100,
  convertQueueWaitMs: 60_000,
  convertTenantSharePercent: 50,
  egressTenantSharePercent: 25,
  mcpSessionTenantSharePercent: 10,
  bodyBytesPerTenantMb: 64,
  audioMaxDurationSec: 900,
  inputTextChars: 4_000,
  inputLongTextChars: 20_000,
  inputUrlChars: 8_192,
  inputTotalChars: 500_000,
});

/**
 * 起動の検査（checkEnv）を通らない経路（組み込み・テスト）でも、不正な値（strcit などの打ち間違い）を、黙って緩い側の standard にしない
 * （安全側を選ぶ切り替えなので、打ち間違いが、上限を緩めてはいけない）。登録簿と同じ文（変数名と正しい形）で、エラーにする
 * （src/net/egress.ts の rejectInvalid と同じ）。未設定・空は standard
 */
export function isolationLevel(env?: Env): IsolationLevel {
  const problem = envError('SORA_ISOLATION', env);
  if (problem) throw new Error(problem);
  return envEnum('SORA_ISOLATION', env);
}

/**
 * strict での、同時に持てるブラウザのプロセスの数。SORA_BROWSER_MAX_PROCESSES があればそれ(1〜64)、なければ表の値(4)。
 * 読めない値は、表の値のまま(起動の検査 checkEnv が、誤りとして止める)。水準によらず返す(起動の検査が、uid の範囲を調べるのに使う)
 */
export function strictBrowserProcessMax(env?: Env): number {
  return envInt('SORA_BROWSER_MAX_PROCESSES', env) ?? STRICT_LIMITS.browserProcessMax;
}

/** プロセスの数を替えた strict の値。同じ数なら同じ物を返す(呼ぶたびに作らない) */
const strictWithProcessMax = new Map<number, Readonly<Limits>>();

export function limits(env?: Env): Readonly<Limits> {
  if (isolationLevel(env) !== 'strict') return STANDARD_LIMITS;
  const processMax = strictBrowserProcessMax(env);
  if (processMax === STRICT_LIMITS.browserProcessMax) return STRICT_LIMITS;
  let derived = strictWithProcessMax.get(processMax);
  if (!derived) {
    derived = Object.freeze({ ...STRICT_LIMITS, browserProcessMax: processMax });
    strictWithProcessMax.set(processMax, derived);
  }
  return derived;
}
