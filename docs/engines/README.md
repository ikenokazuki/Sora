# 判断エンジンの一覧

Sora のツールの多くは、取得した情報をそのまま返します。ここに挙げる機能は、取得元の答えをそのまま返すのではなく、Sora が自分のデータや決まりで答えを決めます。

各ページには、何を決めるのか、手元のデータと外への問い合わせ、決め方の手順、決められないときの答え、限界を書いています。

## 貿易・通関

- [商品名から HTS コードを推測する](hts-prediction.md)（`predict_hts_code`・`verify_hts_code`）
- [米国 CPSC の証明書と eFiling を判定する](cpsc-certificate.md)（`check_cpsc_certificate`）
- [HTS コードから FDA の規制を判定する](fda-regulated.md)（`check_fda_regulated`）
- [商品 1 つを関税・FDA・CPSC まとめて診断する](product-compliance.md)（`check_product_compliance`）
- [一般適合証明書（GCC）と通関の書類を作る](gcc-certificate.md)（`generate_gcc_certificate`）

## 地名・住所

- [日本の地名を気象庁の予報区に引き当てる](weather-place-names.md)（`get_weather`・`search_disaster_warnings`）
- [日本語の住所を正規化する](address-normalization.md)（`normalize_address`）
- [郵便番号と住所を引き合わせる](postal-code.md)（`search_postal_code`）
- [緯度経度から住所を探す](reverse-geocoding.md)（`reverse_geocode`）
- [地名や住所を座標にする順序](coordinate-resolution.md)（`get_elevation`・`search_poi`）
- [空港・都道府県・道路の名前を解決する](airport-road-names.md)（`get_flight_status`・`search_road_traffic`）

## 検索・取得

- [検索結果から答えの根拠を選ぶ](search-evidence.md)（`search_deep`・`search_web`・`scrape`）
- [X の投稿検索で固有名詞を落とさない](x-search.md)（`search_realtime`・`search_deep`）
- [長い字幕から問いに関係する部分を選ぶ](youtube-transcript-selection.md)（`scrape`・`search_media`・`search_deep`）
- [「明日」を日付に直して予定をまとめる](relative-dates.md)（`scrape`・`search_deep`）
- [静的な取得で足りるかを判定する](fetch-escalation.md)（`scrape` ほか）

## そのほか

- [追跡番号から配送会社を絞り込む](carrier-detection.md)（`track_package`）
- [国・地域を解決して状況を組み立てる](country-intelligence.md)（`research_country_context` ほか）
- [音から曲を特定して外れを見分ける](song-recognition.md)（`recognize_song`）
- [歌詞の取得元を順にたどって同じ曲を選ぶ](lyrics-selection.md)（`get_lyrics`）
