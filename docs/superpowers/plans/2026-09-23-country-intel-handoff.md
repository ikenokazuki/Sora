# 国・地域インテリジェンス機能 引き継ぎ指示書（2026-09-23）

## 0. 最初に読むこと

作業ディレクトリは `/home/ikeno/work/sora`。これは未コミット変更を含む作業ツリー。**`git reset`、`git clean`、一括復元、無断コミットをしない**。特に `src/services/country_intel/collector.ts` と同テストのステージ済み削除は、定期収集を外す従来作業の一部。まず `git status --short` と `git diff --stat`、必要なら `git diff --cached --stat` を確認する。現状の変更を土台に進める。

依頼の本質は、国・地域に関する汎用の情報収集器を**必要な時に一度呼ぶだけで、できる限り広く、根拠付きで取得する**こと。金融、マーケティング、旅行・観光、コンテンツ/SNS投稿判断などに共通利用する。特定用途向けの「投稿可否」判定器にしない。推奨やリスク点数は、取得レポートに勝手に混ぜない。対象は主要国全般。中国はインターネット環境の特殊さを検証する重要ケースだが、中国専用設計にしない。小国など取得困難な場合は、欠落を明示する。

ユーザーの追加条件:

- 国ごとの巨大なハードコード表で品質を作らない。共通の言語・地域解決、プロバイダー能力、実測に基づく追加で対応する。
- 初回のツール実行で広く取得する。追加調査は本ツールでも検索グラウンディングでもよいが、初回取得の不足を放置する口実にしない。
- 定期収集は不要。要求時に収集する。保存済みレポート・証拠の参照は必要。
- Yahooリアルタイムは日本語圏の投稿観測。世界共通のSNS標本として扱わない。
- APIやAI検索の結果は実際に試し、取得できた内容・鮮度・地理的関連性まで観測してから実装方針を決める。最小限の構成を優先する。
- 技術判断では運用、セキュリティ、信頼性、速度、費用、持続可能性を要件に応じて評価する。鍵・Cookie・WAF回避のための脆い裏技は採らない。

## 1. 現在の実装と入口

| 場所 | 役割 |
| --- | --- |
| `src/services/country_intel/runtime.ts` | 既定プロバイダーを明示登録。`researchCountryWithDefaults()` が REST/MCP 共通の実行口。スクレイピングの既定値と Yahoo のアダプターもここ。 |
| `src/services/country_intel/query_planner.ts` | プロバイダーごとの研究計画。 |
| `src/services/country_intel/providers/news_queries.ts` | Google/Bing 共通の分野別クエリ。ICU (`Intl.Locale`, `Intl.DisplayNames`) で地域名と言語を推定し、経済・政治・観光・感染症・災害・総合を検索。明示クエリ時は地域名との組み合わせ。 |
| `src/services/country_intel/providers/` | 独立した取得器。Google News RSS、Bing News RSS、GDELT、GDACS、国別 hot-list、Yahoo realtime など。 |
| `src/services/country_intel/provider_registry.ts` | プロバイダー型、独立実行、タイムアウト、キャッシュ、失敗分類、`gaps`。 |
| `src/services/country_intel/report.ts` | 取得結果の集約、地域との関連付け、本文補完、制約・欠落の計上、保存。既定の全体制限は29秒。 |
| `src/services/country_intel/region_link.ts` | 記事と対象国・地域の関連判定。出版社の国と記事の対象国は別物として扱う。 |
| `src/services/country_intel/domain_details.ts` | 分野別の証拠ビュー。 |
| `src/services/country_intel/response.ts` | 初回応答を代表証拠へ縮小。**収集・保存は全件**。`verbose: true` は全件。 |
| `src/services/country_intel/types.ts`, `detail.ts` | 入出力スキーマ、証拠と詳細型。 |
| `src/services/country_intel/db.ts`, `src/db.ts` | SQLite保存と証拠ページ取得。テスト時は `SORA_DB_PATH` でDBを分離する。 |
| `src/routes/intelligence.ts`, `src/mcp.ts` | REST と MCP の公開口。MCP は `research_country_context`、`get_country_context`、`get_country_context_evidence`。 |

REST は `POST /intelligence/country` で `{"region":"CN","noCache":true}` のように指定。`GET /intelligence/context/:contextId` は保存済み全件、`GET /intelligence/context/:contextId/evidence` は証拠ページ。MCPでは `research_country_context` が遅延登録のため、必要なら `search_tools` で「国地域」を有効化してから呼ぶ。APIの型は `CountryContextRequestSchema` と `CountryContextReportSchema` を正とする。

現時点の `Google News RSS` はほぼ見出しだけ。RSS description が見出しの繰り返しなら本文扱いしない。Google ラッパー URL を記事本文としてスクレイプしない。`Bing News RSS` は元の出版社記事URLと抜粋を取得できる。`zh-CN` 市場が空の場合、共通の `en-US` 市場へ再試行する。両者とも近7日の分野クエリを並列実行し、個別の空・疎な分野を `gaps` に残す。ニュース記事の `publishedAt` と取得時刻を混同しない。

初回応答は `response.ts` で一般24件、各専門分野8件などの代表証拠を選ぶ。完全レポートは保存され、`contextId` で再取得できる。代表証拠があるという事実だけで、その分野の調査が十分だとは判定しない。

## 2. 実測結果と限界

2026-09-23、当該サーバーのライブ実験。以下の「関連」は `direct` または `related` 判定の証拠件数であり、独立した出来事の数でも網羅率でもない。JP/US/FR/DE/BR/IDの最終実行は `SORA_INTEL_SCRAPE=off`、CN/INは本文補完あり。結果はニュース状況・検索上流・出口IPで変わるため、再実験時は日付・設定を記録する。

| 国 | 関連証拠 | Google | Bing | 初回応答サイズ | 実行時間 |
| --- | ---: | ---: | ---: | ---: | ---: |
| JP | 140 | 53 | 43 | 約382 KB | 約4.6秒 |
| US | 202 | 39 | 32 | 約259 KB | 約3.9秒 |
| FR | 107 | 57 | 26 | 約251 KB | 約4.5秒 |
| CN | 199 | 49 | 56 | 約422 KB | 約20秒 |
| DE | 71 | 40 | 23 | 約207 KB | 約4.0秒 |
| IN | 125 | 50 | 28 | 約325 KB | 約8.4秒 |
| BR | 89 | 57 | 28 | 約239 KB | 約4.0秒 |
| ID | 89 | 44 | 30 | 約235 KB | 約3.7秒 |

ニュース取得の単体ライブ確認は JP/US/FR/CN/DE/IN/BR/ID/KR/ES/SA/RU の12か国で実施。Google は国別に68～72件、Bing は36～60件を返した。この件数は良質な記事数ではない。8か国とも代表枠を埋めたが、**多様性・地理的正確さ・判断可能性は未証明**。同じ8か国で確認できた Google/Bing 関連記事の出版社名・ドメインは JP66、US53、FR60、CN63、DE41、IN35、BR62、ID54。資本関係まで含めた独立性は未評価。

確認済みの重要な不足:

- `official_web` は多くの非日本国で0件だが、プロバイダー状態が成功となる場合がある。Google/Bing/GDELTがあるため即座にゼロ情報にはならないが、情報源の偏りは残る。
- 2026-09-23のJP再実験では、中国専用プロバイダー7件が `PROVIDER_REGION_UNSUPPORTED` として走査表に載り、`provider_unavailable` 制約も7件表示された。仕様上の「対象外」を「障害」と誤認させていないか、表示を検討する。
- Google は見出し中心。Bing には抜粋がある。本文補完は予算・ブロックのため少数（過去の実測では約4～11件）。その差をレポート上でも維持する。
- 非中国国の `recentContext.topics` に現地の hot-list が網羅されているわけではない。`includeSocial: true` の日本では Yahoo の日本語圏投稿約30件を取得できた。その他の国のSNSは Bluesky が0件のケースもあり、世界SNSをカバーしているとは言えない。
- 中国の Weibo 直接 `hotSearch` は当該環境で403、`m.weibo.cn` API/HTMLは302。NewsNow ミラー経由の Weibo 熱搜は取得できるが、これはランキング・話題であり任意キーワードの投稿全文検索ではない。Zhihu/Toutiao/CCTV/ThePaper/Wallstreet は到達。Baidu hot と so360 は当該出口で失敗。詳細は `docs/superpowers/plans/2026-09-23-cn-live-matrix.md`。
- 中国の Bing News は `zh-CN` 市場だと空で、中国語クエリ＋`en-US` 市場なら取得できた。Bing のRSSは非公式・変更リスクあり。`gaps` と代替経路を維持する。
- TypeScript の独立した厳格型検査は未実施。`npx --no-install tsc --noEmit` はこの環境では実行不能だった。Bun テストとビルドは実行可能。
- デプロイ、サービス再起動、Nix反映はこの作業では未実施。作業ツリーの検証と本番挙動を混同しない。
- 2026-09-23夜の再計測（サンドボックス外の通信経路、`SORA_INTEL_SCRAPE=off`、`noCache: true`）。関連証拠は JP157/US104/FR112/CN193/DE96/IN110/BR112/ID93/KR106/ES104/SA33/RU63。CNは google48・bing54・weibo_hot5（ミラー経由）・zhihu2・cctv8、baiduはタイムアウト、so360は取得失敗。SAは google関連が3件のみで薄い（要因未切り分け）。worldbankはKR/ES/SA/RUでタイムアウト、nagerはIN/SAで5xx、wiki系はES/SA/RUでレート制限。いずれも上流側の一時的な失敗で、コード起因ではない。
- 上記再計測で、非CN国の全件に中国専用7件＋yahoo計8件の `provider_unavailable` が載る表示ノイズを再確認。`src/services/country_intel/report.ts` を修正し、`PROVIDER_REGION_UNSUPPORTED` の実行は欠落コード `provider_region_unsupported`（「region not applicable (by design)」）で区別する。providerCoverage側の実行記録は残す。`report_v3.test.ts` に回帰テストを追加。全体テスト291 pass、ビルド成功、JP再実行で `provider_unavailable` ノイズが消えたことを確認済み。
- 注意: この作業環境のサンドボックス内はDNS解決不可のため、ライブ計測はサンドボックス外の承認実行で行った。後任も同様に承認実行が必要。

## 3. まず行う再現実験

コード変更前に次を実行。`git diff --check` はワークツリーの差分チェック。テスト・ビルドが失敗したら原因を特定するまで新規プロバイダー実装を始めない。

```bash
cd /home/ikeno/work/sora
git status --short
git diff --cached --stat
bun test src/services/country_intel
bun build ./src/index.ts --target=bun --outfile /tmp/sora-intel-check.js
git diff --check
```

2026-09-23 時点の現行作業ツリーで全体テストは **290 pass / 0 fail**、Bun ビルドと `git diff --check` は成功。後任は変更後に全体テストを再実行し、結果を更新する。

ライブ実験はプロジェクトDBを汚さないよう、別DBを指定する。以下は `/tmp` に一時スクリプトを置き、各国の小さな集計だけ表示する例。最初は本文補完を切り、提供元の到達性・地域関連性を測る。`contextId` は後で完全証拠を閲覧するため必ず記録する。

```bash
cat > /tmp/sora-intel-probe.ts <<'TS'
import { researchCountryWithDefaults } from '/home/ikeno/work/sora/src/services/country_intel/runtime.ts';
import { closeDb } from '/home/ikeno/work/sora/src/db.ts';

const regions = process.argv.slice(2);
for (const region of regions) {
  const start = performance.now();
  try {
    const report = await researchCountryWithDefaults({ region, noCache: true });
    const relevant = report.evidence.filter((e) => e.regionLink === 'direct' || e.regionLink === 'related');
    const providers = Object.fromEntries(
      [...new Set(relevant.map((e) => e.acquisition?.providerId ?? 'unknown'))]
        .map((id) => [id, relevant.filter((e) => e.acquisition?.providerId === id).length]),
    );
    console.log(JSON.stringify({
      region, contextId: report.contextId,
      seconds: +((performance.now() - start) / 1000).toFixed(1),
      initialBytes: Buffer.byteLength(JSON.stringify(report)),
      relevant: relevant.length, providers,
      runs: report.providerCoverage.map((r) => ({ id: r.provider, status: r.status, error: r.errorCode })),
      limitations: report.limitations?.map((l) => ({ code: l.code, area: l.area })),
      domains: Object.fromEntries(Object.entries(report.domainContext ?? {})
        .map(([name, view]) => [name, view?.factors.length ?? 0])),
      enrichment: report.enrichment,
    }));
  } catch (error) {
    console.error(region, error);
    process.exitCode = 1;
  }
}
closeDb();
TS
SORA_DB_PATH="/tmp/sora-intel-probe-$$.db" SORA_INTEL_SCRAPE=off bun /tmp/sora-intel-probe.ts JP US FR CN DE IN BR ID KR ES SA RU
```

`bun` が `/tmp` スクリプトから依存パッケージを解決できない場合は、同じ内容をリポジトリ直下の一時 `.ts` に置いて実行し、終了後にその一時ファイルだけ削除する。各実験プロセスには固有の `SORA_DB_PATH` を使う。同じDBへ並列実行しない。比較に `noCache: true` を使い、冷/温キャッシュ差とソース公開時刻を記録する。過去件数との単純な大小で合否判定しない。

この一時スクリプトは実際に `/tmp` からJPで起動確認済み。`SORA_INTEL_SCRAPE=off` で約5.5秒、関連137件、初回応答約380 KB、終了コード0。上記の過去JP 140件との差はライブ情報の変動。

本文補完ありの現実的な初回実行は、代表的なJP/US/CNなどから1件ずつ試す。上記コマンドから `SORA_INTEL_SCRAPE=off` を外す。大きいJSON本体を端末に印字せず、保存済み証拠を `get_country_context_evidence` / RESTで必要なIDごとに検査する。`verbose: true` で完全レポートを取得した場合、`CountryContextReportSchema.parse(report)` で形も検証する。

### 品質評価の手順

各国から**経済、政治、観光、保健/災害、総合の各5件**を機械的に抽出し、さらに各分野で上位3件を人手/LLMで読む。評価表には `URL、出版社、publishedAt、対象国、対象国だと判断した原文、本文/抜粋/見出しのみ、検索クエリ、取得プロバイダー、重複クラスタ、利用可否` を記入。見出しだけで裏取りできない事実は「判断材料として不足」。出版社所在国だけで対象国を判定したものは誤関連候補。記事が古い、対象外の国、ブロックページ、ニュース転載だけの場合も別項目にする。LLMの断言と証拠を照合し、誤断言・不足情報・追調査候補を残す。

最低限のシナリオ例:

1. **金融**: 対象国の直近の政策・市場・企業ニュースを取得し、時刻と一次/二次出典を区別できるか。
2. **マーケティング**: 現地で今日話題の事柄と、見出しだけの弱い情報・SNSの偏りを区別できるか。
3. **旅行**: 観光需要、祝日、運航・災害・感染症などの実害を、単なる「災害が話題」と混同せず判定できるか。
4. **SNS投稿判断**: 投稿文の話題を入力し、炎上/追悼/政治などの直近文脈を根拠と欠落付きで提示できるか。判断自体は利用側LLMに任せる。
5. **中国**: 熱搜・報道・任意キーワードニュースを区別し、Weibo投稿本文未取得を明示できるか。

「十分」の仮基準は、各シナリオで対象国と日付が確認できる複数の独立ソースがあり、本文/抜粋が判断に必要な主張を含み、重大な欠落が `limitations` に出ること。数値閾値は上記の実測を見て決める。代表枠が満杯、総件数が多いだけなら未達と記録する。出典同士の転載は独立ソースに数えない。

## 4. 失敗を見つけた時の実装順序

**最優先は品質を測ってから、観測した欠落だけを直すこと。** 作業順:

1. 8～12か国・複数用途の評価表を作り、地域誤判定、空分野、見出しだけ、出版社偏り、上流障害、応答過大を分類する。`providerCoverage.status === success` でも0件なら「取得できた」と扱わない。
2. 既存データで直せるなら、分野クエリ、地域関連判定、代表証拠選定、欠落表示を限定的に修正する。例: 旅行分野に国外災害の記事が上がるなら、ニュースを増やす前に関連判定と選択基準を修正する。修正前後で同じ評価標本を比較する。
3. 実際に不足する地域・分野のみ新しいソースを探索。まず公式API/RSS/公開フィードでライブ疎通・項目・日時・本文・地理属性・利用条件を確認する。候補が悪ければ採用しない。検索グラウンディングは任意の追加調査経路として使えるが、網羅率が測れないので単独の初回取得経路とみなさない。
4. 既存プロバイダーから共通化する必要が明らかな場合だけ共通関数へ切り出す。`report.ts` は長いが、憶測で全面書換えしない。保守しやすい小さなモジュールを優先する。
5. 改修ごとに単体テスト・実際の対象国ライブ試験・隣接する国での回帰試験を行う。最後に全体テスト/ビルド/差分チェック。

### 新プロバイダーの追加方法

`providers/<name>.ts` に `create<Name>Provider(fetchFn?)` を置き、`CountryIntelProvider` を返す。`id`、`areas`、必要時だけ `regions`、`latencyClass`、`collectionWindowDays`、`defaultTtlSeconds`、`timeoutMs` と `run(input, signal)` を設定。国限定サイトだけ `regions` を宣言する。すべての国について同じ地域・言語・検索の計画を使えるなら `news_queries.ts` 等を利用する。取得を `ProviderResult.items` に変換し、証拠には元記事URL、出版社、公開日時、取得日時、原文の範囲、`acquisition.providerId/query`、分野 `areas` を残す。失敗や一部空結果は `status`/`gaps` に表す。`signal` と個別タイムアウトを守り、上流が落ちても全体レポートを止めない。ブロックページを記事本文として保存しない。

`runtime.ts` の既定ID一覧と生成リストへ登録。ニュース/熱搜に該当するなら `recent_context.ts` の分類も確認。`source_catalog.ts` 等の既存パターンに合わせる。新しいプロバイダーに必要なテストは、実際の上流レスポンス形に基づく解析、元記事URL、日付除外、対象地域、空/一部失敗、`gaps`、全体レポートへの統合。ライブ確認をしてから固定fixture化する。HTML構造やCookieに依存する脆い経路は、代替可能性と維持費を評価する。

個別テスト例: `bun test src/services/country_intel/providers/bing_news.test.ts`。完全な回帰: `bun test src/services/country_intel`。最後に `bun build ./src/index.ts --target=bun --outfile /tmp/sora-intel-check.js` と `git diff --check`。TypeScriptの型検査を追加するなら、実際に導入済みのコンパイラ/設定を調べてから実行する。

## 5. 次の担当者が特に判断すべきこと

- 代表応答が中国で約400 KB。LLMに渡すにはまだ大きい可能性がある。サイズを削る場合は、イベント・シグナル・ファクトと証拠IDの参照整合性、本文の必要量、全文取得導線を保つ。`CountryContextReportSchema.parse(compact)` と保存済み全文との差分を検査する。
- 初回に何が不足したかを分野別・提供元別に表示できるか。`period: 30d/90d` を指定してもニュース経路は実際には7日程度なので、`actualWindows` と説明が矛盾しないか確認する。
- `official_web` が0件の国と、現地SNS/話題の欠落は独立した課題。追加プロバイダーは実測で改善が確認できた場合のみ採用。Weibo直接取得を成功と記載しない。
- `news_queries.ts` の言語推定は主な単一言語国に有効だが、多言語国・地域名/州名・少数言語の実測は不足。国別条件分岐を増やす前に、共通の言語選択が改善できるか検討する。
- 保存先と初回応答を区別し、利用者が `contextId` から証拠を辿れることを確かめる。不要時のバックグラウンド収集・無制限保存は再導入しない。

完了を宣言する条件は、主要国の代表的な用途で**証拠の質・地域整合性・鮮度・不足表示**を実測で満たすこと。全世界の全SNS投稿や完全なリアルタイム網羅は保証しない。できない地域・経路はレポートに明記し、利用側LLMが過信しない形にする。現在の作業はこの達成を検証している段階であり、完了済みではない。
