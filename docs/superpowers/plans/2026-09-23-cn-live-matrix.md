# CN live 到達性 2026-09-23 実測

対象回線: 当該サーバ (DNS は Cloudflare 標準に解決済み)。鍵なし・Cookie なし。

## 結果

- weibo.com/ajax/side/hotSearch: 403 (WAF)。NewsNow ミラーは 200 で live。fallback 設計どおり。
- zhihu hot-list-web: 200 live。
- toutiao hot-board: 200。50件中上位は現行話題。観測時刻で記録する前提は維持。
- wallstreet live: 200 live。
- thepaper rightSidebar: 200 live。
- cctv china_1.jsonp: 200 live。publishedAt あり。
- news.google.com/rss (zh-CN): 200。CN 任意キーワード検索の実働経路。
- Bing News RSS: `zh-CN` 市場指定では空だが、同じ中国語検索を `en-US` 市場で行うと200。2026-09-23の6分野検索で60件、元記事URLと抜粋あり。国別設定を増やさず、空結果時に共通代替市場を試す。
- top.baidu.com/api: タイムアウト。tophub.today: 403。baidu_hot は当該回線で全滅する。timeoutMs を 20秒から12秒に短縮。
- www.so.com/s: 302 無限ループ (curl) / タイムアウト (wreq)。so360_search の timeoutMs を14秒から10秒に短縮。
- m.weibo.cn (API/HTML): 302。UID 巡回案は Cookie なしでは不可。
- bing/sogou の site:weibo.com: 200 だが結果本体なし (素の fetch では不可。要ブラウザレンダリング)。
- wreq-js native: ロード正常。

## 含意

- 当該回線の CN ニュース検索は google_news + bing_news、補完は official_web + global_feeds + gdelt が実働。so360/baidu は他回線向けに残し、失敗は limitation として表示。Google/Bingの取得はWeibo投稿全文検索の代替ではない。
- Weibo 投稿本文の直接取得は不可。話題検知は NewsNow ミラー経由の熱搜、記事は CCTV/ThePaper/Wallstreet で補う構成。
