# Global Intelligence Live Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yahooリアルタイムに依存せず、世界各国の速報・公式資料・統計を取得し、呼出元LLMが多様な用途で判断できる詳細なMCPレポートを提供する。

**Architecture:** GDELT/GDACSの既存アダプターを修復し、公式・報道フィードと詳細本文を追加する。Bunの収集処理とSQLiteの永続履歴を使い、期限内の追加更新と保存済み資料を組み合わせる。レポートの詳細・続き・更新差分をMCPから取得可能にする。

**Tech Stack:** 既存Bun、TypeScript、Hono、Zod、MCP TypeScript SDK、SQLite、fast-xml-parser、Readability、linkedom、既存スクレイパー。新しい基盤サービス・LLM依存は導入しない。

**Spec:** [設計書](../specs/2026-09-22-global-intelligence-live-evidence-design.md)。実装者は計画と設計書を両方読むこと。

**Status:** 計画作成・接続調査完了。製品コードの実装、mainへのpush、イメージ更新は未実施。

## Global Constraints

- Yahooリアルタイムは本機能で使用しません。日本を指定した場合も同じです。
- 件数やリスク指標だけではなく、取得した内容を詳細かつ丁寧に返します。
- 国名・検索語の個別ハードコードで症状を回避しません。
- 既存のX検索など、別機能の振る舞いを変更しません。
- 非LLMの収集・分類と、呼出元LLMの用途別判断を分離します。
- 既存REST/MCPフィールド、空query/topics許容、遅延ツール公開と`default.`別名を維持します。
- 取得時点・公表時点・出来事の時点・有効期間を分離し、不明値は補完しません。
- 実装・テスト・ドキュメントを各タスクでまとめてレビュー可能にします。

## Review Focus

1. 30日要求なのに最新15分ファイルしかない場合、完全取得と誤表示しない（Task 4/9）。
2. 発生が30日より前でも現在継続する災害、将来の祝日、訂正・解除を正しく区別する（Task 3/8/9）。
3. 200だがHTML・空本文・古いfeed・未来の観測日時・異常Content-Typeの場合、成功件数で覆い隠さない（Task 2/5）。
4. 多言語・不明地域・同一配信の転載・SNSの地域言及を、誤った発生国や複数の独立証拠に変えない（Task 5/8/11）。
5. 詳細ページ・差分・再起動で情報や参照を失わず、全provider停止時も「問題なし」にしない（Task 1/9/10/12）。

## 0. 調査済みの基点と進め方

基点は`main=a6ecb7c`。2026-09-22 JSTにremoteをfetchし一致を確認済み。`feat/intelligence-analysis-foundation`と`feat/yahoo-realtime-direct-api`の成果を含むmainから開始する。研究ブランチを機械的にマージしない。

実装開始時の確認コマンド:

```bash
git fetch ghostfetch --prune
git status --short
git log --oneline main..ghostfetch/main
git worktree add ../sora-global-intelligence -b feat/global-intelligence-live-evidence ghostfetch/main
cd ../sora-global-intelligence
bun test src/services/country_intel src/services/intelligence
```

この計画のドキュメントが未コミットの場合は、内容を保全してからworktreeへ渡す。既存変更を破棄しない。過去に全体テストで報告された`life.ts`の型エラーやライブ検索の失敗も、開始時に現時点の基準を確認する。過去の成功・失敗数を今回の測定値として流用しない。

各タスクの赤→緑を確認してから次へ進む。コミットは対応する製品ファイル・テスト・ドキュメントを指定して作成し、`git add .`で他タスクを巻き込まない。

## 1. 共通契約とファイル配置

以下は新規設計の型であり、現在の製品に実装済みという意味ではない。各型をZodとTypeScriptで同じ定義から生成する。

```ts
type Domain = 'general' | 'content' | 'marketing' | 'finance' | 'tourism' | 'travel';
type DataState = 'fresh' | 'stale' | 'unknown' | 'clock_anomaly';
type Limitation = {
  code: string;
  area: string;
  providerId?: string;
  message: string;
  evidenceIds: string[];
};
type Fact = {
  id: string;
  topic: string;
  text: string;
  basis: 'provider_field' | 'source_excerpt' | 'rule_derived';
  evidenceIds: string[];
};
type EvidenceDetail = {
  evidenceId: string;
  providerId: string;
  providerItemId: string;
  sourceRecordUrl: string;
  contentKind: 'title_only' | 'excerpt' | 'extracted_text' | 'structured_record';
  language?: string;
  blocks: { index: number; text: string }[];
  structuredData?: Record<string, unknown>;
  occurredAt?: string;
  publishedAt?: string;
  updatedAt?: string;
  retrievedAt: string;
  validFrom?: string;
  validUntil?: string;
  timeBasis: string;
  geographyBasis: string;
  sourceStatus: 'unverified' | 'verified' | 'corrected' | 'retracted' | 'deleted';
  contentTruncated: boolean;
};
type EvidencePage = {
  contextId: string;
  items: EvidenceDetail[];
  totalStored: number;
  nextCursor?: string;
};
type SourceState = {
  sourceId: string;
  lastCheckedAt?: string;
  lastSuccessfulFetchAt?: string;
  providerUpdatedAt?: string;
  lastErrorCode?: string;
  etag?: string;
  lastModified?: string;
  retryAt?: string;
  cursor?: string;
};
type CollectionWindow = {
  from: string;
  to: string;
  complete: boolean;
  gaps: { from: string; to: string; reason: string }[];
};
```

既存`CountryEvidence`は参照・互換用として残し、`EvidenceDetail`は詳細用に分ける。レポートに載せる新規観測は`Fact`と詳細への参照で構成する。型名を後続タスクで別名に置き換えない。

| ファイル | 役割 |
|---|---|
| `src/services/country_intel/types.ts` | 既存入力/出力に追加フィールド、共通Zodスキーマ |
| 新規`detail.ts` | 詳細レコード・本文ブロック・ページング・参照解決 |
| 新規`provider_http.ts`、`freshness.ts` | 通信上限・応答分類・配信時刻と鮮度 |
| 新規`collector.ts` | 定期収集、単一実行制御、再開・状態更新 |
| `providers/gdacs.ts`、`providers/gdelt*.ts` | 既存接続の修復と履歴取込 |
| 新規`providers/feeds.ts`、`usgs.ts`、`eonet.ts` | 国際RSS/Atomと災害補完 |
| `providers/official_web.ts` | 記事単位の詳細取得、探索依存の一般化 |
| 新規`providers/bluesky.ts` | 任意の公開ライブ情報。無効時は接続しない |
| 新規`source_catalog.ts` | 公式・報道等のsource設定と対応分野 |
| `db.ts`、`migrations.ts`、`maintenance.ts` | 詳細保存、取得状態、差分、保存期限 |
| `report.ts`、`context.ts`、`query_planner.ts` | 具体的資料を含むレポートと分野別取得 |
| `src/services/intelligence/domains/*` | 分野別の資料・不足情報のビュー |
| `src/mcp.ts`、`src/routes/intelligence.ts`、`src/types.ts` | MCP/REST/OpenAPI共通契約 |

## Task 1: SQLiteの永続化と実データ回帰試験の基盤

**Files:** Modify `src/services/country_intel/{migrations,db,maintenance}.ts`; Test `db.test.ts`, `maintenance.test.ts`; Create `fixtures/live-contracts/*.json`、`fixtures/live-contracts/*.xml`。

**Interfaces:** 既存`saveCountryContext`を維持。`saveEvidenceDetails(contextId: string, details: EvidenceDetail[]): void`、`getEvidenceDetails(contextId: string, ids: string[]): EvidenceDetail[]`を追加。詳細をcontextに紐付ける関連表を作る。テストは既存`db.test.ts`の一時DB用beforeEach/afterEachを使用する。各コード例の`test/expect`は`bun:test`から、製品関数は本タスクの対象ファイルからimportする。

- [ ] 稼働コンテナの現在DBをバックアップする手順を確定する。調査時点では`/app/data/sora.db`、永続マウントは`/data`で不一致。書込みを一時停止した保守区間でSQLiteの`VACUUM INTO`により`/data/sora-migrate.db`を作り、quick_check・テーブル件数を比較後に`/data/sora.db`へ切り替える。稼働中のDBファイルだけを`cp`しない。旧ファイルとバックアップを残す。
- [ ] 下記テストを追加し、現行実装で失敗することを確認する。

```ts
test('relative container database outside the data volume is reported', () => {
  expect(ephemeralDbWarning('./data/sora.db')).toBeDefined();
});
test('detail remains available after report persistence and reopening', async () => {
  const report = await researchCountryContext({region:'CN'}, {providers:[], cache:null});
  const evidence = normalizeEvidence({url:'https://example.org/report/1',title:'Cancellation',sourceType:'official',primarySource:true,latencyClass:'near_realtime'},report.region,new Date('2026-09-22T00:00:00Z'));
  report.evidence = [evidence];
  saveCountryContext(report, {evidence:[evidence]});
  const details: EvidenceDetail[] = [{
    evidenceId:evidence.id, providerId:'fixture', providerItemId:'1',
    sourceRecordUrl:'https://example.org/report/1', contentKind:'excerpt',
    blocks:[{index:0,text:'The event has been cancelled.'}],
    retrievedAt:'2026-09-22T00:00:00Z', timeBasis:'retrieved', geographyBasis:'unknown',
    sourceStatus:'unverified', contentTruncated:false,
  }];
  saveEvidenceDetails(report.contextId, details);
  closeDb();
  expect(getEvidenceDetails(report.contextId, [evidence.id])).toEqual(details);
});
```

- [ ] GDACS APIの`url.report`・`affectedcountries`・RSS名前空間、GDELTの実TSV列数とエラー本文を小さなfixtureとして保存する。取得URL・日時・形式・期待する国/項目IDを付記する。投稿全文や認証情報をfixtureへ含めない。
- [ ] migration 3で詳細JSON、contextとevidenceの関連、source状態、差分履歴、取込区間を追加する。migration 1/2を書き換えない。外部HTTP待機中にDBトランザクションを保持しない。
- [ ] `bun test src/services/country_intel/db.test.ts src/services/country_intel/maintenance.test.ts`を実行。再接続、旧レポート読出し、二重migration、ディスク書込み失敗の分類を確認する。
- [ ] 実装時のデプロイ設定では`SORA_DB_PATH=/data/sora.db`と名前付きvolumeを指定する。実際の移行・再起動はTask 12でfetcherだけに適用する。

## Task 2: 通信制御と鮮度を正しく測る

**Files:** Create `provider_http.ts`, `freshness.ts`, `provider_http.test.ts`, `freshness.test.ts`; Modify `provider_registry.ts`, `report.ts`, `types.ts`。

**Interfaces:** `fetchProviderResponse(url: string, options: { signal: AbortSignal; sourceId: string; timeoutMs: number; format: 'json'|'xml'|'text' }): Promise<Response>`。`classifyFreshness(state: SourceState, now: number, maxAgeMs: number): DataState`。

- [ ] 偽時計と注入fetchで、正常応答15.6秒、429のRetry-After有無、304、200 HTML、204、ネットワーク障害、タイムアウトを再現する。実時間15秒待つ単体テストにしない。

```ts
test('unknown update time is not converted into fresh publication', () => {
  expect(classifyFreshness({ sourceId: 'feed' }, Date.now(), 60_000)).toBe('unknown');
});
test('future observation timestamp is explicit', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  expect(classifyFreshness({sourceId:'gdelt', providerUpdatedAt:'2026-09-22T00:15:00Z'}, now, 60_000))
    .toBe('clock_anomaly');
});
```

- [ ] `report.ts`の`now: () => nowDate.getTime()`を廃止し、レポートのasOfと通信の経過時間を別の時計にする。unit testでは注入時計で測る。
- [ ] GDELTホスト単位6秒以上、全HTTP並列4、記事並列2を適用する。429待機は提供側指定または30秒→最大5分。1要求内の即時連打をしない。複数MCPセッションからの同じ取得を共有する。
- [ ] Content-Type不一致時は登録済み固定sourceに限定して期待形式を検証する。EONETのJSON本文/RSSヘッダーは受け入れ、HTMLエラーページをJSON成功にしない。XMLはDTD/外部参照を拒否する。
- [ ] `ProviderRun`にHTTP状態・正規化エラー・取得/解析/採用/除外件数、lastSuccess、期間不足を追加する。提供元のエラー本文は長さ制限・秘密情報除去後の診断だけに使う。
- [ ] `bun test src/services/country_intel/provider_http.test.ts src/services/country_intel/freshness.test.ts src/services/country_intel/provider_registry.test.ts`を実行する。

## Task 3: GDACSのAPI/RSS/GeoJSON修復

**Files:** Modify `providers/gdacs.ts`; Create `providers/gdacs_live_contract.test.ts`; Task 1で`fixtures/live-contracts/gdacs-api-multicountry.json`を作成する。被災国配列の2番目以降にCNを含む実レコード1件を保存し、本文とパーサーの相違を固定する。

**Interfaces:** `parseGdacsApi(raw: unknown, input: ProviderInput): AcquisitionItem[]`、`parseGdacsFeed(xml: string, input: ProviderInput): AcquisitionItem[]`。旧`parseGdacsResponse`は互換wrapperとして残せる。`AcquisitionItem`へ任意の`detail: EvidenceDetail`を追加する。

- [ ] 実API fixtureを旧パーサーへ入れ、`Invalid URL`を再現する。複数国の災害、ISO2/ISO3、欠損URL、APIとRSSの重複をテストする。

```ts
test('an affected country is retained even when it is not the first country', async () => {
  const multiCountryFixture = await Bun.file(new URL('../fixtures/live-contracts/gdacs-api-multicountry.json', import.meta.url)).json();
  const chinaInput: ProviderInput = {request:{region:'CN'}, region:{id:'country:CN',name:'China',countryCode:'CN',languages:[],aliases:[],confidence:'high'},queries:[]};
  const items = parseGdacsApi(multiCountryFixture, chinaInput);
  expect(items.length).toBeGreaterThan(0);
  expect(items[0].evidence?.url).toBe(multiCountryFixture.features[0].properties.url.report);
  expect(items[0].detail?.structuredData?.affectedCountryCodes).toContain('CN');
});
```

- [ ] URLは`url.report`、GeoJSONの`link[Key=web]`、RSSのlinkから取得。`name/description`、alertlevel、severitydata、geometry、affectedcountries、発生/終了/更新日時を保持する。
- [ ] `eventtype + eventid + episodeid`をレコードキーにし、eventとepisodeを混同しない。RSSとAPIの同一記録は同一根拠に統合し、独立ソース数を増やさない。
- [ ] RSSを速報の基本経路、APIを履歴・詳細に使用する。API検索は公式の`eventlist/fromDate/toDate/pageSize/pageNumber`を使い、国パラメーターの動作をライブで確認できるまで根拠なくISO2/ISO3を決め打ちしない。取得後の被災国配列照合は常に行う。
- [ ] 古い発生・最近の更新・終了/解除・境界日付を区別する。severityの欠損を0にしない。未知国は除外理由と件数を残す。
- [ ] `bun test src/services/country_intel/providers/gdacs_live_contract.test.ts src/services/country_intel/provider_scope.test.ts`を実行する。

## Task 4: GDELT Events/Mentions履歴とDOC検索

**Files:** Modify `providers/gdelt.ts`, `providers/gdelt_events.ts`, `geo_codes.ts`; Create `providers/gdelt_files.ts`, `providers/gdelt_files.test.ts`; Modify `db.ts`, `migrations.ts`。

**Interfaces:** `parseGdeltExport(tsv: string): GdeltEventRow[]`、`collectGdeltWindow(window: CollectionWindow, signal: AbortSignal): Promise<CollectionWindow>`。ファイルURL、サイズ、ハッシュ、処理状態をSQLiteへ記録する。

- [ ] 61列TSVの実fixtureで発生国・Actorの国・CAMEO分類・source URLを検証する。`Actor1CountryCode`はCAMEO、`ActionGeo_CountryCode`はFIPSとして別々に扱う。

```ts
test('export schema uses the real ActionGeo country column', async () => {
  const realExportFixture = await Bun.file(new URL('../fixtures/live-contracts/gdelt-export.tsv', import.meta.url)).text();
  const rows = parseGdeltExport(realExportFixture);
  expect(rows[0].ActionGeo_CountryCode).toBe('CH');
  expect(rows[0].SOURCEURL).toMatch(/^https?:\/\//);
});
```

- [ ] Task 1の`gdelt-export.tsv`はActionGeoがCHの実レコードを先頭に置き、末尾URLまでの61列を保持する。履歴試験はHTTPをfixtureへ差し替え、最新1ファイルしか成功しない30日要求で`complete:false`と29日以上のgapが返ることを検証する。404/破損ファイル区間も同様に残す。

- [ ] 404のEvents JSON URLを廃止し、公式更新一覧→ZIP→TSVを取り込む。ダウンロード先は公式host/pathのみ、圧縮50MiB・展開200MiB上限、想定列数/行長/ハッシュ不一致はparse_error。ファイル名の文字列をシェルに渡さない。
- [ ] ZIPの展開は利用中BunでのZIP対応を検証する。未対応なら`unzip`のシェル外引数配列起動をビルドに明示して標準入力から処理する。ZIP仕様の独自再実装をしない。新依存が必要なら小さな既存ライブラリ1個を選び、その理由とサイズをレビュー対象にする。
- [ ] 初回1h/24hを優先し、7/30/90dは取得区間・欠損・進捗を保持する。取込並列2、1回のworkerで最大32ファイルまたは60秒。続きは次tick。要求経路で履歴全体をダウンロードしない。
- [ ] EventsとMentionsを区別する。Mentions未取込期間の報道量指標を完全として返さない。GDELT文章分類は観測データとしてラベル付けし、法的・外交的事実を確定しない。
- [ ] DOCは期間を支持し、分野別queryを最大4件まで実行。記事URL・見出し・seen日時を返し、公表日時は本文から確認した場合のみ設定する。
- [ ] `TimelineVol`の割合と`TimelineVolRaw`の件数を別metricとし、既存baselineに単位の違う値を混ぜない。
- [ ] `bun test src/services/country_intel/providers/gdelt_files.test.ts src/services/country_intel/geo_codes.test.ts src/services/country_intel/metric_builder.test.ts`を実行する。

## Task 5: 国際フィードと補完災害API

**Files:** Create `providers/feeds.ts`, `providers/usgs.ts`, `providers/eonet.ts`, `source_catalog.ts`, `providers/global_feeds.test.ts`; Modify `source_registry.ts`, `runtime.ts`。

**Interfaces:** `parseFeed(xml: string, sourceId: string): EvidenceDetail[]`。source設定は`id,url,publisher,languages,areas,geographicScope,verificationBasis,pollIntervalMs,contentPolicy`を保持。コード内の国別分岐にしない。

- [ ] RSS2/Atom/RDF、CDATA、記事更新、欠損公表時刻、リンク不正、本文の否定、ドイツ語・中国語・アラビア語をfixtureで検証する。

```ts
test('unclassified non-English evidence remains retrievable', () => {
  const arabicFeedFixture = '<rss version="2.0"><channel><language>ar</language><item><guid>1</guid><title>تحديث رسمي</title><link>https://example.org/notice</link><description>تم تحديث مواعيد الزيارة.</description></item></channel></rss>';
  const details = parseFeed(arabicFeedFixture, 'regional-source');
  expect(details[0].language).toBe('ar');
  expect(details[0].blocks.length).toBeGreaterThan(0);
  expect(details[0].geographyBasis).toBe('unknown');
});
```

- [ ] 初期catalogに接続確認済みBBC World、UN News、ECB、DWを登録する。配信元のcoverageと対象国のcoverageを区別する。WHOの古いRSSはhealthの速報カバレッジ達成に数えない。アクセス禁止源はblockedとして記録する。
- [ ] 追加の地域source探索は既存Wikidata providerが発見した公式URLと検証済みsourceを入口とする。RSS/Atomの`link rel=alternate`、同一公式domainのsitemap、機関からの相互リンクを取得し、source_catalogへ候補として保存する。候補の地域・言語・機関種別・確認根拠を保持する。観光庁、交通機関、保健当局、中央銀行、選管などのroleを設定データで扱い、国名に応じたコード分岐を追加しない。発見できなかったroleをcoverageへ明示する。
- [ ] USGSは発生時刻と更新時刻・規模・深度・津波フラグ・詳細URLを保持する。座標だけで中国等へ自動帰属しない。既存の国コードがない場合は座標を返し、地理照合未実装を明示する。
- [ ] EONETは日付付きgeometryとsourcesを保持する。GDACS由来のEONET情報を別の独立証拠として数えない。JSON本文/RSSヘッダーfixtureを含める。
- [ ] 30日分がないRSSを30日完全としない。公式source候補は資料を残したままunverifiedとし、availabilityだけでverifiedにしない。
- [ ] `bun test src/services/country_intel/providers/global_feeds.test.ts src/services/country_intel/evidence.test.ts`を実行する。

## Task 6: 記事単位の詳細本文と統計・カレンダーの復元

**Files:** Modify `providers/official_web.ts`, `providers/worldbank.ts`, `providers/nager.ts`, `detail.ts`; Create `providers/details.test.ts`; Modify `provider_registry.ts`。

**Interfaces:** Web依存を`searchWeb(query, maxItems, signal)`へ一般化する。`scrapeArticle(url: string, signal: AbortSignal): Promise<EvidenceDetail>`は既存スクレイパーを呼ぶ。標準の探索実装は、Task 5の公式feed/sitemapと保存済み記事索引を検索し、ニュース検索にはGDELT DOCを使用する。汎用Web検索APIは構成済みの場合だけ追加できる注入依存とし、接続できたと見せかける空実装を置かない。標準経路にYahoo Web/Realtimeの依存を新設しない。

- [ ] 検索結果の記事URLを取得すること、トップページを代用しないこと、取得失敗時に見出し・抜粋が残ることをspyで固定する。

```ts
test('article scraping uses the discovered article rather than its homepage', async () => {
  const calls: string[] = [];
  const provider = createOfficialWebProvider({
    searchWeb:async()=>[{url:'https://example.org/news/update-123',title:'Official update'}],
    scrapeUrl:async(url)=>{calls.push(url);return {markdown:'The opening time changed.',title:'Official update'};},
    verifiedDomains:['example.org'],
  });
  const input: ProviderInput = {request:{region:'CN'},region:{id:'country:CN',name:'China',countryCode:'CN',languages:[],aliases:[],confidence:'high'},queries:[{pass:2,providerId:'official_web',query:'site:example.org update',topics:[],maxItems:10,sourceDomain:'example.org'}]};
  await provider.run(input, new AbortController().signal);
  expect(calls).toContain('https://example.org/news/update-123');
  expect(calls).not.toContain('https://example.org/');
});
```

- [ ] Readabilityで本文・見出し・段落を保持し、ページ末尾まで含む全文と抜粋を区別する。段落番号と切詰め状態を付ける。二次リンクを無制限に辿らない。最大12記事/refresh、本文並列2、1記事15秒。
- [ ] World Bankの`NY.GDP.MKTP.CD`、`NY.GDP.MKTP.KD.ZG`、`FP.CPI.TOTL.ZG`、`SL.UEM.TOTL.ZS`、`SP.POP.TOTL`、`NE.TRD.GNFS.ZS`を初期指標にする。指標メタデータで名称・単位・sourceを確認する。対象年は現在年から過去10年、null年を0にしない。前年比較には同じ単位・指標を使用する。
- [ ] 旧`temporalMetrics.current`を残し、詳細に全取得系列・年度・単位・出典URLを保持する。evidenceとmetricを結び付ける。
- [ ] 祝日の`localName/name/date/types/global/counties/sourceUrl`を保持し、地方限定・任意休日を全国の法定休日として扱わない。過去期間と将来予定を分け、複数年にまたがる要求に対応する。
- [ ] `bun test src/services/country_intel/providers/details.test.ts src/services/country_intel/providers/providers.test.ts`を実行する。

## Task 7: 定期収集・差分・リカバリ

**Files:** Create `collector.ts`, `collector.test.ts`; Modify `db.ts`, `maintenance.ts`, `src/index.ts`, `src/stdio.ts`。

**Interfaces:** `startCountryCollector(): { stop(): Promise<void> }`、`refreshCountrySources(request: CountryContextRequest): Promise<{ refreshId: string; state: 'complete'|'partial'|'pending' }>`。DBに`readSourceState(sourceId: string): SourceState`、`writeSourceState(state: SourceState): void`を追加。テスト可能な一回処理を`collectSourceOnce(sourceId: string, collect: () => Promise<{cursor: string; details: EvidenceDetail[]}>): Promise<void>`として切り出し、失敗時はlastErrorを保存してrejectする。APIとstdioが同じDBを使う場合はDB leaseで単一collectorだけ動かす。

- [ ] 再起動で同じ記事が重複しないこと、期限切れleaseを引継ぐこと、取得失敗でcursorを進めないことを検証する。

```ts
test('failed batch keeps the durable source cursor', async () => {
  writeSourceState({sourceId:'gdelt',cursor:'file-1'});
  const before = readSourceState('gdelt');
  await expect(collectSourceOnce('gdelt', async()=>{throw new Error('download failed');})).rejects.toThrow('download failed');
  expect(readSourceState('gdelt').cursor).toBe(before.cursor);
});
```

- [ ] sourceごとのETag/Last-Modified、checkedAt、成功時刻、retryAt、カーソル、取込区間を保存する。304は接続確認のみ更新する。
- [ ] 追加・訂正・削除をstable provider keyで差分化する。evidence IDが変わる変更は旧IDと新IDの関連を残す。レポートのスナップショットと最新の訂正状態を分離する。
- [ ] 背景収集はactiveな監視対象sourceから開始し、要求がない全世界データを無制限保存しない。GDELTのグローバル配信は一度解析し監視地域の必要レコードを索引化する。監視外だった期間は後から完全扱いしない。
- [ ] 保存上限は初期2GiB、レポート90日・原文/根拠180日を基準とする。source別利用条件が短ければ優先する。削除時に有効なレポート参照を壊さず、本文期限切れを明示する。
- [ ] `bun test src/services/country_intel/collector.test.ts src/services/country_intel/maintenance.test.ts`を実行する。

## Task 8: 多分野の具体的な資料と不足情報

**Files:** Modify `query_planner.ts`, `event_extract.ts`, `context.ts`, `report.ts`, `src/services/intelligence/domains/{content,marketing,travel,finance}.ts`; Create `src/services/intelligence/domains/tourism.ts`, `src/services/country_intel/domain_details.test.ts`。

**Interfaces:** `buildDomainContext(domain: Domain, facts: Fact[], limitations: Limitation[]): { domain: Domain; factors: Fact[]; missingInformation: Limitation[] }`。既存の`domains`は残し、新詳細は`domainContext`に入れる。

- [ ] SNS投稿・金融・旅行・観光の利用例で、件数以外の本文・時刻・出典が返るテストを先に書く。

```ts
test('posting context contains an official cancellation and missing context', () => {
  const fact: Fact = {id:'f1',topic:'cancellations',text:'The festival has been cancelled.',basis:'source_excerpt',evidenceIds:['official-cancellation']};
  const limitation = {code:'posting_context_missing',area:'content',message:'投稿本文と予定日時が未指定です。',evidenceIds:[]};
  const view = buildDomainContext('content', [fact], [limitation]);
  expect(view.factors[0].text).toContain('cancelled');
  expect(view.factors[0].evidenceIds).toContain('official-cancellation');
  expect(view.missingInformation[0].code).toBe('posting_context_missing');
});
```

- [ ] 全分野指定でも単一ANDクエリにまとめない。base地域・自由query・分野を保ち、global news / official / structuredの取得枠を分ける。Task 2の総上限内でローテーションし、今回未検索の分野を明示する。
- [ ] 構造化sourceのevent type・日付・被災国を優先する。正規表現は補助分類としてbasisを記録し、未分類の本文を落とさない。対象国・投稿者国・出版国・言及国を混ぜない。
- [ ] 固定で空だったhealth/calendarを取得済み資料と結ぶ。外部データがなければmissingInformationを付ける。公表停止の解除情報や訂正を関連付ける。
- [ ] coverageは取得成功件数だけでなく、要求分野・期間・地理・鮮度・独立source・解析能力で評価する。構造化統計とcalendarの根拠も数える。全滅時は`limited`と理由を返し、安全判断に変換しない。
- [ ] `bun test src/services/country_intel/domain_details.test.ts src/services/country_intel/situation.test.ts src/services/country_intel/acquisition_provenance.test.ts`を実行する。

## Task 9: 詳細ページと一貫したレポート

**Files:** Modify `detail.ts`, `types.ts`, `report.ts`, `db.ts`; Create `detail.test.ts`, `report_v2.test.ts`。

**Interfaces:** `getEvidencePage(contextId: string, options: {ids?: string[]; cursor?: string; limit?: number}): EvidencePage`。`getContextUpdates(contextId: string, cursor?: string)`は`{contextId, changes, nextCursor, limitations}`を返す。

- [ ] 初回40件上限・次ページ・本文ブロックの続き・stable order・別contextのID・改ざんcursor・期限切れ本文をテストする。

```ts
test('every stored record can be reached through evidence pages', async () => {
  const report = await researchCountryContext({region:'CN'}, {providers:[],cache:null});
  const evidence = Array.from({length:61}, (_,i)=>normalizeEvidence({url:`https://example.org/${i}`,title:`Notice ${i}`,sourceType:'official',primarySource:true,latencyClass:'near_realtime'}, report.region,new Date('2026-09-22T00:00:00Z')));
  report.evidence = evidence;
  saveCountryContext(report, {evidence});
  const details: EvidenceDetail[] = Array.from({length:61}, (_,i)=>({
    evidenceId:evidence[i].id,providerId:'fixture',providerItemId:String(i),sourceRecordUrl:`https://example.org/${i}`,
    contentKind:'excerpt',blocks:[{index:0,text:`Notice number ${i}`}],retrievedAt:'2026-09-22T00:00:00Z',
    timeBasis:'retrieved',geographyBasis:'unknown',sourceStatus:'unverified',contentTruncated:false,
  }));
  saveEvidenceDetails(report.contextId, details);
  const first = getEvidencePage(report.contextId, {limit:40});
  const second = getEvidencePage(report.contextId, {cursor:first.nextCursor, limit:40});
  const ids = [...first.items, ...second.items].map(x => x.evidenceId);
  expect(new Set(ids).size).toBe(61);
  expect(second.nextCursor).toBeUndefined();
});
```

- [ ] cursorはcontextId、snapshot version、sort key、offset、expiryを含む不透明トークンとし、現在contextと照合する。未来の追加取得で途中ページの順序を変えない。
- [ ] 初回は分野別の代表資料を含め、特定sourceだけで枠を埋めない。128KiB目標を超える場合は本文ブロックをページへ移し、その理由と続き参照を付ける。初回に数値だけ残す圧縮は禁止する。
- [ ] `actualWindows`、`acquisitionTruncated`、`refreshState`とIDを追加する。pending終了後は旧snapshotを変更せず、新contextIdへ関連付ける。欠測解消を差分として返す。
- [ ] 全provider失敗でも保存資料がある場合は、その取得時刻とstale状態を返す。資料もなければ空配列と失敗理由を返し、`complete`/`good`を捏造しない。
- [ ] `bun test src/services/country_intel/detail.test.ts src/services/country_intel/report_v2.test.ts src/services/country_intel/report.test.ts`を実行する。

## Task 10: MCP・REST・APIドキュメントの統一

**Files:** Modify `src/mcp.ts`, `src/routes/intelligence.ts`, `src/types.ts`, `README.md`, `RELEASE_NOTES.md`; Modify `src/services/country_intel/{rest,mcp_parity,runtime}.test.ts`; Create `mcp_details.test.ts`。

**Interfaces:** 設計書§5.4の4ツールを`intel`に登録。RESTは既存2経路に加え`GET /intelligence/context/:contextId/evidence`と`GET /intelligence/context/:contextId/updates`を追加する。

- [ ] MCP実接続テストで`search_tools`→4ツール公開→tool call→structuredContent検証→詳細次ページ→差分を通す。`default.`別名でも同じ結果にする。

接続試験では`Client`を`@modelcontextprotocol/sdk/client/index.js`、`InMemoryTransport`を`@modelcontextprotocol/sdk/inMemory.js`からimportする。`createMcpServer`に任意の`intelResearch: typeof researchCountryContext`注入を追加し、通常の実行時は既存default runtimeを使う。テスト時だけ実ネットワークのないfixtureを注入する。

```ts
test('MCP text and structured result expose the same evidence', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({modules:['intel'],deferTools:false,intelResearch:async request =>
    researchCountryContext(request, {cache:null,providers:[{
      id:'fixture',areas:['current_events'],latencyClass:'near_realtime',defaultTtlSeconds:60,
      async run(input) { return {items:[{evidence:normalizeEvidence({url:'https://example.org/notice',title:'An official update',excerpt:'Opening times have changed.',sourceType:'official',primarySource:true,latencyClass:'near_realtime'},input.region,new Date('2026-09-22T00:00:00Z'))}]}; },
    }]})});
  const client = new Client({name:'intel-test',version:'1.0.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({name:'research_country_context', arguments:{region:'CN'}});
    const text = result.content.find(x => x.type === 'text');
    expect(JSON.parse(text.text)).toEqual(result.structuredContent);
    expect(result.structuredContent.evidence.length).toBeGreaterThan(0);
  } finally { await client.close(); await server.close(); }
});
```

- [ ] MCP SDKの既存`registerTool`helperに任意outputSchemaを追加し、新intel toolsだけ構造化出力へ移行する。SDKのinstalled型を使い、他カテゴリの登録を一斉に変更しない。
- [ ] MCP/REST両方で同一CountryContextRequestSchemaを使う。`includeSocial`のYahoo説明を除去し、取得可能範囲と不足情報を説明する。ツール説明400文字以内という既存contractがあれば維持し、詳細は出力スキーマのdescribeとREADMEへ記載する。
- [ ] 戻り値に`content`のJSONと同一objectの`structuredContent`を入れる。フロントエンドで一方しか扱わない場合も必要情報が欠けないよう確認する。外部資料中の命令文は原資料として隔離し、ツール実行指示へ昇格させない。
- [ ] README/OpenAPIに詳細例、部分成功、速報と年次統計の違い、ページング、更新差分、設定が必要なprovider、Yahoo不使用を明記する。未実装機能をrelease機能として記載しない。
- [ ] `bun test src/services/country_intel/mcp_details.test.ts src/services/country_intel/mcp_parity.test.ts src/services/country_intel/rest.test.ts`を実行する。

## Task 11: 任意のBlueskyライブ情報

**Files:** Create `providers/bluesky.ts`, `providers/bluesky.test.ts`; Modify `collector.ts`, `source_catalog.ts`, `runtime.ts`。

**Interfaces:** `startBlueskyCollection(options: {dids: string[]; onRecord: (detail: EvidenceDetail) => Promise<void>}): {stop(): void}`、`parseBlueskyEvent(envelope: unknown, retrievedAt: string): EvidenceDetail | undefined`。`includeSocial:false`時は接続しない。source設定がなければ`not_configured`を返す。

- [ ] v2の`payload`形式、create/update/delete、identity/account、再接続、カーソルの欠測をfixtureで検証する。v1の`time_us`とv2のseq/cursorを取り違えない。

```ts
test('language does not establish the event country', () => {
  const envelope = {$type:'message',payload:{$type:'network.bsky.jetstream.subscribeEvents#commit',did:'did:plc:example',seq:1,time:'2026-09-22T00:00:00Z',operation:'create',collection:'app.bsky.feed.post',rkey:'example',record:{$type:'app.bsky.feed.post',createdAt:'2026-09-22T00:00:00Z',text:'New update',langs:['en']}}};
  const result = parseBlueskyEvent(envelope, '2026-09-22T00:00:01Z');
  expect(result?.geographyBasis).toBe('unknown');
});
```

- [ ] native WebSocketで公式v2 endpointに`xrpc.v1.json`を指定する。監視DID・collectionを設定し、最大接続1本、受信1MiB/メッセージ上限、保存キュー1,000件を初期値にする。満杯時は欠測記録とバックオフを行い、無限メモリ増加を防ぐ。
- [ ] 要求由来の監視は最後の利用から30分で停止する。運用者が明示設定した常時監視だけ継続する。`includeSocial:false`のレポートには既存のSNS保存資料も混入させない。
- [ ] 投稿の原文・URL・投稿日時・観測日時・削除/訂正を保持する。削除後の本文取得は不可として状態を返し、旧レポートから原文を無条件で復活させない。
- [ ] 国別過去検索が403だった今回の観測を踏まえ、検索APIを必須依存にしない。事前収集していない期間はunavailableとする。ライブ成功をXや他SNSの取得保証に置き換えない。
- [ ] `bun test src/services/country_intel/providers/bluesky.test.ts`を実行する。Task 1～10はBluesky無効でも完成・リリース可能にする。

## Task 12: 実通信・性能・回帰・fetcher更新

**Files:** Modify `live_smoke.ts`, `package.json`, `README.md`, `RELEASE_NOTES.md`; Create `live_probe.ts`, `performance.test.ts`。配備設定は実際の`/home/ikeno/app/modules/rootless-containers.nix`のfetcher部分だけを対象とする。

- [ ] 計画作成時の証拠と本番実装後の測定結果を分ける。保存済みfixtureの試験をネットワーク成功の代わりにしない。`live_smoke.ts`に残るKOR/KRの古い期待値も現行契約へ合わせる。
- [ ] 国・言語の受入試験はCN、DE、BR、EG、ID、US、JPの7地域。Yahoo不使用をspyで検証し、各地域で取得できた分野・言語・期間・sourceを表にする。全地域全分野の充足を件数だけで合格にしない。
- [ ] ライブ必須経路はGDACS RSS、GDELT配信、USGS、少なくとも2つの報道/公式feed。GDELT DOCの429は適切な部分成功を合格条件とし、DOCによる記事取得成功は別途実績を記録する。任意SNSは無効時と接続時を分ける。
- [ ] レポート→MCP→詳細ページ→差分までの通し試験を実施する。時間を固定したfixtureで「災害中の販促投稿」「祝祭日と観光」「年次統計と金融速報」「ストライキと旅行」を検証する。LLMの判断品質はこのデータ試験だけでは保証せず、実際の呼出元LLMによる根拠引用・不足情報認識・追加取得を受入評価する。
- [ ] 性能測定はウォームアップ5回後30回、同時1/5/10要求、同じDBスナップショットで実施する。ウォームp95 2秒以内、coldはmaxWaitMs+2秒以内、取得処理の並列上限遵守を目標にする。外部通信遅延・JSON byte数・RSS・CPU・DB/WALサイズ・provider別レコード数・取得からMCP表示までの時間を保存する。未測定の目標を結果として記載しない。
- [ ] 既存X検索・scrape・MCP discoveryの回帰も実施する。既知失敗は同一基点との比較でのみ除外し、新規失敗を既知扱いしない。

```bash
bun test src/services/country_intel src/services/intelligence
bun test
bun run build
bun x tsc --noEmit
git diff --check
```

- [ ] レビューでは実fixture互換、国/期間/時刻、参照整合、長文欠落、既存API互換、永続DBを確認する。mainの最新差分を再確認して統合する。
- [ ] 更新依頼がある段階でfetcherイメージだけをビルドし、Task 1のDBバックアップ・永続化移行後に再作成する。実image ID・git SHA・DB実パス・volume・再起動後のレポート/詳細件数を照合する。他コンテナとNixOS全体を再起動しない。タグの付替えだけで更新完了にしない。

## 2. リリース単位と依存順

1. **修復と履歴保護:** Task 1→2→3。GDACS実データ互換、診断、永続化の準備。
2. **速報・詳細収集:** Task 4/5/6をTask 1/2の契約上で実装し、Task 7で接続。共通型変更は先に統合する。
3. **LLMへの詳細提供:** Task 8→9→10。初回詳細・続き・不足情報・差分。
4. **任意ライブSNS:** Task 11。Yahooを使わず、設定なしでも既存機能を継続。
5. **受入・更新:** Task 12。性能・実通信・README/API・DB移行・fetcherのみ更新。

## 3. 計画の自己レビュー

- 取得情報欠落: Task 3/5/6/8/9。元資料、原文、統計、予定、未分類を保持。
- リアルタイム/ライブ: Task 2/4/5/7/11。配信実測、更新日時、差分、欠測。
- GDELT/GDACS接続: Task 2/3/4。404・429・timeout・実形式・代替経路。
- Yahoo不使用: Task 5/10/11/12。runtimeと呼出回数で保証。
- 広範なLLM判断: Task 6/8/9/10。分野別資料と不足条件、参照可能な詳細。
- SQLite永続化: Task 1/7/12。実パス不一致を修正しバックアップ検証。
- 性能と既存互換: Task 2/7/9/10/12。期限、並列、続き取得、回帰。

本計画では製品コードを変更していません。実測の再現用スクリプトは同ディレクトリの`.probe.mjs`と`.social-probe.mjs`であり、製品機能ではありません。
