# 住所エンジン（取得の管理・正規化・郵便番号検索）実装計画

> **実行方法:** superpowers:executing-plans でインライン実行する。各タスクは「失敗するテストを書く → 失敗を確認 → 最小の実装 → 成功を確認 → `bun run typecheck && bun run lint` → コミット」の順に進める。

**目的:** 構築層（`address_store` / `address_jobs` / `postal_code`）の上に、使われたときだけデータを取得する管理役（`AddressData`）、Geolonia ライブラリによる正規化（`AddressNormalizer`）、郵便番号の順引き・逆引き、突き合わせの一部（郵便番号 × 住所、住所 × 住所）を載せる。MCP / REST への登録は、`reverse_geocode` を含む 3 ツールがそろう次の計画（登録と統合）でまとめて行う。この計画は、登録なしで関数として呼べて、実データで動くところまで。

**親の設計:** `docs/superpowers/specs/2026-10-13-address-data-design.md`（承認済み）。この計画で変える点は「設計との差分」に書く。

## 設計との差分

- **ツールの登録は後ろへ回す。** 3 ツール（`search_postal_code`、`normalize_address`、`reverse_geocode`）の登録、ツール数の更新（47 → 50）、README・OpenAPI の更新は、全部そろってから 1 回で行う。途中でツール数が 47 → 49 → 50 と動くのを避けるため。
- **ライブラリには「完成した市区町村」だけを見せる。** ライブラリは町の一覧を永久にメモリへ置くので、段A だけの `town.json` を見せたあとで段B が公開されると古い内容が残る。段B（次の計画）では、段B が完了するまでライブラリには市区町村の中身を見せず、取れている範囲（市区町村まで）で答える。この計画の時点では段A だけなので、段A の公開をもって「完成」とする。
- **ライブラリの作り直しは `require.cache` から消して import し直す。** 設計書の `?gen=` つきの import は、Bun 1.3.3 では同じインスタンスのままで効かない（`bun test` でも通常実行でも確認）。`delete require.cache[path]` のあとの import は別のインスタンスになり、20,000 町の市区町村を読み込ませた世代を 30 回作り直しても、ヒープは 9.4MB で一定、RSS は約 160MB で頭打ちだった（古いインスタンスは回収される）。作り直しの条件は、配った版が更新・破棄されたときと 24 時間ごとの 2 つだけ。
- **`search_postal_code` の `noCache` は持たない。** 結果がローカルデータからの計算で、キャッシュする意味がないため。
- **`ADDRESS_DATA_UNAVAILABLE` の HTTP ステータスは 502。** `formatError` が 503 を扱えないため（設計書の 503 を直す。タスク 7）。
- **突き合わせの結果に `same-prefecture` を足す。** 都道府県だけ一致する場合を `different` にまとめると情報が落ちるため。

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/services/address_errors.ts`（変更） | `AddressUnavailableError` に `artifact` を足す。 |
| `src/services/address_data.ts`（新規） | 管理役 `AddressData`。待ち行列、同一 ID の重複排除、同時実行数、失敗後の冷却、古いデータの裏での再確認、予算超過時の破棄、状態の読み取り、全国マスター・町字・郵便番号の読み込み、`datasetInfo`。`ChildProcessBuilder` と `resolveBuildEntry`、シングルトンの取得。 |
| `src/services/address_build_main.ts`（新規） | 子プロセスの入口。`runChild` を export し、直接実行されたときだけ優先度を下げて走る。アプリ本体を読み込まない。 |
| `src/services/address_normalize.ts`（新規） | `AddressNormalizer`。仮想ファイル、世代の作り直し、待ち時間の打ち切りと部分的な答え、郵便番号の分離、結果の整形。 |
| `src/services/address_postal.ts`（新規） | 郵便番号の順引き（座標つき）と、正規化した住所からの逆引き。町字との結びつけのキャッシュ。通り名による絞り込み。 |
| `src/services/address_checks.ts`（新規） | 突き合わせ（`zipcode`、`compare`）の純粋な関数。 |
| `src/services/address_tools.ts`（新規） | ツールの本体 `searchPostalCode` / `normalizeAddressTool`（入力検証、出力の整形、`dataset`、`attribution`）。 |
| `src/services/address_context.ts`（新規） | `AddressContext`（`AddressData` と `AddressNormalizer`）のシングルトンと、テスト用の差し替え。 |
| `src/test_fixtures/address/builders.ts`（新規） | テスト用の構築役 `InProcessBuilder`（偽の取得元に対して `runBuildJob` を直接呼ぶ）と `GatedBuilder`（完了を手で制御）、`createTestAddressData`。 |
| `Containerfile`（変更） | 子の入口を別にビルドして同梱する。 |

テストは通信なし（固定データと偽の fetch）。`NODE_ENV=test SORA_DB_PATH=:memory:`、プロキシ変数は unset。

---

## タスク 1: 管理役 `AddressData`（待ち行列・重複排除・冷却・再確認・破棄）

**ファイル:** `src/services/address_errors.ts`（変更）、`src/services/address_data.ts`（新規）、`src/services/address_data.test.ts`（新規）、`src/test_fixtures/address/builders.ts`（新規）

**インターフェース（このタスクが作る）:**

```ts
export interface AddressBuilder { run(job: BuildJob): Promise<void> }
export interface ReadyArtifact { id: string; ver: string; path: string; meta: ArtifactMeta }
export interface DatasetInfo { updatedAt: string | null; stale: boolean; error?: string }
export interface AddressDataOptions {
  config: AddressConfig;
  builder: AddressBuilder;
  store?: AddressStore;          // 省略時は new AddressStore(config.dir, now)
  now?: () => number;
  cooldownMs?: number;           // 既定 60_000。失敗のたびに 2 倍、上限 1 時間
  blockedCooldownMs?: number;    // 既定 600_000（403）
  log?: (message: string) => void;
}
class AddressData {
  readonly store: AddressStore;
  get config(): AddressConfig;
  get enabled(): boolean;                                    // mode !== 'off'
  status(): AddressStatus;                                   // status.json のスナップショット（inode・サイズ・mtime で更新を検知）
  peek(id: string): ReadyArtifact | null;                    // 待たない。構築も頼まない
  request(job: BuildJob): Promise<void>;                     // 構築を頼む（同じ ID は 1 回にまとめる）。待ちたいなら ensure
  ensure(job: BuildJob, waitMs?: number): Promise<ReadyArtifact>;
  datasetInfo(ids: readonly string[]): DatasetInfo;
}
```

- `ensure`: 無効なら `AddressDisabledError`。成果物があれば `touch` して即返す（期限切れなら裏で再確認を頼む）。無ければ、直近に失敗していれば `AddressUnavailableError(message, blocked, id)` を即座に投げ、そうでなければ構築を頼んで `waitMs`（既定 `config.waitMs`）まで待つ。時間切れは `AddressPendingError(id)`（構築は続く）。構築が失敗したら `AddressUnavailableError`。
- 構築の完了後に `store.evict(config.maxBytes, protect)` を呼ぶ。`protect` は直前に作った ID と、実行中・待機中の ID。
- 冷却は失敗した ID ごとにメモリで持つ。再確認（裏の `request`）も冷却中は頼まない。
- 失敗した裏の再確認は `log('[Sora/Address] …')` に 1 行出すだけで、例外にしない（未処理の rejection にしない）。
- `datasetInfo`: `updatedAt` は渡した ID の `sourceDate` の最大。`stale` は `now - checkedAt > 2 × ttlFor(id)` が 1 つでもあること。`error` は最初に見つかった `meta.error`。

**失敗するテスト（`address_data.test.ts`）:**

1. 同じ市区町村への同時の `ensure` 3 つが、構築 1 回で全部成功する（`builder.runs` が 1、偽の取得元への GET が 1）。
2. 成果物がすでにあれば、構築役を呼ばずに返す。
3. `waitMs: 20` で構築が終わらなければ `AddressPendingError`。完了を放すと、あとで `peek` が成果物を返す。
4. 構築の失敗は `AddressUnavailableError`（`blocked` と `artifact` つき）。冷却中は構築役を呼ばずに即座に同じ失敗を返し、時計を進めると再び構築役を呼ぶ（2 回目は成功する）。
5. 同時実行数 1 では異なる 2 市区町村が直列、2 では並列に走る（`GatedBuilder` の最大同時数で確認）。
6. 期限（7 日）を過ぎた町字は、`ensure` が即座に返し、裏で再確認が走って `checkedAt` だけが進む（GET は増えず HEAD が増える）。
7. 予算 1 バイトで札幌 → 千代田の順に作ると、最近使われていない札幌が破棄され、直前に作った千代田は残る。
8. `mode: 'off'` では `ensure` が `AddressDisabledError`。
9. `datasetInfo` が `sourceDate` の最大と `stale` を返す。
10. 別の `AddressStore` が公開した成果物を、`peek` が（スナップショットの更新で）見つける。

- [ ] テストを書く → [ ] `bun test src/services/address_data.test.ts` で失敗（モジュールが無い）を確認 → [ ] 実装 → [ ] 成功を確認 → [ ] `bun run typecheck && bun run lint` → [ ] コミット `feat(address): add the address data manager with queueing and revalidation`

---

## タスク 2: 全国マスター・町字・郵便番号の読み込み

**ファイル:** `src/services/address_data.ts`（変更）、`src/services/address_data.test.ts`（変更）

**インターフェース:**

```ts
export interface MasterCity { lgCode: string; lg5: string; prefCode: string; pref: string; name: string; city: JaCity }
export interface MasterIndex {
  ver: string;
  byName: Map<string, MasterCity>;     // `${pref}/${cityNameOf(city)}`
  byLgCode: Map<string, MasterCity>;   // 6 桁
  byLg5: Map<string, MasterCity>;      // 5 桁
}
class AddressData {
  master(waitMs?: number): Promise<MasterIndex>;
  towns(lgCode: string, waitMs?: number): Promise<{ ver: string; json: TownJson }>;
  postal(waitMs?: number): Promise<{ ver: string; reader: PostalReader }>;
}
```

- どれも内部で `ensure` し、版ごとにメモリへ置く（町字は最大 50 件の LRU）。版が変われば読み直す。郵便番号の古い読み取り役は、使用中の呼び出しが壊れないよう、30 秒後（`unref` したタイマー）に閉じる。
- `lgCode` は 6 桁で受ける。`MasterCity.lgCode` は `lgCode6(city.code)`、`lg5` はその先頭 5 桁、`prefCode` は先頭 2 桁。

**失敗するテスト:**

1. `master()` が `東京都/千代田区` → `131016`、`北海道/札幌市中央区` → `011011`（先頭ゼロを保つ）を返し、`byLg5.get('13101')` と `byLgCode` も引ける。同じ版では同じオブジェクト、取得元が変われば新しいオブジェクト。
2. `towns('131016')` が `永田町` の町字（`chome_n`、`point`）を返し、同じ版ではキャッシュされる。
3. `postal()` の読み取り役が `1000014` を引ける。郵便番号を作り直すと新しい版の読み取り役になる。

- [ ] テスト → [ ] 失敗確認 → [ ] 実装 → [ ] 成功確認 → [ ] typecheck/lint → [ ] コミット `feat(address): load master, town and postal data on demand`

---

## タスク 3: 子プロセスの入口と `ChildProcessBuilder`

**ファイル:** `src/services/address_build_main.ts`（新規）、`src/services/address_data.ts`（変更）、`src/services/address_build_main.test.ts`（新規）、`src/services/address_data.test.ts`（変更）

**インターフェース:**

```ts
// address_build_main.ts
export function parseChildArgs(argv: readonly string[]): { dir: string; job: BuildJob }
export async function runChild(argv: readonly string[], deps?: { http?: HttpDeps; minimum?: Partial<JobMinimum>; nowSeconds?: () => number; err?: (line: string) => void }): Promise<number>
// 直接実行されたときだけ os.setPriority(0, 10) して process.exit(await runChild(...))
// 終了コード: 0 成功 / 3 国外 IP の拒否（403） / 1 その他の失敗

// address_data.ts
export function resolveBuildEntry(moduleDir: string, exists?: (path: string) => boolean): string  // address-build.js を優先、無ければ address_build_main.ts。どちらも無ければ throw
export class ChildProcessBuilder implements AddressBuilder {
  constructor(options: { dir: string; command?: (job: BuildJob) => string[]; timeoutMs?: (job: BuildJob) => number })
}
export function getAddressData(): AddressData
export function setAddressDataForTest(data: AddressData | null): void
```

- 既定の起動コマンドは `[process.execPath, entry, '--dir', dir, '--job', JSON.stringify(job)]`。標準エラーを読み、失敗メッセージにする（最後の非空行）。
- タイムアウトの既定は市区町村 5 分、郵便番号 3 分、マスター 3 分。超えたら `kill` して `AddressUnavailableError('…が時間内に終わりませんでした')`。
- `getAddressData()` はテスト環境（`NODE_ENV=test`）で `setAddressDataForTest` されていなければ例外にする（テストが実通信しないための保険）。それ以外では `loadAddressConfig()` で遅延生成する。

**失敗するテスト:**

1. `parseChildArgs` が引数を読み、足りない・不正な JSON・不明なジョブ種別を拒否する。
2. `runChild` が（偽の取得元で）マスターを作って終了コード 0。403 のとき終了コード 3 で `err` にメッセージ。それ以外の失敗は 1。
3. `resolveBuildEntry` が `address-build.js` を優先し、無ければ TypeScript の入口、どちらも無ければ例外。
4. `ChildProcessBuilder`（`command` を差し替え）: 終了コード 0 で解決、3 で `blocked: true`、1 で標準エラーのメッセージ、タイムアウトで kill。

- [ ] テスト → [ ] 失敗確認 → [ ] 実装 → [ ] 成功確認 → [ ] typecheck/lint → [ ] コミット `feat(address): add the build child entry and process builder`

---

## タスク 4: 正規化 `AddressNormalizer`

**ファイル:** `src/services/address_normalize.ts`（新規）、`src/services/address_normalize.test.ts`（新規）

**インターフェース:**

```ts
export interface AddressKeys { prefCode?: string; lgCode?: string; machiazaId?: string }
export interface NormalizedAddress {
  input: string;
  postalCode?: string;                 // 先頭の〒nnn-nnnn / nnn-nnnn を外した 7 桁
  pref?: string; city?: string; town?: string; addr?: string; other: string;
  normalized: string;                  // pref + city + town + addr
  level: number;                       // 0 | 1 | 2 | 3 | 8
  numberSource: 'rsdt' | 'chiban' | null;
  keys: AddressKeys;
  point?: { lat: number; lon: number; level: number };
  incomplete?: true;
  pending?: string[];                  // 待ち時間までに揃わなかった ID
  unavailable?: Array<{ artifact: string; message: string }>;
}
export function splitPostalCode(input: string): { postalCode?: string; address: string }
export class AddressNormalizer {
  constructor(data: AddressData, options?: { maxAgeMs?: number; now?: () => number })
  get generation(): number;            // 何回目のライブラリか（テスト用）
  normalize(input: string, options?: { level?: number; waitMs?: number }): Promise<NormalizedAddress>
}
```

**実装の要点:**

- ライブラリは `delete require.cache[path]` のあとに `import(import.meta.resolve('@geolonia/normalize-japanese-addresses'))` で読む（消して読むまでは、モジュール全体で 1 件ずつ）。読んだら `config.japaneseAddressesApi = 'file:///sora-address/ja'` にして、`requestHandlers.file` を差し替える。
- 差し替えた `file(url, options)` は `decodeURI(url.pathname)` を読み、`ja.json` → マスター、`ja/<都道府県>/<市区町村>.json` → `data.master()` で市区町村名から 6 桁を引いて `data.ensure({kind:'city', lgCode})` の `town.json` を返す。`{ ok, json, text }` の形で返す。それ以外の経路は `ok: false`。配った版は世代ごとの `served: Map<id, ver>` に記録する。
- 呼び出しごとの締め切りは `AsyncLocalStorage` で `file` に渡す（`waitMs` 全体で 1 つの締め切り）。
- 世代の作り直し: 呼び出しの前に、`served` の版が現在の版（`data.status()`）と違う、または成果物が消えた、または経過が `maxAgeMs`（既定 24 時間）を超えたら、新しい世代を読む。作り直し中の同時の呼び出しは同じ読み込みを待つ。
- 待ち時間切れ（`AddressPendingError`）と、市区町村の構築失敗（`AddressUnavailableError` の `artifact` が `city:`）は、`level: 2` で言い直して `incomplete: true` と `pending` / `unavailable` を付ける。マスターが取れないときはそのまま投げる。
- 呼び出しのあとに、使った市区町村とマスターを `data.store.touch` する（ライブラリのキャッシュ経由では `file` が呼ばれないため）。
- `splitPostalCode`: 先頭の `〒` と 3 桁 + 4 桁（ハイフンの有無、全角を許す）を外す。`〒` の無い 7 桁だけの先頭も外す（直後が数字でないこと）。
- 入力は 300 文字まで（超えたら `AddressInputError`）。空は `AddressInputError`。
- `metadata.city.code`（数値）は `lgCode6` で 6 桁に戻して `keys.lgCode` にし、先頭 2 桁を `prefCode` にする。

**失敗するテスト（実ライブラリ + 偽の取得元から作った実データ）:**

1. `東京都千代田区永田町1-7-1` → `level: 3`、`town` が永田町一丁目、`other` が `7-1`、`keys` が `{prefCode:'13', lgCode:'131016', machiazaId:'0005001'}`、`point.level: 3`、`numberSource: null`。
2. `東京都千代田区` は `level: 2` で、市区町村のデータを取りに行かない（構築役が呼ばれたのはマスターだけ）。
3. `〒100-0014 東京都千代田区永田町1-7-1` は `postalCode: '1000014'` で、1 と同じ町字。全角・ハイフンなしも同様。
4. 住所でない文字列は `level: 0`、`normalized: ''`。
5. 都道府県なしの `札幌市中央区北1条西2丁目` が解決する（全角数字の大字名を含む町字）。
6. 市区町村の構築が時間内に終わらないとき（`GatedBuilder`）、`level: 2`、`incomplete: true`、`pending: ['city:131016']`。構築が終わると次の呼び出しは `level: 3`。
7. 市区町村の構築が失敗したとき（403）、`level: 2` と `unavailable`。マスターが失敗したときは `AddressUnavailableError`（`blocked: true`）を投げる。
8. 同じ住所の同時 20 呼び出しで市区町村の構築は 1 回。
9. 取得元の町字が変わって再構築されたあと、次の呼び出しで世代が増え、追加された町字が解決する。
10. `maxAgeMs` を過ぎると世代が増える。
11. `splitPostalCode` の表（`〒100-0014 …`、`１００−００１４ …`、`1000014 …`、`100-0014`（住所なし）、先頭が数字の番地で郵便番号でないもの）。

- [ ] テスト → [ ] 失敗確認 → [ ] 実装 → [ ] 成功確認 → [ ] typecheck/lint → [ ] コミット `feat(address): normalize addresses with the Geolonia library over local data`

---

## タスク 5: 郵便番号の順引き・逆引き

**ファイル:** `src/services/address_postal.ts`（新規）、`src/services/address_postal.test.ts`（新規）、`src/services/postal_code.ts`（変更: 通り名による絞り込み）、`src/services/postal_code.test.ts`（変更）

**インターフェース:**

```ts
export interface PostalCandidate {
  kind: PostalKind; prefecture: string; city: string; town: string; townRaw: string;
  detail?: string; office?: string;
  lgCode?: string; machiazaIds?: string[];
  lat?: number; lon?: number; locationLevel?: number;   // 2 市区町村 / 3 町字 / 8 番地
}
export interface ZipLookup { zipcode: string; candidates: PostalCandidate[]; incomplete?: true; pending?: string[] }
export interface ZipForAddress { zipcode: string; kind: PostalKind; town: string; townRaw: string; exact: boolean; fallback: boolean }
export function normalizeZip(raw: string): string                       // 7 桁に。不正は AddressInputError
export async function lookupZip(ctx: AddressContext, zipcode: string, options?: { waitMs?: number }): Promise<ZipLookup>
export async function zipsForAddress(ctx: AddressContext, address: NormalizedAddress, options?: { waitMs?: number }): Promise<ZipForAddress[]>

// postal_code.ts に追加
export function refineByStreetNames(matches: ZipMatch[], rawInput: string): ZipMatch[]
```

**実装の要点:**

- `lookupZip`: `postal().reader.byZip(zip)`。一般の行は市区町村ごとに `lg5` → `master().byLg5` で 6 桁を引き、`towns()` を `ensure`（待ち時間内）して `linkPostalRows` で町字に結び、行の `machiazaIds` の点の平均を座標にする（町字の既定行は市区町村の代表点、`locationLevel: 2`）。事業所・私書箱は `pref + city + town + detail` を正規化して座標を付ける（最大 20 件）。市区町村のデータが時間内に揃わなければ座標なしで `incomplete`。
- 結びつけは `Map<lgCode, {key, rows, links}>`（`key = 郵便番号の版|市区町村の版`、最大 30 件）でキャッシュする。
- `zipsForAddress`: `level < 2` は空。`level == 2` は市区町村の既定行（`fallback: true`）。`level >= 3` は `zipsForTown(rows, links, machiazaId, address.addr ?? address.other)` に、入力の通り名による絞り込み `refineByStreetNames(matches, address.input)` をかける。
- `refineByStreetNames`: 括弧の注記が「、」区切りの通り名の列（`釜座通夷川下る、夷川通釜座東入、…`）の行について、注記の項目のどれかが入力に含まれる行があれば、それらを `exact: true` にし、含まれない `exact: false` の行を落とす。1 つも当たらなければ何も変えない。

**失敗するテスト:**

1. `lookupZip('1000014')` が一般の候補 1 件（永田町、`lgCode: '131016'`、`machiazaIds`、座標、`locationLevel: 3`）を返す。
2. `1000000`（市区町村の既定行）は千代田区の代表点で `locationLevel: 2`。
3. 事業所 `0608621` は事業所名と、正規化した座標（`locationLevel: 3`）を持つ。私書箱 `1008799` は `po_box`。
4. 存在しない `9999999` は空の候補。不正な `12-34` は `AddressInputError`。ハイフン・全角・`〒` は許す。
5. 市区町村の構築が時間内に終わらないとき、座標なしの候補と `incomplete`。
6. `zipsForAddress`: `永田町1-7-1` → `1000014`（`exact: true`）、`千代田1-1` → `1000001`、`東京都千代田区`（level 2）→ `1000000` の既定行（`fallback: true`）、札幌 `北1条西2丁目` → `0600001`、`北1条西20丁目` → `0640821`。
7. `refineByStreetNames`: 京都の実データに近い行（`大黒町（釜座通夷川下る、…）` と `大黒町（河原町通三条下る、…）`）を作り、入力に `釜座通夷川下る` が含まれるときだけ前者が `exact: true` で残る。当たる項目が無いときは変えない。

- [ ] テスト → [ ] 失敗確認 → [ ] 実装 → [ ] 成功確認 → [ ] typecheck/lint → [ ] コミット `feat(address): look up postal codes forward and backward with locations`

---

## タスク 6: 突き合わせとツール本体

**ファイル:** `src/services/address_checks.ts`、`src/services/address_tools.ts`、`src/services/address_context.ts`（いずれも新規）、各 `.test.ts`

**インターフェース:**

```ts
// address_checks.ts
export type CompareRelation = 'identical' | 'same-block' | 'same-town' | 'same-city' | 'same-prefecture' | 'different';
export interface AddressComparison { relation: CompareRelation; sameLevel: number; differences: string[] }
export function compareAddresses(a: NormalizedAddress, b: NormalizedAddress): AddressComparison
export type ZipCheckStatus = 'match' | 'partial' | 'mismatch' | 'unknown';
export interface ZipCheck { status: ZipCheckStatus; zipcode: string; expected: ZipForAddress[]; reason: string }
export async function checkZip(ctx: AddressContext, zipcode: string, address: NormalizedAddress): Promise<ZipCheck>

// address_context.ts
export interface AddressContext { data: AddressData; normalizer: AddressNormalizer }
export function getAddressContext(): AddressContext
export function setAddressContextForTest(ctx: AddressContext | null): void
export function createAddressContext(data: AddressData): AddressContext

// address_tools.ts
export const ADDRESS_ATTRIBUTION: string
export interface DatasetField { source: string; updatedAt: string | null; stale: boolean }
export async function searchPostalCode(input: { zipcode?: string; address?: string }, ctx?: AddressContext): Promise<SearchPostalCodeResult>
export async function normalizeAddressTool(input: { address: string; level?: number; zipcode?: string; compareAddress?: string }, ctx?: AddressContext): Promise<NormalizeAddressResult>
```

**仕様:**

- `compareAddresses`: 都道府県コードが違う、またはどちらかが level 0 なら `different`。都道府県一致 → `same-prefecture`、`lgCode` 一致 → `same-city`、`machiazaId` 一致 → `same-town`。両方 level 8 で番地のキーまで同じなら `identical`、住居表示の街区（`blk`）または地番の本番（`prc[0]`）まで同じなら `same-block`（段B で使う。この計画ではキーが無いので到達しない）。`sameLevel` は一致した最も深い階層（0〜3、8）。`differences` は `['市区町村', '町字']` のように日本語で。
- `checkZip`: 住所が level 2 未満なら `unknown`。期待される番号（`zipsForAddress`）に渡された番号が `fallback` でなく含まれれば `match`（`exact` でない候補なら理由に「番地までは確認していません」）。`fallback` の番号だけなら `partial`。含まれない場合、渡された番号の行（`byZip`）に同じ `lg5` の行があれば `partial`（同じ市区町村の別の町）、無ければ `mismatch`。データに無い番号は `mismatch`（理由「郵便番号データに存在しません」）。
- `searchPostalCode`: `zipcode` と `address` はどちらか一方（両方・どちらも無しは `AddressInputError`）。`zipcode` → `{ zipcode, count, candidates, incomplete?, pending?, dataset, attribution }`。`address` → `{ address, normalized, level, postalCodes, incomplete?, pending?, dataset, attribution }`。
- `normalizeAddressTool`: `address` を正規化し、`level`（1〜8、既定 8）を渡す。`zipcode` があれば `checks.zipcode`、`compareAddress` があれば `checks.compare`（もう一方の正規化結果の `normalized` と `level` も `checks.compare.other` に添える）。出力は `{ ...NormalizedAddress, postalCodes, checks?, dataset, attribution }`。住所入力の先頭の郵便番号は `postalCode` に分け、`checks.zipcode` は `zipcode` が無ければこれを使う。
- `dataset`: `{ source: 'デジタル庁 アドレス・ベース・レジストリ / 日本郵便 郵便番号データ', updatedAt, stale }`。`attribution`: ABR の出典と加工の明記（公共データ利用規約 第1.0版）。
- 入力の検証は `address` が 1〜300 文字、`level` が 1〜8 の整数。

**失敗するテスト:** `compareAddresses` の表（同じ町 / 同じ市区町村 / 都道府県違い / level 0）、`checkZip` の全分岐（`match`、`partial` 既定番号、`partial` 同じ市区町村、`mismatch`、存在しない番号、`unknown`）、`searchPostalCode` の両形式と入力検証、`normalizeAddressTool` の `checks` と `incomplete` の伝播、出力に `dataset` と `attribution` があること。

- [ ] テスト → [ ] 失敗確認 → [ ] 実装 → [ ] 成功確認 → [ ] typecheck/lint → [ ] コミット `feat(address): add postal search and normalize tools with cross-checks`

---

## タスク 7: 同梱・バンドル確認・実データでの確認・文書

**ファイル:** `Containerfile`（変更）、`docs/superpowers/specs/2026-10-13-address-data-design.md`（変更: 503 → 502、ツール登録の時期）、この計画書（実行結果を追記）

- [ ] `Containerfile` のビルド段に `RUN bun build ./src/services/address_build_main.ts --target=bun --outfile=address-build.js` を足し、最終段に `COPY --from=builder /app/address-build.js /app/address-build.js` を足す。
- [ ] バンドル確認: `bun build` で `address_normalize` を入口にしたバンドルを作り、`node_modules` を見える場所に置いて、動的 import と `require.cache` による作り直し、`import.meta.resolve` が動くことを確認する。`address_build_main.ts` のバンドルを子として起動し、マスターの構築が通ることを実通信で確認する（日本のホスト）。
- [ ] 実データでの確認（`ChildProcessBuilder` を使い、実際の子プロセスと通信で）: 初回の `normalize_address`（マスター + 市区町村）の所要時間、2 回目以降の p50/p95、`search_postal_code` の `1000014`・`0600042`・事業所番号、`〒150-0001` の逆引き、京都市中京区の通り名つき住所の絞り込み、構築中のプロセスの優先度（nice 10）の確認。
- [ ] 設計書を直す（`ADDRESS_DATA_UNAVAILABLE` は 502、ツールの登録は 3 ツールがそろってから）。
- [ ] 全件テスト（切り離して実行）、typecheck、lint。
- [ ] この計画書に実行結果を追記してコミット `docs(address): record the address engine results`

---

## 範囲外（次の計画）

- 段B（住居表示・地番の構築、`csv_ranges`、`numberSource`）、町字の点の索引、`reverse_geocode`、`checks.coordinates`。
- ジオコーダーのローカル優先化、`search_poi` の連携、事前取得（`SORA_ADDRESS_PRELOAD`）、`eager`。
- MCP / REST / OpenAPI / ツール台帳 / README / instructions への登録と、運用文書。
