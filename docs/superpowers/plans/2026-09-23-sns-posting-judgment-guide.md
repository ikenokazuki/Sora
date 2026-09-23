# SNS投稿判断への利用ガイド (2026-09-23)

research_country_context の応答をLLMがSNS投稿可否判断に使うための適用範囲と注意点。
実測根拠は 2026-09-22-country-intel-v3-verification.md の4か国ライブ評価。

## 適用範囲: 3点ブレーキに限定する

応答の recentContext・keyEvents・calendar を投稿案・対象読者・投稿予定時刻と照合して検討する。
災害の規模・場所・時刻と投稿内容の関係を見る。情報がないことは投稿可能の根拠にしない。
政治・安保・健康分野の投稿可否、世論の賛否には使わない。

## 使えるフィールド

- recentContext: 直近24時間の話題 (最大20)・記事 (最大20)・取得先状態・不足情報。話題IDは順位変動に左右されない。
- recentContext.sources: 取得先ごとの成否・件数・上流更新時刻・stale 判定。
- keyEvents: 災害クラスタ中心 (CN 25件、JP 18件、US 7件、FR 4件)。ID・証拠ひも付き
- calendar: 各国6〜17件。Nager + Wikidata由来
- signals / domains (content/marketing/travel/finance): 全て partial coverage。注意喚起には使えるが完全性は仮定しない
- temporalMetrics: トーン指標あり (例: CN -2.34 下落、JP +0.16 安定)。方向感のみに使う
- enrichment: 本文補完 11〜12/12件。見出しだけでなく evidenceDetails の本文を根拠にする
- limitations / providerCoverage: 必ず読む。baidu_hot はJP回線から正直に失敗する (PROVIDER_HTTP_4XX)。失敗=データ欠落であり安全側に倒す
- foreignRelations: 1〜2件。薄いので参考程度

## 使えないもの (設計上の欠落)

- polls: 全4か国で0件。世論の賛否判断は不可
- elections: 全4か国で0件。選挙期の自粛判断は不可
- situation.politics/security/health: CN/JP/FRで政治が空、健康は全4か国で空。該当分野の投稿可否は判断不可
- 感情・リスクスコア分類は意図的に非搭載。LLM側で推測して補わないこと
- regionLink は candidate 228件・unknown 283件 (CN実測) とノイズ多め。direct/related を優先し、candidate は裏取り必須

## LLM向け指示文例

    あなたはSNS投稿の可否を判断する。research_country_context の応答のみを根拠にし、知識で補完しない。
    投稿案・対象読者・投稿予定時刻と、recentContext・keyEvents・calendar の証拠を照合する。
    recentContext.topics は話題の注目度であり世論の賛否ではない。
    recentContext.reports は ageClass (flash/recent/background) と publishedAt で鮮度を確認する。
    話題と記事の対応は明示されたURLまたは話題語の一致を根拠にする。対応がなければ未確認と答える。
    証拠がない分野は「不明」と答え、不足分野を明示する。存在しない根拠の引用、無関係な海外事件の判断利用をしない。
    失敗したprovider (providerCoverageのsuccess以外) がある場合、その分野は不明として安全側に倒す。

## 実測値 (30d, noCache, includeSocial=false)

| 国 | 時間 | 証拠 | keyEvents | 成功provider | situation内訳 |
|---|---|---|---|---|---|
| 中国 | 18.8秒 | 654件 | 25件 | 14/15 | 経済7 治安2 災害6 社会1 |
| 日本 | 6.4秒 | 551件 | 18件 | 15/15 | 経済1 災害15 |
| 米国 | 10.2秒 | 516件 | 7件 | 15/15 | 政治1 経済2 災害4 人道2 |
| フランス | 13.6秒 | 460件 | 4件 | 15/15 | 経済1 災害1 |

## 既知の制約

- weibo_hot は話題検出のみ。任意キーワード検索ではない
- xianbao到達不能・m.weibo.cn UID巡回はvisitor壁のため不採用 (parked)
- 応答は全分野 partial。complete を仮定した判断はしない
