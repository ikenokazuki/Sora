# 試行4件の証拠対応表と採点運用

2026-09-24。順序1（前提整備）の成果物。採点項目はpilot-2026-09-24.jsonで事前固定。結果の要点はpilot-2026-09-24-result.md。生応答は/tmp/sora-pilot-0924。

## 採点運用（以降の比較で守る）

- 要件充足と取得状態を分けて記録する。失敗はfailed、0件はempty、未試行はunattempted。
- 支持にはURL・該当抜粋・発行日（またはURL内の日付）・取得日時を対応付ける。抜粋なしの支持は認めない。
- 実行者と採点者を分けられない間は、採点根拠の原文抜粋を必ず残し、第三者が追試できる形にする。盲検化なしの旨を明記する。
- 日付未確認は不採用。対象違い・期間外は不採用。予測記事は決定事項と分ける。

## 支持の対応（2件）

| 要件 | 証拠 | 日付の根拠 | 抜粋の要点 |
| --- | --- | --- | --- |
| ID-aviation（現行） | [Mainichi](https://mainichi.jp/english/articles/20260906/p2g/00m/0in/030000c) | URL内20260906 | Anak Krakatau噴火でJakarta空港等の欠航 |
| ID-aviation（現行） | [CNN](https://www.cnn.com/2026/09/06/travel/anak-krakatau-indonesia-eruption-airports-intl-hnk) | URL内2026/09/06 | Jakarta空港の再開報道 |
| ID-aviation（現行） | [米大使館](https://id.usembassy.gov/natural-disaster-alert-mt-anak-krakatau-eruption-september-6-2026/) | URL内september-6-2026 | 9/6噴火の災害警報 |
| CN-culture（改訂） | [澎湃新聞](https://www.thepaper.cn/newsDetail_forward_2652246) | 2018年報道、本文取得済み | 《起筷吃饭》の筷子表現と批判の経緯 |

## 不採用の記録（厳密採点の証跡）

| 要件 | 候補 | 不採用の理由 |
| --- | --- | --- |
| KR-hazard（改訂） | [Asia News Network工場火災74人](https://asianews.network/south-korea-factory-fire-leaves-74-casualties-exposes-deadly-risks-of-overlooked-hazards/) | 日付未確認 |
| KR-hazard（改訂） | [Aljazeera 2026/1/16](https://www.aljazeera.com/news/2026/1/16/south-korean-firefighters-tackle-huge-blaze-in-seouls-last-shanty-town) | 期間外 |
| KR-industry（改訂） | [Japan Forward 9/24](https://japan-forward.com/tokyo-game-show-2026-typhoon-china-boycott/) | 東京ゲームショウの話題で韓国のカフェ批判ではない |
| GB-value（現行） | [BoE公式頁](https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate) | 結果に含まれたが値の読み取りなし |
| KR-industry（現行） | [Instagram投稿](https://www.instagram.com/p/DQVUlUXgWN2/) | スニペットに日付なし |

## 失敗の記録（failedとして計上、empty採点なし）

| 要件 | 試行クエリ | 失敗 |
| --- | --- | --- |
| ID-aviation（改訂） | Jakarta airport closed Anak Krakatau September 2026 | HTTP 429 |
| ID-quake（改訂） | Java earthquake September 2026 magnitude | HTTP 429 |
| GB-value（改訂） | Bank of England base rate decision September 2026 | HTTP 429 |
| GB-time（改訂） | Bank of England rate announcement effective date September 2026 | HTTP 429 |

## KR重点追跡（不足の再調査）

- hazard: 工場火災は大田の3/23（死14・傷60、計74）と確定し期間外で除外。9/18-25のソウル災害・追悼は未確認のまま。
- industry: NikkeiのURLが途中で切れて取得失敗。FB鏡像はあるが日付未確認のため不採用。Tank Day宣伝の7日以内投稿は未確認のまま。

## KR-industry背景の確定

Tank Day宣伝は5/18（光州46周年）の tumbler 企画で、The Diplomat 5/25報道により日付・内容とも確定した。9/25投稿の7日以内要件には届かず不採用のままだが、文化的背景の根拠として残す。Nikkei頁は移動済みで取得不能。
