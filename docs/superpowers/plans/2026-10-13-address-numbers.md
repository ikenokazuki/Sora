# 番地・号（段B）と逆ジオコーディング 実装計画

> **実行方法:** superpowers:executing-plans でインライン実行する。各タスクは「失敗するテストを書く → 失敗を確認 → 最小の実装 → 成功を確認 → `bun run typecheck && bun run lint` → コミット」の順に進める。

**目的:** 住居表示・地番のデータを市区町村単位で取得・構築し、`normalize_address` を番地・号（level 8）まで照合できるようにする（`numberSource`、番地単位の座標）。あわせて、町字の点の全国索引と `reverse_geocode`（緯度経度 → 住所）、`checks.coordinates`（座標 × 住所の突き合わせ）を作る。ツールの登録は次の計画（登録と統合）でまとめて行う。

**親の設計:** `docs/superpowers/specs/2026-10-13-address-data-design.md`。前の計画: `…-address-engine.md`（実行結果の「次の計画に持ち越すこと」を引き継ぐ）。

## 設計との差分

- **段B は別の成果物 `num:<lg_code>` にする。** 設計書は「`city:<lg_code>` を段A、段A+B の順に 2 回公開する」としていたが、それだと町字だけが要る処理（郵便番号の座標、結びつけ）が段B の構築を待つことになる。段A（`city:`）は今のまま、段B（`num:`）を別の成果物にして、ライブラリに渡す市区町村の JSON は、配信時に両方を合わせて作る（`town.json` に `ranges.json` の `csv_ranges` を入れる）。
- **ライブラリは「段B を待ってから」市区町村を読む。** 待ち時間の中で段B が揃えば、1 回の呼び出しで level 8 まで答える。揃わなければ（時間切れ・失敗）段A だけを渡して level 3 で答え、`incomplete` と `pending` を付ける。このとき世代に「段B が無いまま配った」と記録しておき、段B が公開されたら次の呼び出しでライブラリを読み直す（既存の「配った版が変わったら読み直す」の仕組みをそのまま使う。無い版は空文字で記録する）。
- **結合は一時 SQLite ではなくメモリで行う。** 市区町村単位なので、位置参照の `Map`（キー → `"経度,緯度"` の文字列）と、町字ごとの出力行の配列で足りる（福知山市の地番 40 万行で、位置参照は 14 万行・出力は十数MB）。メインの CSV はストリームで読み、行オブジェクトを作らない。ABR の市区町村は政令市では区ごとのコードなので、最大でも 100 万行台に収まる。
- **住居表示の町（`rsdt: true`）には地番を、それ以外の町には住居表示を出力しない。** ライブラリは町の `rsdt` で片方しか引かないため。住居表示の無い市区町村、地番の無い市区町村は、ある方だけを取得する。
- **配信する txt にヘッダー部は付けない。** セクションは `住居表示,<町字ID>\nblk_num,rsdt_num,rsdt_num2,lng,lat\n…` と `地番,<町字ID>\nprc_num1,prc_num2,prc_num3,lng,lat\n…`（ライブラリは節の 1 行目を捨てて、2 行目をヘッダーとして読む）。節の開始位置と長さ（UTF-8 のバイト数）を `ranges.json` に町字 ID で持つ。Geolonia は町字名で結びつけるので、同名の町（京都市の大黒町など）が潰れるが、こちらは町字 ID で結びつける。

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/services/address_csv.ts`（変更） | zip の最初のファイルを展開しながら読み、CSV の行を 1 行ずつ渡す `streamZipCsv`。 |
| `src/services/address_numbers.ts`（新規） | 段B の構築 `buildNumbers`（位置参照の読み込み、住居表示・地番の出力、節の範囲）。 |
| `src/services/address_store.ts` / `address_jobs.ts` / `address_builder.ts` / `address_build_main.ts`（変更） | ジョブ種別 `num` と `index`、成果物 ID `num:<lg_code>` と `index`、期限、優先順位、破棄の対象、タイムアウト。 |
| `src/services/address_data.ts`（変更） | `numbers(lgCode)`（範囲表の読み込み）、`geoIndex()`。 |
| `src/services/address_normalize.ts`（変更） | 市区町村の JSON に `csv_ranges` を入れて配信し、txt の範囲を読ませる。段B が間に合わないときの扱い。 |
| `src/services/address_geo_index.ts`（新規） | 町字の点の全国索引（`geo.sqlite`）の構築と、近傍検索。 |
| `src/services/address_reverse.ts`（新規） | `reverseGeocode`（座標 → 住所）。 |
| `src/services/address_checks.ts` / `address_tools.ts`（変更） | `checks.coordinates`、`reverseGeocodeTool`、`normalizeAddressTool` の `lat` / `lon`。 |
| `src/test_fixtures/address/harness.ts`（変更） | 段B 用の固定データ（住居表示と地番の本体・位置参照）。 |

---

## タスク 1: zip の CSV をストリームで読む

**ファイル:** `src/services/address_csv.ts`、`src/services/address_csv.test.ts`

**インターフェース:**

```ts
/** zip の最初のファイルを展開しながら、CSV の 1 行（列の配列）ずつ onRow に渡す。BOM を除く。onRow が false を返したら読み終える。 */
export function streamZipCsv(zipPath: string, onRow: (row: string[]) => boolean | void): Promise<void>
```

- yauzl の `openReadStream` から Buffer のチャンクを受け、`TextDecoder('utf-8', { stream: true })` で文字列にして、自前の増分パーサに渡す（RFC 4180: `""` のエスケープ、引用符の中のカンマと改行、CRLF / LF、末尾の改行なし）。チャンクの境界が 1 文字や 1 行の途中でもよい。
- 空行は渡さない。ヘッダー行も通常の行として渡す（呼び出し側が列名の位置を決める）。

**失敗するテスト:** 引用符・カンマ・改行を含む行、CRLF と LF、BOM、末尾の改行なし、空行、チャンク境界（1 バイトずつ流しても同じ行になる。日本語の 3 バイト文字の途中で切れても壊れない）、`false` を返した時点で読み終える、zip でないファイル・エントリの無い zip は失敗、数十万行（合成）でも `readZipText` + `parseCsvMatrix` と同じ行になる。

---

## タスク 2: 段B の構築（住居表示・地番）

**ファイル:** `src/services/address_numbers.ts`、`src/services/address_numbers.test.ts`、`src/services/address_store.ts`、`src/services/address_jobs.ts`、`src/services/address_builder.ts`、`src/services/address_build_main.ts`、`src/test_fixtures/address/harness.ts`

**インターフェース:**

```ts
// address_store.ts
export type BuildJob = { kind: 'master' } | { kind: 'postal' } | { kind: 'city'; lgCode: string } | { kind: 'num'; lgCode: string } | { kind: 'index' };
// jobArtifactId: num → `num:${lgCode}`、index → 'index'。artifactRelDir: `num/<lg_code>`、`index`。ttlFor: num は 30 日、index は 30 日。
// evict の対象: `city:` と `num:` で始まる ID

// ranges.json
export type NumberRanges = Record<string, { 住居表示?: { start: number; length: number }; 地番?: { start: number; length: number } }>;
```

- ジョブ `num`: 段A の `town.json` が無ければ先に段A を作る。住居表示・住居表示位置・地番・地番位置の 4 つの URL を HEAD で調べ（無ければ 404 で null）、署名を合成する。同じ署名なら `markChecked` のみ。町字に `rsdt: true` のものが無ければ住居表示を、`rsdt` でないものが無ければ地番を取得しない。取得元に無いもの（404）は、無いものとして続行する。
- 位置参照は `Map<"町字ID|街区ID|住居ID|住居2ID" または "町字ID|地番ID", "経度,緯度">`（`rep_srid` が EPSG:6668 / 4612 / 4326 のものだけ。重複キーは最初の行）。メインは `streamZipCsv` で 1 行ずつ読み、対象の町字の行だけ、`blk_num,rsdt_num,rsdt_num2,lng,lat` / `prc_num1,prc_num2,prc_num3,lng,lat` の行にして町字ごとの配列に入れる。値に `,` `"` 改行を含む行は捨てる。列は見出し行から位置を決める（足りない列があれば失敗）。
- 出力: `rsdt.txt`、`chiban.txt`（無ければ作らない）、`ranges.json`。節は上の差分のとおり。節の長さは UTF-8 のバイト数。構築後、住居表示・地番とも 1 行も無い場合は、空の `ranges.json`（`{}`）だけを公開する（取得元に無い市区町村を毎回調べ直さないため）。

**失敗するテスト（固定データ）:**

1. 住居表示の町（千代田区の永田町）から `rsdt.txt` の節ができ、`ranges.json` の開始位置と長さでバイト単位に切り出した文字列が `住居表示,0005001\nblk_num,rsdt_num,rsdt_num2,lng,lat\n7,1,,139.74…,35.67…\n…` になる（日本語の町字 ID でなくても、バイト数で切り出せる）。
2. 地番の町（地番のみの市区町村）から `chiban.txt` ができる。位置参照の無い地番は座標を空にして出力する。
3. 住居表示の町の地番、地番の町の住居表示は出力しない。
4. 同名の町字が複数ある市区町村で、町字 ID ごとに別の節になる。
5. 住居表示も地番も無い市区町村は、空の `ranges.json` だけを公開し、2 回目は HEAD のみで `markChecked`。
6. 取得元の署名が変わると作り直し、旧版を維持して失敗を記録する経路（既存の仕組み）が `num` でも働く。
7. 段A が無い状態で `num` を頼むと、段A も作られる。
8. 列が足りない・値にカンマや引用符を含む行は、捨てるか失敗にする（捨てた件数は失敗にしない）。
9. `parseChildArgs` / `ChildProcessBuilder` / `AddressData` が `num` と `index` を扱い、優先順位は マスター → 郵便番号 → 索引 → 市区町村（段A）→ 段B の順。

---

## タスク 3: 正規化で番地・号まで照合する

**ファイル:** `src/services/address_normalize.ts`、`src/services/address_normalize.test.ts`、`src/services/address_data.ts`、`src/test_fixtures/address/harness.ts`

**実装の要点:**

- `serve` が `ja/<都道府県>/<市区町村>.json` を求められたら、`city:` と `num:` を `ensure` し（残り時間の範囲で）、段A の `town.json` に `ranges.json` の `csv_ranges` を入れた JSON を返す。`served` に両方の版を記録する。
- `serve` が `ja/<都道府県>/<市区町村>-住居表示.txt` / `-地番.txt` を求められたら、`options.offset` / `options.length`（バイト）の範囲を `rsdt.txt` / `chiban.txt` から返す（`Bun.file(path).slice(offset, offset + length).text()`）。
- 段B が `AddressPendingError` / `AddressUnavailableError` のときは、`csv_ranges` なしの段A だけを返し、`served.set('num:<lg>', '')` と、世代の `missing` に理由（pending / unavailable とメッセージ）を記録する。`outdated` は、記録した版と現在の版（無ければ空文字）を比べる。以後この世代で同じ市区町村を答えるときは、段B がまだ無ければ `incomplete` と `pending`（または `unavailable`）を付ける。
- `shapeResult` の `keys` / `numberSource` / `point` は実装済み（ライブラリの `metadata.rsdt` / `metadata.chiban` を使う）。

**失敗するテスト（固定データの住居表示と地番）:**

1. `東京都千代田区永田町1-7-1` が level 8、`addr: '7-1'`、`numberSource: 'rsdt'`、`keys.blk: '7'`、`keys.rsdt: '1'`、`point.level: 8`、`normalized` が `東京都千代田区永田町一丁目7-1`。
2. 住居表示に無い番地は level 3 のまま（`other` に残る）。
3. 地番の町（地番のみの市区町村）は `numberSource: 'chiban'`、`keys.prc`。位置参照の無い地番は level 8 のまま `point.level` が 3。
4. 段B の構築が間に合わないとき（構築役を止める）、level 3 で `incomplete: true`、`pending: ['num:…']`。構築が終わったあと、次の呼び出しで読み直されて level 8 になる（`generation` が増える）。
5. 段B の取得に失敗したとき、level 3 と `unavailable`。
6. 市区町村までの入力・住所でない入力は、段B を取りに行かない。
7. 郵便番号の逆引き・突き合わせ（`zipsForAddress`、`checkZip`）が level 8 の住所でも働く（`addr` を番地の判定に使う）。

---

## タスク 4: 町字の点の全国索引

**ファイル:** `src/services/address_geo_index.ts`、`src/services/address_geo_index.test.ts`、`src/services/address_jobs.ts`、`src/services/address_data.ts`

**インターフェース:**

```ts
export interface NearTown { lgCode: string; machiazaId: string; lon: number; lat: number; distanceMeters: number }
export class GeoIndexReader {
  constructor(path: string);
  /** 近い順に最大 limit 件。maxMeters を超えるものは返さない。格子（約 1.1km）を外へ広げながら探す。 */
  nearest(lat: number, lon: number, limit: number, maxMeters: number): NearTown[];
  close(): void;
}
export function buildGeoIndex(path: string, rows: Iterable<{ lgCode: string; machiazaId: string; lon: number; lat: number }>): void
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number  // 球面（haversine）
```

- ジョブ `index`: 47 都道府県の `mt_town_pos/pref/mt_town_pos_pref{NN}.csv.zip` を取得し（8 並列、`streamZipCsv`）、`geo.sqlite`（テーブル `town_pt(lg_code, machiaza_id, lon, lat, iy, ix)`、`(iy, ix)` に索引。`ix = floor(lon * 100)`、`iy = floor(lat * 100)`）にまとめる。HEAD の署名を合成して、同じなら作り直さない。最小件数（既定 150,000）を下回ったら公開しない。
- 近傍検索: 点を含む格子から外へリング状に広げ、必要件数が集まり、次のリングの最短距離が集まった最遠の距離を超えたら止める。緯度による経度方向の距離の縮みを考慮する。

**失敗するテスト:** `distanceMeters`（東京駅 – 新宿駅などの既知の距離に近い）、`nearest` が近い順・件数・距離の上限・格子の境界またぎ・点が無い範囲での空を返す、合成した数千点で全探索と同じ結果になる、`buildGeoIndex` が不正な座標（範囲外・NaN）を捨てる、ジョブ `index` が偽の取得元から作って公開し、署名が同じなら再取得しない、最小件数未満は公開しない。

---

## タスク 5: 逆ジオコーディングと座標の突き合わせ

**ファイル:** `src/services/address_reverse.ts`、`src/services/address_reverse.test.ts`、`src/services/address_checks.ts`、`src/services/address_tools.ts`（と各テスト）

**インターフェース:**

```ts
export interface ReverseResult {
  lat: number; lon: number;
  found: boolean;
  /** 範囲内に見つからなかった理由（found: false のとき）。 */
  reason?: string;
  address?: { pref: string; city: string; town: string; addr?: string };
  normalized?: string;
  level: number;                              // 8 番地・号 / 3 町字 / 0 見つからない
  numberSource: 'rsdt' | 'chiban' | null;
  distanceMeters?: number;                    // 入力の座標から見つけた点まで
  approximate: true;                          // 代表点による最寄り判定で、ポリゴンの包含判定ではない
  keys: AddressKeys;
  postalCodes: Array<{ zipcode: string; town: string; townRaw: string; exact: boolean; fallback: boolean }>;
  alternatives: Array<{ normalized: string; level: number; distanceMeters: number }>;   // 最大 3 件
  incomplete?: true; pending?: string[]; unavailable?: Array<{ artifact: string; message: string }>;
}
export async function reverseGeocode(ctx: AddressContext, input: { lat: number; lon: number; maxDistanceMeters?: number }): Promise<ReverseResult>
```

- 手順: 座標を検証する（緯度 20〜46、経度 122〜154 の外は `found: false`、数値でない・範囲外の値は `AddressInputError`）→ `geoIndex` から近い町字を最大 10 件（既定 300m、最大 2,000m の範囲を、町字の点までの距離ではなく「町字の点から範囲内」ではなく**近い町字の候補を広め（半径 maxDistance + 1km）に取る**）→ 候補の市区町村ごとに段A・段B を用意し（待ち時間の範囲で）、候補の町字の節（住居表示の町は `住居表示`、それ以外は `地番`）の点から最寄りを探す → 範囲内なら level 8、無ければ最寄りの町字（level 3、`maxDistance` 内に限らず最寄りの 1 件。距離を添える）。
- 段B が間に合わない・失敗した市区町村は、町字の点で答えて `incomplete` / `pending` / `unavailable` を付ける。
- 郵便番号は `zipsForAddress` と同じ結びつけ（キーから）。
- `checkCoordinates(ctx, lat, lon, address)`: 座標を逆ジオコーディングして、`compareAddresses` で住所と比べる。`status`: 同じ町字で、両方 level 8 なら距離 150m 以内で `match`、同じ町字でもそれ以外（level 3 同士・距離が離れる）は `partial`、同じ市区町村で町が違えば `partial`、市区町村が違えば `mismatch`、住所を解釈できなければ `unknown`。`distanceMeters`（座標から住所の点まで）、`nearest`（座標の最寄りの住所）、`reason` を添える。
- `reverseGeocodeTool` と `normalizeAddressTool` の `lat` / `lon`（`checks.coordinates`）。

**失敗するテスト:** 固定データで、永田町の住居表示の点の近くが level 8（`numberSource: 'rsdt'`）になる、住居表示の点から範囲外では町字（level 3）、地番の町で地番に戻る、範囲外（海上など）は `found: false`、`alternatives` が近い順で最大 3 件、座標の検証、段B が間に合わないときの `incomplete`、`postalCodes`、`checkCoordinates` の全分岐。

---

## タスク 6: 実データでの確認と記録

- [ ] 世田谷区（住居表示、約 7,900 行の節）、福知山市（地番）、京都市中京区（通り名 + 地番）、長崎市（最大規模）で、実通信の `buildNumbers` の所要時間・子プロセスのピークメモリ（`/proc` または `ps`）・出力サイズを測る。目標: 長崎市でも 15 秒以内、子のピークメモリ 300MB 以下。
- [ ] 全国索引の構築時間（目標 15 秒以内）とサイズ。
- [ ] `normalize_address` が `東京都世田谷区三軒茶屋2-24-1`、`京都府福知山市…`、`京都市中京区…` で level 8 になること、`reverse_geocode`（35.675895, 139.746306 付近が永田町一丁目）、座標の突き合わせ。
- [ ] 揃ったあとの `normalize_address` / `reverse_geocode` の p50 / p95（目標 p95 50ms 以下）。
- [ ] 実行結果をこの計画書に追記してコミット。

---

## 範囲外（次の計画）

- ハイフンで続く部屋番号つきの住所（`2-24-1-301`）を、前の部分で照合し直す。
- 事業所・私書箱の座標を、町名の `foldName` による町字への結びつけで改善する。
- MCP / REST / OpenAPI / ツール台帳 / README / instructions への登録（3 ツールがそろってから 1 回、ツール数 47 → 50）、ジオコーダーのローカル優先化、`search_poi` の連携、事前取得と `eager`、運用文書。
