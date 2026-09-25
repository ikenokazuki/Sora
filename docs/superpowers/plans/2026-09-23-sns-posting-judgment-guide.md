# 国・地域インテリジェンス利用ガイド（2026-09-23）

`research_country_context` は金融、マーケティング、旅行、SNS投稿判断などに使う汎用の情報収集ツール。結論や推奨は返さず、出典付きの事実と不足情報を返す。

## 初回実行

- 指定地域について、対応する取得先をオンデマンドで並列実行する。定期巡回はしない。
- ニュースは国コードから推定した言語で一般・経済・政治・観光・感染症・災害を検索する。Google NewsとBing Newsを別経路として使い、地域と記事の関係、公開日時、出典を残す。
- 通常応答は分野ごとの代表証拠を返す。取得した全件は `contextId` で `get_country_context` または REST の `/intelligence/context/:contextId` から参照できる。個別本文は `get_country_context_evidence` から取得できる。`verbose=true` は全件応答。
- `includeSocial=true` で構成済みSNS投稿を加える。日本ではYahooリアルタイムの日本語投稿を取得する。中国のWeibo熱搜は話題ランキングであり、投稿全文検索ではない。

## LLMが確認する点

1. `providerCoverage`、`limitations`、`recentContext.sources` で失敗・空結果・分野別の不足を確認する。成功した取得先も網羅性は保証しない。
2. 証拠の `regionLink` を見る。`direct` は発生国の根拠あり、`related` は対象国への言及あり、`candidate` は検索条件だけで地域未確認。媒体の所在国や言語だけで発生国を断定しない。
3. `publishedAt`、`retrievedAt`、`actualWindows` で鮮度を確認する。Google/Bingのニュース検索は直近7日を優先し、要求期間全体の完全収集とは別。
4. `evidenceDetails.contentKind` を確認する。Google News RSSは主に見出しのみ。Bing Newsは元記事URLと短い抜粋を返す。本文が必要なら取得済み本文・元記事・追加調査で裏取りする。
5. `domainContext` は用途別の証拠候補。金融、旅行、マーケティングの判断自体は利用側で行う。`missingInformation` を無視して確信を高めない。

## 2026-09-23 実環境確認

8か国でフル実行し、地域関連の証拠と用途別の代表証拠を返した。件数は取得経路別で、同じ出来事の記事を含む。完全性の指標ではない。

| 国 | 地域関連証拠 | Google News | Bing News |
|---|---:|---:|---:|
| 日本 | 140 | 53 | 43 |
| 米国 | 202 | 39 | 32 |
| フランス | 107 | 57 | 26 |
| 中国 | 199 | 49 | 56 |
| ドイツ | 71 | 40 | 23 |
| インド | 125 | 50 | 28 |
| ブラジル | 89 | 57 | 28 |
| インドネシア | 89 | 44 | 30 |

中国ではWeibo直取得が403だが、熱搜のミラーと複数の現地記事取得先は動作した。`baidu_hot` と `so360_search` はこの回線で失敗し、結果に不足として残る。日本では `includeSocial=true` の実行でYahooリアルタイムが30投稿を返し、日本語投稿に限る注記が付いた。

## SNS投稿判断での使い方

投稿案、対象読者、予定時刻を `recentContext`、`keyEvents`、`calendar`、`domainContext.content` の証拠と照合する。話題ランキングは賛否や世論調査ではない。投稿内容に関係する分野が不足する場合は、元記事や追加の検索グラウンディングで補い、なお不足する点を明示する。
