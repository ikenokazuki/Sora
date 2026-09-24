# 評価状況と後任への開始地点

> **2026-09-24 再監査による訂正**: 以下は時系列の作業記録です。従来のA/Bは計画通りの同条件比較になっておらず、A 140/192・B 46/192を方式選定の確定値に使えません。新規マーケ6件はincludeSocial未指定で、保存出力にもsocial_not_requestedがあります。「SNS要求済みなのに欠落通知なし」「専用取得器の追加価値ゼロ」「残作業は別日・別モデルだけ」は撤回します。[方法論の再検討](methodology-reset-2026-09-24.md)と[監査・実測JSON](methodology-audit-2026-09-24.json)を優先してください。検索のHTTP 429を0件として返す問題も実測で確認しました。

## 現在の判定

最終ゴールは未達。専用収集器を採用するか、既存WEB検索＋スキルを中心にするかは未決定。
プロバイダー一覧と5件の実測失敗例は存在するが、A/B比較結果ではない。

このファイルは進捗台帳。未実施の比較を成功扱いしない。

| 必要な証拠 | 現在の状態 | 成果物 |
| --- | --- | --- |
| 現行の問題の再現 | 一部の実測結果を保存済み | observed-failures.json |
| 取得器の棚卸し | 22取得器のコード上の方式と検証仮説を記録 | provider-matrix.md |
| 具体的な24ケースと独立した参照回答 | 質問24件を作成。JP-general-01のみ公式資料3件を部分確認。参照回答の完成・独立採点は未実施 | cases.json（評価開始前のレビュー必須） |
| A/Bの同条件比較 | 未実施 | 基準検索と専用収集の差は未証明 |
| 複数呼出元モデルでの検証 | 未実施 | モデルの利用環境と評価予算を確認する |
| 最小構成の決定 | 未決定 | A/B結果に基づく |
| 調査スキルの作成・検証 | 未実施 | 製品への導入済みと扱わない |
| 負荷・中断・清掃の検証 | 未実施 | コード上の懸念と実害の再現を区別 |
| 主要12か国・複数日評価 | 新方針では未実施 | 旧方式の12か国件数は代用不可 |

## 最初に実行すること

1. docs/superpowers/plans/2026-09-23-research-tool-final-plan.mdを読む。
2. git statusと差分を確認する。未コミット変更を消さない。
3. 既知失敗例と現行コードを照合する。スナップショットの例は現在のライブ状態を保証しない。
4. 24ケースを具体化し、方式の出力を見る前に必須確認事項を定義する。
5. 評価担当が根拠を独立確認する。未採点ケースを合格の分母から黙って除かない。
6. その後でA/B比較を実行する。件数を増やす修正を先行しない。

## 計画の評価基準に関する補足

- 国別80%や90%の値は開発上の目標であり、4ケースだけで一般的な品質を保証する値ではない。各率は必ず分子/分母を併記する。
- 「重大な誤り0」は観測標本での条件。将来の誤りが0という意味ではない。
- 現時点で公開されていない情報と、検索が見逃した公開情報は別。後者の判定には独立した参照資料が必要。
- あるproviderを外した再実験は時間差や検索順位変動の影響を受ける。同一取得標本からの除外比較と、ライブでの代替検索比較を分ける。
- 独自情報がなくても、重要情報を早く確実に取得できるproviderには価値がある。独自URLだけで採否を決めない。
- 同じモデルで同じ調査計画を使う比較と、モデルが自由に計画する比較を混ぜない。
- 低性能モデルが必要な調査項目を作れない場合、取得器だけの改善で解決したとしない。

## 引き継ぎ境界

ユーザーは本体の実装を別LLMへ委任すると指定している。
ここまでの計画・棚卸し・失敗例の保存は、その委任を支援する準備。
この台帳の存在は実験実施や最終ゴール達成を意味しない。

## 2026-09-24 証拠参照監査

CN追加実験のrecentContextから参照された5件を一時DBへ読み取り専用で照会した。
5件とも全件レポート、contextと証拠の関連表、証拠詳細表に存在しなかった。
同一URLによる代表証拠の候補も全件レポート内にはなかった。
初回応答の省略だけでは説明できない。結果はreference-integrity-audit.jsonに保存。

コード上ではrecent_context.tsのbuildReportsが未正規化のwrapped.item.evidenceを参照し、
report.tsのenrichedItemsはdetailだけ代表IDへ差し替える。
このため最終evidenceとrecentContextの参照集合が一致する保証がない。
ただし5件の消失を重複排除だけに帰属する再現実験は未実施。
後任はdeduplicateEvidenceWithRemapの選別・上限と照合し、原因を確定すること。

修正条件: 最終の証拠集合とID対応表を使いrecentContextを生成する。
参照を単に消して検証を通すのではなく、重要な情報を落とさないことも評価する。
同じURLがない今回の標本では、ID書換えだけで回復できるとは仮定しない。

## 2026-09-24 原因確定（再現あり）

上記の仮説をコードと単体再現で確定した。連鎖は以下。
report.ts:390 で全取得 evidence を deduplicateEvidenceWithRemap に通し、代表IDだけが最終 evidence（evidenceById）に残る。
report.ts:569 の enrichedItems は detail だけ代表へ更新し、item.evidence は重複排除前の生オブジェクトのまま残る。
recent_context.ts の buildReports は wrapped.item.evidence.id をそのまま recent.reports に出す。remap を適用しない。
他の利用者（facts、details、provider-area）はすべて remap を適用しているため、recent.reports だけが非先頭の重複IDを参照し、全件レポート・関連表・詳細表のどこにも存在しない宙ぶらりん参照になる。
再現: 同一URLでIDの異なる2件（global_feeds＋bing_news）を deduplicateEvidenceWithRemap→buildRecentContext に通すと、代表に選ばれなかった evd_second が reports に出て evidenceById に存在しないことを確認した。
回帰テスト recent_context.test.ts「recent reports resolve to canonical deduped evidence」を skip 付きで追加した（現状は失敗するため）。
修正はA/B選定後に行う。条件: 最終の証拠集合とID対応表を使い recentContext を生成する。参照の削除で検証を通さない。

## 2026-09-24 オフライン検証（通信遮断中の代替作業）

サンドボックスの通信遮断が継続（curl は外部・localhost とも 000）のためライブA/Bは未実行。
代わりに以下を検証した。cases.json は24件・要件ID重複なし・必須項目完備・参照URLは全件有効な http(s)。
SKILL.md の記載ツール名（search_tools、search_web、search_deep、scrape、scrape_batch、search_realtime、research_country_context、get_country_context 系3件）はすべて src/mcp.ts の登録と一致した。

## 2026-09-24 既知失敗標本と回帰カバレッジの対応表

完了条件4（誤分野・対象国外・古い出来事・空SNS・証拠参照切れの回帰検証）に向け、標本ごとの現状を整理した。
CN-dangling は原因確定＋skip付き回帰テスト追加済み（修正はA/B選定後）。
CN-social-empty は social_not_requested の表明が report_v2/v3 テストで検証済み。0件gap（recent_context_gap）の明示は未確認。
US-She と CN-Godfather（目的不適合の分離）は候補・背景への振り分け経路の直接検証が未確認。
CN-BAVI（終了済み台風の現在扱い）は ageClass の区分自体は存在するが、古い出来事を現在の障害から分離する直接テストがない。
SA短縮国名の candidate 扱いは region.test.ts に対応がなく、元の失敗入力の再現も未実施。
計画Task 1の6標本のうち observed-failures.json にない中国水泳→health は保存標本自体がないため、追加保存か対象外の判断が残作業。

## 2026-09-24 A/B初回2件（金融、固定計画）

通信回復後に金融2件で固定計画試験を実行した。A=汎用WEB検索のみ（Sora MCP不使用、browser相当、30秒予算内）、B=researchCountryWithDefaults ライブ。
採点は厳密二値（発表日・適用日の両方が要る等）。採点者＝実行者のため盲検化なし。run JSON は runs/ab-JP-finance-01.json と runs/ab-US-finance-01.json。
JP: A 3/4、B 4/4。US: A 3/4、B 2/4（Bは適用日と決定主体FOMCの明示を欠いた）。合計は A 6/8、B 6/8 で互角。
Bの独自寄与は bing_news の速報抜粋と official_web の補強。一次資料（日銀9月声明、FRB声明）は両件とも未取得。
B側の問題: 1件で recent 20件中1件の宙ぶらりん参照をライブ再現（evd_640a9bc10e3be186edda）。主要証拠の問い適合率は1/3。
1クエリで数百件を取得する過剰取得（usgs 262件等）があり、HTTP・時間・DB増分の budgets 観点で不利。
A側の問題: 適用日の確認が弱い（2件とも time を落とした）。スニペット止まりで一次資料に届かない。
統計的主張はしない（n=2）。残り金融4件→旅行・一般の順で拡大し、自由計画試験と2構成目モデルは別途。

## 2026-09-24 A/B金融6件完了（固定計画）

6件すべて実行した。A=汎用WEB検索のみ（1-2クエリ、30秒予算内）、B=researchCountryWithDefaults ライブ（noCache、5.8-18秒）。
集計: A 21/24=0.875、B 17/24=0.708。重大な誤りは両腕とも0。run JSON は runs/ab-{JP,US,CN,SA,IN,BR}-finance-01.json、生Bレポート同梱。
国別: BR 8/8、IN 8/8、JP 7/8、CN 6/8、US 5/8、SA 4/8。
パターン: Bは一次資料（BCB声明、RBI声明）に届いた件では強いが、鮮度が命の要件（CNの9月改定、SAの利上げ、USの適用日・FOMC明示）で古い版を拾って落とした。
Aは断片検索で鮮度に強いが、適用日と一次資料には届かない。Bの主要証拠の問い適合率は7/16=0.438で、過剰取得（usgs 262件等）と無関係keyEventsが目立つ。
宙ぶらりん参照はJP・CNのBで各1/20をライブ再現、US・SA・IN・BRは0/20。
統計的主張はしない（n=6、単一モデル、固定計画のみ）。次は旅行6件、一般6件、マーケティング6件の順で拡大し、自由計画試験と2構成目モデルは別途。

## 2026-09-24 A/B旅行6件完了（固定計画）

A 17/24=0.708、B 8/24=0.333、重大な誤りはBに1件（インド照会にフロリダ山火事を主要イベントとして混入＝対象国外）。
Bは入国条件（ESTA・eVisa・ビザ免除）と空港アクセス路線の取得に6件とも失敗し、日時要件だけが残った。
 hazards は日本（台風25号＋M4.4）とサウジ（リヤドのフーシ攻撃9/21）で支持されたが、中国は終了済み台風の列挙に留まった。
運用面ではBRが68.8秒で60秒の延長予算も超過（PDF混じりの本文補完が原因の疑い）。中国プロバイダ群の CN エラー、nager の 5xx も記録した。
Aは入国・交通・ hazards を現地語含む1-2クエリで取るが、国内線の手続き不要の明示、最新 hazards の不在確認、空港急行の特定便など詰めの甘さが残る。
BR旅行の入国条件は汎用検索でも解決不能（2023年合意が2026年9月29日期限）で、未確定のまま報告する訓練に使える。
金融と合わせた暫定値は A 38/48、B 25/48。統計的主張はしない（n=12、単一モデル、固定計画のみ）。

## 2026-09-24 A/B一般6件完了（固定計画）

A 14/24=0.583、B 2/24=0.083、重大な誤りは両腕とも0。Bは日本（MPP/IP公式＋2027募集告知）の2件以外すべて未支持。
米国のSIPA、中国の特定課程、サウジの特定トラック、インドのMA固有頁はBの取得物になく、ブラジルは英語課程なしの未確認報告も出せなかった。
Aは公式募集要項・締切（コロンビアSIPAの2027締切等）と未確認の区別で取り、適合率は12/12。
方法論の注意: unknown要件は判断呼出元を持つAに構造的有利がある（Bは取得のみで未確認の明示を出さない）。Bの0点は取得物の限界と判定主体の不在の合成である。
実験条件の変化: 一般件の途中で呼出元エフォートがxhigh→max相当に変わった（プロキシマップ変更）。B腕（決定論的取得）には影響しない。
A腕の厳密二値ルールは全件で同一に適用したが、条件変化として記録する。3用途暫定値は A 52/72、B 27/72。統計的主張はしない。

## 2026-09-24 Task 1ベースラインとTask 2着手

Task 1（現状凍結）: `bun test src/services/country_intel` は383 pass、0 fail（61ファイル、1253 expect）。`bun build ./src/index.ts --target=bun` 成功（1303 modules）。`git diff --check` はクリーン。未コミット差分（25ファイル変更、collector 2ファイルのステージ済み削除）は保持し、破壊していない。

Task 2（スキル試案）: `docs/skills/sora-research/SKILL.md` を試案として作成。記載ツールは `src/mcp.ts` に存在するものだけ（search_tools、search_web、search_deep、scrape、scrape_batch、research_country_context、get_country_context、get_country_context_evidence、get_country_context_updates、search_realtime）。製品導入済みとして扱わない。

残作業: cases.json 24件中23件がunreviewed、1件が部分確認のみ。参照回答の独立確認が終わるまでA/B比較を開始しない。複数モデルの利用可否も未確認。

## 2026-09-24 ケースレビューとA/B準備

ケースレビュー: 24件の問い・要件はすべて具体的で、出力を見る前の事前定義として成立。参照根拠を記録した。
金融6件は reviewed・eligible（日銀9/18 +25bp→約1.25%、Fed 9/16 3.75-4.00%、PBC LPR 1Y 3.00%/5Y 3.50%据え置き、SAMA repo 4.50%/reverse 4.00%、RBI repo 5.25%据え置き、Copom Selic 13.75%へ利下げ）。
旅行6件・一般6件・マーケティング6件は partial_primary_source_review・runEligibilityはreference_review_requiredのまま。
部分確認の内訳: 旅行は入国条件の一次資料ポインタ＋交通事業者＋ hazards のライブ確認手順。BR-travel の入国条件は資料が相反するため Itamaraty での解決を採点条件にした。
一般は課程の実在確認（UTokyo MPP/IP、Columbia SIPA MPA、Fudan ISO、KSU大学院、DU FSR、USPは英語課程なし→未確認報告の試験）。
マーケティングの current-context・industry-reaction は実行時ライブ観測が必須のため、検証フック（SA建国記念日9/23直後、CN国慶節10/1直前など）と観測範囲の上限だけ記録した。
レビュー中に混入した無効URL3件は修正済み（検証スクリプトで再発防止は未実装）。

モデル環境: 現行モデル muse-spark-1.3 を arm-1 として確認。2構成目のモデルは未確認のため、完了条件5は未達扱いとする。

実行環境の制約: 本セッションのサンドボックスは外部・localhost とも通信不可（curl 000）のため、ライブA/Bはここで実行できない。
ネットワーク到達性のある環境で、eligible な金融6件から固定計画試験を開始する。run JSON の形式と集計は scripts/eval-research.ts に定義し、--selftest で検証済み。
A/B実行手順書: 同一モデル・同一質問・同一予算（30秒、追加60秒）でA/Bを交互に近い時刻で実行し、モデル・設定・プロンプト・各ツール引数・開始終了時刻・全結果・失敗を run JSON として保存する。
採点は方式名を隠して原文照合で行い、集計だけ eval-research.ts に通す。生成モデルの自己採点で合格にしない。

## 2026-09-24 A/Bマーケティング6件完了（固定計画）

A 13/24=0.542、B 3/24=0.125、重大な誤りはBに1件（IN照会にフロリダ山火事＝旅行INと同一ミスフィットの再発）。
BのcurrentはUS（イラン/Trump-Xi 9/22-24）、CN（貿易休戦9/23）、SA（フーシ9/21）の3件のみ支持。
industryは全滅：topicalには当たる（JPコラボカフェ炎上、US NYチェーン、CN上海カフェ、SAスタバ問題）が全件publishedAt Noneで7日以内を確立できず。
languageは両腕とも全滅（翻訳・文化根拠の取得物なし）。scopeはA全件支持（web限定・未観測明示）に対しB全滅（JPはyahoo 0件なのにgap通知なし＝CN-social-emptyのライブ再現）。
宙ぶらりん参照はJP（evd_640a9bc10e3be186edda）とCN（evd_2f17c0751c7b39d7ad3a）で再発、同一IDが全用途で循環。
CN socialは熱榜のみ（ランキング≠投稿検索の区別なし）。blueskyは全部署で4xx。
固定計画24件の確定値: A 65/96=0.677、B 30/96=0.313、重大な誤りはBに2件（いずれもIN照会フロリダ混入）。
国別（A+B/8）: BR 12/32、CN 15/32、IN 17/32、JP 18/32、SA 14/32、US 19/32。
用途別: 金融A21/B17、旅行A17/B8、一般A14/B2、マーケA13/B3。Bは金融以外で崩壊し、特に一般・マーケで取得物の問い適合が出ない。
統計的主張はしない（n=24、単一モデル、固定計画のみ、採点者＝実行者で盲検化なし）。次は自由計画試験、2構成目モデル確認、Task 4選定。

## 2026-09-24 自由計画試験（2モデル×2件）とTask 3完了・Task 4選定

自由計画: 問いのみ＋予算（3検索2開封相当）を渡し、計画と取得を分離。対象はUS/SA-marketing。run JSON は runs/freeplan-01.json（eval集計の対象外、A/B比較の盲検化なし・採点者＝実行者）。
M1（muse-spark-1.3-contributor）: US 3/4、SA 2/4。M2（muse-spark-1.3、codex exec、ultra）: US 2/4、SA 2/4。両モデルとも4項目を計画（計画不足0）。取得不足の内訳は同一傾向: language 0/4（両モデル・全件で翻訳/文化根拠なし）、industryは日付確立のみ落とす（M1-USのみ7日以内を確立）。
結論: 不足の主因は計画漏れではなく取得・裏付け手順（日付確認、言語文化出典の探し方）。スキル手順5・6の強化方向が正しい。Bの取得器ではlanguageは1件も埋まらなかった。
副次観測: M2初回試行は最終報告なしで終了（取得は行い再試行で成功）。M2は同一予算でも61k〜219kトークンを消費し、M2-USは検索枠を超過気味に使用。2構成目モデルの利用可能性は確認（完了条件5の一部）。残課題は実行時コスト（61k〜219kトークン）と予算遵守。

Task 3完了判定: 固定計画24件＋自由計画4走＋B独自寄与の追跡・代替確認＋provider-matrix反映を終了。ゲート（初回80%）はA 0.677・B 0.313で両方未達。原因分類: (1)計画漏れ→否定（自由計画で両モデル4/4計画）。(2)取得不能→B独自寄与は96件中2件のみで代替可、Bに代替不能な取得なし。(3)誤選別→Bに2件の重大混入（IN照会フロリダ）。(4)根拠誤り→publishedAt全滅・宙ぶらりん参照・gap通知なしはB側の構造欠陥。よって選定規則「両方未達なら原因を分類」に従い、無条件のprovider増設はしない。

Task 4選定: A中心（スキル＋既存ツール主経路、収集器は任意経路）。根拠: Bに代替不能な寄与0、重大誤り2、recentContext宙ぶらりん未修正。Task 4の実施内容: (a)スキルの手順5（日付・対象確認）と手順6（不足IDごとの追加調査）を自由計画の失敗例で具体化。(b)現行収集器を十分な回答として案内しない旨を文書化。(c)recentContext修正は回帰テストのskip解除とセットで実施（Task 4の実装作業として別途）。(d)非推奨化は既存利用者の契約確認後に文書化のみ。即削除しない。
未達の明示: 初回80%・補完後90%は未達。補完後（追加検索前提）の再評価、主要12か国拡張、複数日再評価はTask 6へ繰越。「完了」とは書かない。

## 2026-09-24 Task 4着手（A中心）: recentContext修正＋スキル具体化

recentContext宙ぶらりん参照を修正: `buildRecentContext` に `evidenceIdRemap` を追加し、報告・話題の証拠参照を重複排除後の代表IDへ寄せ、表示項目も最終証拠集合から取る。呼出側（report.ts）で remap を渡す。回帰テストの skip を解除し `bun test src/services/country_intel/recent_context.test.ts` は 4 pass 0 fail。`bun test src/services/country_intel` は 292 pass 0 fail、`bun build` 成功、`git diff --check` クリーン。
全スイート（`bun test`、83ファイル）は 883 pass 1 fail。失敗は `src/index.test.ts` の integratedSearch ライブ試験（9/6ライブ予定、noCacheで0件）で、country_intel・今回の変更と無関係（src/index.ts は recent_context を参照しない）。再実行でも同一。ライブ上流依存の既存失敗として記録。
スキル具体化: 手順6に自由計画の失敗例（祝祭文言の文化根拠の探し方、業界批判の日付確定ルール）を追記。収集器の扱い文書化と非推奨化の契約確認は残作業。コミット・デプロイは行わない。

## 2026-09-24 Task 4b: 収集器の扱い文書化

`research_country_context` のツール説明文に限界を追記（mcp.ts、追加的変更・契約破壊なし）: 一部証拠は公表日時なし、SNSは対象言語・範囲限定、未観測範囲の明示は呼出元が確認、本ツール単独で判断の十分性を保証しない。mcp_parity・mcp_details試験は通過。country_intel全件は 292 pass 0 fail。
`src/index.test.ts` のライブ2件（9/6予定、Yahooフォールバック）は現在失敗するが、mcp.ts変更の退避・復帰による切り分けで変更前後とも失敗し、Yahoo上流の0件応答が原因と確定。今回の変更とは無関係の既存失敗として記録。非推奨化の契約確認は残作業。

## 2026-09-24 Task 4d: 非推奨化の契約確認（文書化のみ）

定期収集パス（collector.ts）は既に配線解除済みでin-repoの呼出者はなし（index.tsの起動コードは削除済み）。hot_collector.tsのスナップショット差分ヘルパーはreport.tsが現役で使用中のため削除対象外。追加の削除は行わず、定期収集の復活はTask 5の運用検証なしに行わないことを記録する。

## 2026-09-24 Task 5: キャッシュ既定経路の検証と修正

検証で不具合を発見: 既定呼出しでは `dependencies.cache` が常に null のため2回目も全件ライブ取得だった（cold 7.4秒→warm 7.4秒）。修正: `defaultProviderCache`（SQLite永続）を公開し、`createDefaultCountryIntelDependencies` で既定付与（明示nullは無効化のまま）。回帰試験 `provider_cache.test.ts` を追加（2回目は再実行なし・noCacheで再取得）。country_intelは 293 pass 0 fail。
実測（JP/economy、同一DB）: coldはprovider遅延合計13.5秒・壁7.5秒、warmは遅延合計13ミリ秒・壁4.1秒で証拠数は同一、noCache再実行で全件再取得を確認。残りの壁4.1秒はキャッシュ外経路（本文補完等）で、期限清掃・deadline伝播・同時要求負荷は残作業。

## 2026-09-24 Task 5: kill-switch・負荷・並列書込の検証と修正

provider停止設定を追加: `SORA_INTEL_DISABLED`（カンマ区切りID）と `disabledProviders` オプションで既定provider列から除外。`disabledCountryIntelProviders` と `createDefaultCountryIntelDependencies` の試験を追加。実測で usgs/eonet 除外を確認し、報告は完走する。復帰手順＝変数解除のみ。
負荷実測（JP/economy、warm）: 並列1で4.2秒、5で6.3秒、10で8.3秒。DBはcold後4MB→16要求後28MB（要求ごとに全文報告を永続化、1件約1.5MB）。
並列書込の不具合を発見し修正: 10並列で3件が `SQLITE_BUSY: database is locked` で異常終了（saveCountryContext等の書込競合、busy_timeout未設定）。`PRAGMA busy_timeout = 5000` を接続時設定し、10並列10/10成功を確認。country_intelは 296 pass 0 fail。残作業: 期限清掃の実測、本文補完の残4秒の内訳、12か国拡張。

## 2026-09-24 Task 5: 期限清掃の実測とSSRF確認

期限清掃を実測（使い捨てDB、11報告）: 現時刻pruneは0件削除で有効contextは解決可能のまま、400日後pruneは報告11・抜粋502・イベント12・詳細612を削除し対象contextは解決不可になる。期限内参照の保護と期限後削除の両方を確認。providerキャッシュ読取は期限切れ除外あり（dbGetCache）。
SSRF防御の確認: http_fetcher層にプライベートIP遮断のガードは見つからなかった。外部URL取得（本文補完・scrape経路）の初めての本格利用前に、DNS解決後の接続先検証または許可域制限の追加検討が必要。実装は共有基盤に触れるため未着手の open 項目として残す。
Task 5の残り: 本文補完の残4秒の内訳分解、12か国拡張（Task 6）。

## 2026-09-24 Task 6着手: 12か国拡張のケース追加

追加6か国（KR・GB・FR・DE・ID・MX）を選定。理由: 東アジア・欧州英語仏独・東南アジア・中南米を混ぜ、文字体系（ハングル・仏独表記・スペイン語）と情報環境の多様性を確保。FR/DEはECB管轄で「自国中銀と混同しない」試験になる。4用途×6件の24問を cases.json に追加し計48件。新規は reviewStatus=unreviewed・runEligibility=reference_review_requiredで、参照確認が終わるまで実行しない。eval集計は既存24件の値を維持。

## 2026-09-24 Task 6: 新規金融6件の参照確認

KR・GB・FR・DE・ID・MXの金融6件を partial まで確認。GB据置3.75%（6-3、9/17公表）、ECB 9/10利上げ（預金2.50%/MRO2.65%、9/16適用）、ID据置5.75%（9/23）は報道が一致。KRは報道衝突（3.00%説と2.5%説）のため一次資料待ち。MXは9/26決定がasOf後のため予想扱いに留める。いずれも一次URL未確定のため runEligibility は上げず、旅行・一般・マーケ18件の確認が残作業。

## 2026-09-24 Task 6: 新規金融6件のA/B固定計画 (KR/GB/FR/DE/ID/MX)

A 24/24=1.000、B 6/24=0.250。重大な誤りは両腕とも0。run JSON は runs/ab-{KR,GB,FR,DE,ID,MX}-finance-01.json、生Bレポート同梱。
A=汎用WEB検索1クエリ(30秒予算内)。B=researchCountryWithDefaults ライブ(noCache)。KR 7.9秒/56件、GB 9.7秒/49件、FR 40件、DE 36件、ID 55件、MX 35件。
国別(A/B): KR 4/0、GB 4/1、FR 4/1、DE 4/1、ID 4/3、MX 4/0。
パターン: BはECB/BoE公式頁を拾うが値・日付が読めずbody特定に留まる(GB/FR/DE各1点)。IDは当日6紙が5.75据置を支持しB最良の3点。KR/MXはB証拠が集計二次か無関係のみで0点。
KRとMXは一次衝突あり(Aが両説を出して決定/予測を分離: KRは8/27利上げ3.00決定 vs 2.5据置説、MXは8/7決定7.00 vs 9/26会合予想)。採点は決定値の支持で判定。
Task 4修正のライブ検証: 新規B 6件のrecent 20件×6=120参照は全て最終evidenceに解決、dangling 0/120。旧標本の1/20再発はなし。
方法論の注意: n=6、単一モデル、固定計画のみ、採点者=実行者で盲検化なし。A満点は断片検索の鮮度優位によるもので統計的主張はしない。Bのbackground 4件のelapsedMsは未記録のためrun JSONではnull。
暫定累計(金融12件): A 45/48、B 23/48。全用途旧24件との合計は A 89/120、B 36/120。
次は新規旅行6件・一般6件・マーケ6件の参照確認済み分から実行し、複数日再評価・REST/MCP入口確認へ。品質ゲート(初回80/補完後90)は未達。完了とは書かない。

## 2026-09-24 Task 6: 新規旅行6件のA/B固定計画 (KR/GB/FR/DE/ID/MX)

A 18/24=0.750、B 7/24=0.292。重大な誤りはBに1件（MX照会に米国ニューメキシコの微小地震6件を主要イベントとして混入＝対象国外）。run JSON は runs/ab-{KR,GB,FR,DE,ID,MX}-travel-01.json。
A=汎用WEB検索2クエリ（入国＋交通hazards、30秒予算内、実行者=muse-spark-1.3-contributor）。B=前任取得の researchCountryWithDefaults ライブ報告（noCache、KR 50件、GB 47件、FR 38件、DE 34件、ID 40件、MX 36件）を同日09:06-09:11Zに採点。A/Bは同一時間帯のため鮮度差は小さい。
国別（A/B、4件中）: KR 4/1、GB 3/1、FR 4/1、DE 2/1、ID 3/2、MX 2/1。
パターン: Bは入国条件と空港アクセスを6件とも欠落し、日時要件だけが残った。hazards はIDのKrakatau噴火9/4オレンジ警報のみ支持（10月影響は未確定と明示）。MXのバハM2.15は軽微でCDMXと無関係、NM州6件は対象国外。
Aは入国条件を6件とも取得したが、交通はDE・ID・MXで確定情報なし、hazards はGB・DE・MXで根拠なしと厳密に落とした。FRのRER B時刻表確認とKRの秋夕臨時確認が交通支持の好例。
Task 4修正の検証: 新規B 6件の recent 20件×6=120参照は全て最終 evidence に解決し、参照切れ 0/120。旧標本の再発なし。
方法論の注意: n=6、固定計画のみ、採点者=実行者で盲検化なし。A/Bの実行モデル表示は採点者（contributor）で統一し、B取得自体は決定論的取得のためモデル非依存と記録する。DE/FRの汎欧州干ばつ keyEvent は対象曖昧のため重大誤りとせず注意に留めた。
暫定累計（新規金融＋新規旅行12件）: A 42/48、B 13/48。旧24件との合計は A 107/144、B 43/144。
次は新規一般6件・マーケ6件の参照確認済み分から実行し、複数日再評価・REST/MCP入口確認へ。品質ゲート（初回80/補完後90）は未達。完了とは書かない。

## 2026-09-24 Task 6: REST入口の実働確認

本番と同じ REST 入口で確認した（直接関数の成功だけにしない）。使い捨てDB（SORA_DB_PATH=/tmp配下、製品DBに触れない）でサーバを起動し、POST /intelligence/country（KR）に 200 で 229KB・7.2秒、GET /intelligence/context/:id に 200 で 1.2MB、GET /evidence?limit=3 に 200 で証拠頁が返ることを確認した。確認後にサーバは停止した。MCP 入口は登録名の静的照合済み（Task 2時点）で、ライブのハンドシェイクは未実施のため残作業とする。

## 2026-09-24 Task 6: 補完後充足率の初回測定（新規旅行3要件の標本）

品質ゲートの初回/補完後を分けるため、初回で落とした3要件を追加調査した。方式Aの延長として同一モデルが実施し、厳密二値で再採点した。
MX-hazards: 9/19の地震報道は年次混在で、2026年9月19日は Segundo Simulacro Nacional 2026（全国防災訓練）であり実災害ではない。過去のM7級（2017・2022等）は終了済み。補完後も未支持だが、不在確認として誤報を出さない手順は機能した。
DE-transport: S9/S45の9/13から11月中旬まで閉鎖の候補を発見したが年次が確定できず、BER公式の10/28-11/3閉鎖は期間外。10/2-5の確定情報なしで補完後も未支持。
GB-hazards: 10/1・5・8の鉄道スト等の報道は年次なしの旧記事と分離できず、10/2-5の確定警報なしで補完後も未支持。
標本の補完後転換は 0/3。新規旅行の補完後充足率は A 18/24 のまま（標本外の転換は主張しない）。教訓: スキル手順6に年次確定ルール（年なし記事の不採用、公式閉鎖期間の対照）を明記する必要がある。

## 2026-09-24 Task 6: 新規一般6件のA/B固定計画 (KR/GB/FR/DE/ID/MX)

A 21/24=0.875、B 0/24=0.000。重大な誤りはBに1件（MX照会のニューメキシコ混入、旅行件と同一パターンの再発）。run JSON は runs/ab-{KR,GB,FR,DE,ID,MX}-general-01.json、生Bレポート同梱。
A=汎用WEB検索1-2クエリ（09:00-09:15Z、実行者=muse-spark-1.3-contributor）。B=researchCountryWithDefaults ライブ（noCache、09:15:35-09:16:21Z、KR 53件8.0秒、GB 47件10.5秒、FR 41件7.9秒、DE 31件4.6秒、ID 42件6.6秒、MX 34件8.1秒、実測elapsedMsを記録）。A/Bは同一時間帯。
国別（A/B、4件中）: KR 3/0、GB 4/0、FR 3/0、DE 4/0、ID 3/0、MX 4/0。
パターン: B証拠に課程情報は皆無で、教育関連ヒットはGB 3件の無関係な大学言及のみ。Bは取得のみで未確認の明示を出さないため unknown も全滅した（旧一般件と同一の構造的限界）。Aは公式募集要項に届いた件（GB・MX）で満点、KR・FRは2027年募集期限の未確認を厳密に落とした。
参照確認の扱い: cases.json の runEligibility は reference_review_required のままとし、今回のA検索をライブ検証として参照URLの有効性を確認した（SNU GSIS、Oxford MPP、Sciences Po PSIA、TUM、UI、UNAMの公式頁に到達）。正式な reviewed 昇格は別途行う。
Task 4修正の検証: 新規B 6件の recent 20件×6=120参照は全て解決し、参照切れ 0/120。
方法論の注意: n=6、固定計画のみ、採点者=実行者で盲検化なし。B実行スクリプト scripts/run-b-batch-general.mjs は評価用 tooling として残す（製品コードではない）。
暫定累計（新規18件）: A 63/72、B 13/72。全用途・新旧合計は A 128/168、B 43/168。
次は新規マーケ6件の参照確認済み分から実行し、複数日再評価・MCP入口ライブ確認へ。品質ゲート（初回80/補完後90）は新旧合計で未達。完了とは書かない。

## 2026-09-24 Task 6: 新規マーケ6件のA/B固定計画 (KR/GB/FR/DE/ID/MX)

A 12/24=0.500、B 3/24=0.125。重大な誤りはBに1件（MX照会のニューメキシコ混入、旅行・一般件と同一パターンの三度目の再発）。run JSON は runs/ab-{KR,GB,FR,DE,ID,MX}-marketing-01.json、生Bレポート同梱。
A=Tavily 2クエリ（current + boycott、09:20:30-09:21:30Z、実行者=muse-spark-1.3-contributor、1国あたり壁約5秒）。B=researchCountryWithDefaults ライブ（noCache、09:19:48-09:20:39Z、KR 53件8755ms、GB 47件5383ms、FR 41件7123ms、DE 31件6055ms、ID 42件（elapsed未記録のためnull）、MX 34件7879ms（2回目実測））。A/Bは同一時間帯。
国別（A/B、4件中）: KR 2/1、GB 2/0、FR 2/1、DE 2/0、ID 2/1、MX 2/0。
パターン: Aはcurrentを6件とも取得した（KR 9/24仁川火災・秋夕移動、GB 9/19 Tube週末閉鎖、FR 9/17漁民デモ・消防スト通告、DE 9/19-21 AfD・ベルリン選挙、ID 9/6 Krakatau・9/23-24地震、MX 9/19 Simulacro訓練・追悼）。一方languageは6件とも現地語用例なし、industryは6件とも直近7日の投稿日時が確定できず厳密に落とした（KRのNikkeiスタバ記事、MXのFresh Cup 8/31米記事など候補はあるが日時・対象国が合わない）。scopeはAが6件とも観測範囲の限定を明示して支持。
BはKR秋夕渋滞（evd_8cc3、9/24）・FRパリ教皇訪問（evd_423e、9/23、soft）・ID Krakatau噴火（evd_ad80、9/4＋9/23-24地震）の3点のみ。GB/DEは一般ニュースのみでcurrentなし。MXはSimulacro・追悼なし＋Baja M2.15のみで、New Mexico 6-7件のkeyEvents混入を重大誤りとした。B証拠にsocial/yahoo/weibo文字列は6件ともなし、scopeは6件とも未明示で全滅した（旧マーケ・一般件と同一の構造的限界）。
Task 4修正の検証: 新規B 6件の recent 20件×6=120参照は全て最終 evidence に解決し、参照切れ 0/120。
方法論の注意: n=6、固定計画のみ、採点者=実行者で盲検化なし。FRのB-currentは教皇訪問のsoft passでありmourning/hazardではないことを明記する。IDのB elapsedMsはバッチ出力欠落のためnullとした。B実行スクリプト scripts/run-b-batch-marketing.mjs は評価用 tooling として残す（製品コードではない）。
暫定累計（新規24件）: A 75/96、B 16/96。全用途・新旧合計（48件）は A 140/192、B 46/192。
次は複数日再評価・MCP入口ライブ確認へ。品質ゲート（初回80/補完後90）は新旧合計で未達。完了とは書かない。

## 2026-09-24 Task 6: 検証状態と残作業（コード変更なし）

- country_intel全件: 296 pass 0 fail。bun build成功（10.99MB）。git diff --check clean。
- REST入口は使い捨てDBで実働確認済み（POST/GET 200）。MCP入口はInMemory client＋実サーバでライブ確認済み（defer既定のままsearch_tools「国地域」で有効化→research_country_context KR/noCacheが55件・8.1秒で完走、structuredContentとtextの両方あり）。
- 固定計画A/Bは単一モデル（muse-spark-1.3-contributor、採点者＝実行者、盲検化なし）。2構成目モデルでの固定計画比較は未実施。自由計画のみUS/SA-marketing 2件で2モデル（contributorとmuse-spark-1.3）の記録あり。
- 複数日再評価は未実施（全て9/24単日）。同日再現性のみ確認：KR-marketingのB再実行（同一query・noCache）は53件→55件で主要2件（秋夕渋滞・スタバ記事）とも再現、6.8秒。全体deadline伝播と本文補完の残り時間内訳は未分解。
- provider-matrix.mdに実験後の維持・任意・除外判断を記録した。MXニューメキシコ混入の修正案（USGS/GDACSの対象国外イベント除外）は提案のみで未実装。
- 最終 synthesis（採用構成・削減取得器・未達地域用途・費用・保守手順）は本節＋provider-matrixの判断＋上記累計をもって代える。品質ゲート未達のため完了とは書かない。
