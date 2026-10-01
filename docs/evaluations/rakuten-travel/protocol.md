# 楽天トラベル：観測した検索データの仕様

2026-10-01の公開画面・通信に基づく調査用仕様。正式なAPI契約や、Soraで採用済みの製品仕様ではない。採否と未確認事項は [feasibility.md](feasibility.md) を参照。

## 送信と匿名状態

日付指定検索フォームは `GET https://search.travel.rakuten.co.jp/ds/vacant/searchVacant` に送信する。詳細地域の指定がない東京都検索では、条件を保持した `/jparea/` へ302転送された。これは空室なしや認証失敗を意味しない。

地域選択画面が生成したリンクは次の形式だった。各パス・識別子の出典は [observed-cases.json](observed-cases.json)。URLの列挙や推測によって発見したものではない。

| 地域 | メソッド・パス |
|---|---|
| 東京駅 | `GET /ds/hotellist/Japan-Tokyo-Tokyo-Tokyo_Station_Area` |
| 京都駅 | `GET /ds/hotellist/Japan-Kyoto-Kyoto-Kyoto_Station_Area` |
| 草津温泉 | `GET /ds/vacant/searchOnsen`。`f_chu=gunma`、`f_shou=kusatsu`、`f_cok=OK00259` |

これらの観測済みリンクはCookie・Authorization・Referer・独自ヘッダーなしで200を返した。送信先は `https://search.travel.rakuten.co.jp`。公開リンクのパラメーターを維持した再送であり、全パラメーターの必須性を1つずつ除去して確定したものではない。Cookieを恒久設定する必要は、確認した直接HTTP経路では観測されなかった。

## 検索条件

| 意味 | 観測したパラメーター |
|---|---|
| チェックイン | `f_nen1`、`f_tuki1`、`f_hi1` |
| チェックアウト | `f_nen2`、`f_tuki2`、`f_hi2` |
| 大人人数・部屋数 | `f_otona_su`、`f_heya_su` |
| 子供の区分 | `f_s1`、`f_s2`、`f_y1`〜`f_y4`。今回すべて0。区分の意味は未確定 |
| 地域・温泉識別子 | `f_dai`、`f_chu`、`f_shou`、`f_sai`、`f_cok` |
| 座標による検索 | `f_latitude`、`f_longitude`、`f_km`、`f_datumType` |
| その他 | `f_sort`、`f_page`、`f_hyoji`、`f_tab` 等。必須性と全列挙値は未確定 |

年月日は別々の整数文字列で送る。`2026-10-20` の場合、`f_nen1=2026&f_tuki1=10&f_hi1=20`。自然言語から年・日付・場所を補完する処理は含めない。

## 応答の構造

Content-Typeは `text/html;charset=UTF-8`。HTMLのscript内に、JSON形式の `var ds = { ... };` がある。画面HTMLを構造化された空室JSON APIの応答だとは扱わない。抽出時はscriptを対象にJSONの境界を走査して `JSON.parse` し、`eval` やJavaScript実行による値の取り出しは行わない。

主要な値：

- `isDated`：日付指定された状態。日付未指定の参考価格との区別に必要。
- `conditions`：有効条件。値は配列。入力の年月日・人数・部屋数と一致するか確認する。
- `displayedHotels`：表示される施設ID。全施設IDや全プランの保証ではない。
- `totalResults`：検索結果件数の配列。施設の網羅性や予約成立を保証するものではない。
- `hotels[hotelId].plans[planId].rooms[roomId]`：プラン・部屋単位の金額。
- `hotels[hotelId].rooms`：観測標本では空オブジェクト。

金額の最小標本（2026-10-20〜21、大人1人・1室）：

```json
{
  "141356": {
    "plans": {
      "5109708": {
        "rooms": {
          "sma": {
            "sumTotalChargeTaxExclusive": 30910,
            "sumTotalChargeTaxInclusive": 34000,
            "taxType": "inclusive"
          }
        }
      }
    },
    "rooms": {}
  }
}
```

このプラン・部屋の画面表示は「合計34,000円（税込）」だった。フィールド名だけで全ケースの `stay_total` / `room_night` / `person_night` を確定しない。施設名・所在地・プラン説明・食事条件・キャンセル条件はこの標本にない。

HTMLのJSON-LDは確認した検索画面では `BreadcrumbList` であり、施設・空室・料金一覧の代替ではない。`ds` 以外の施設名等をHTMLから抽出して補う処理は、今回の製品実装としては採用していない。

## 解釈と失敗の境界

- HTTP 200でも `ds` がない場合、調査では「構造化状態なし」。空室なしとは判定しない。
- JSON解析失敗・必須構造の欠落は、上流形式の不一致。空配列へ置き換えない。
- 302の地域選択画面を空室検索の成功としない。
- 403・429は調査を停止。CookieやIPの切り替えで継続しない。
- 金額・件数・施設順位の差だけで条件不一致としない。在庫変動と有効条件を分けて確認する。

独立JSON APIの応答例と、埋め込みJSONの全泊・税の意味、場所解決の製品用型は未確定。この仕様を根拠に、タスク3の `unknown` を形式だけ埋めて公開しない。
