# SNS投稿判断への利用ガイド (2026-09-23)

research_country_context の応答をLLMがSNS投稿可否判断に使うための適用範囲と注意点。
実測根拠は 2026-09-22-country-intel-v3-verification.md の4か国ライブ評価。

## 適用範囲: 3点ブレーキに限定する

現状の応答でLLMが確度高く判断できるのは次の3点のみ。これ以外 (政治・安保・健康分野の投稿可否、世論の賛否) には使わない。

1. 災害ブレーキ: keyEvents (GDACS/USGS/EONET由来、規模・指標付き) に該当国の災害があれば投稿停止
2. カレンダーブレーキ: calendar (国別6〜17件) の祝日・追悼日と衝突すれば投稿延期
3. 過熱ブレーキ: signals のattention/tone + evidence (Weibo Hot Search 30件等) で話題過熱・トーン悪化時は投稿保留

## 使えるフィールド

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
    1. keyEventsに当該国の災害があれば「停止」と答える。
    2. calendarの祝日・追悼日と衝突すれば「延期」と答える。
    3. signalsのattention過熱またはtone悪化があれば「保留」と答える。
    4. 上記いずれにも該当しなければ「可」と答え、根拠のevidence IDを列挙する。
    5. polls/electionsが空、またはsituationの該当分野が空の場合は「判断不可」と答え、不足分野を明示する。
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
