# ブラウザと複数ユーザーの隔離

## 目的

Sora を、互いに信頼できない複数のユーザーが使う共有のサービス（公開サービスなど）として動かしても、次の 5 つが守られるようにします（以下 I1〜I5）。

- **I1** 運用者の秘密（API キー・署名の秘密・DB・環境変数）が、ブラウザの中のページにも、ほかのユーザーにも届かない。
- **I2** あるユーザーの状態（Cookie・localStorage・ウォッチ・ブラウザセッション・渡した資格情報・結果・スクリーンショット）が、ほかのユーザーに見えない。
- **I3** 内部のネットワーク（ループバックの Sora 自身の API、プライベート・リンクローカル・メタデータの宛先、同じネットワークのほかのコンテナ）に、取得もブラウザも届かない。リダイレクト・DNS rebinding・IPv6 や別の書き方の IP・WebSocket・Chromium 自身の通信を含む。
- **I4** 1 人が、共有の資源（ブラウザの同時実行・セッション数・メモリ・クォータ）を使い切って、ほかのユーザーを止められない。
- **I5** ブラウザのプロセスが破られても、I1〜I3 に届かず、ほかのユーザーのブラウザにも届かない。

いまの Sora は、ユーザーが 1 人（または互いに信頼できる少数）という前提で作られています。この文書は、その前提を外すための、現状・設計・段階（PR の計画）をまとめます。

## 決定（ユーザー承認、2026-11-12）

1. 想定は「**互いに信頼できない**複数のユーザー（公開サービスなど）」。
2. 進め方は、この設計書の PR → 承認 → 小さな PR に分けて実装。マージは、その都度の承認。
3. 未決のことは、最後の「未決」に挙げる。
4. ブラウザと静的取得の本体以外のツールも点検し、同じ設計に含める（2026-11-12、ユーザーの質問「ほかのツールも問題なさそう？」）。

## 現状（2026-11-12、main の 2e7e13f で確認）

### すでにあるもの

- tenant（`src/security/tenant_context.ts`）: API キーのハッシュ（`key:<16 桁>`）。キーなしの匿名は共有の `legacy`、内部の呼び出しは `internal`。
- 静的取得のセッション・Cookie・localStorage は tenant ごと（`domain_cookies_v2`・`domain_storage_v2`、セッションキーに tenant を含む）。
- 呼び出し側が渡した資格情報（Cookie・Authorization など）つきの取得は、共有キャッシュを通らず、Cookie も保存しない。
- ブラウザの取得は、取得ごとに別の BrowserContext。`browser_action` のセッションは、所有者の鍵と tenant を検査する（`verifySessionAccess`。所有者なしの `legacy` は通す）。
- MCP のセッションごとに、有効にしたツールが分かれる。
- ページ内の通信の検査（`setupPageSecurity`）: http(s) 以外・ブロック対象のホスト・プライベート IP を、request interception で止める。応答の大きさの上限（`readBodyWithLimit`。複数のモジュールが使う）。リダイレクトで資格情報を外す `safeFetch` は書かれているが、呼び出し側がまだ無い。

### 穴

1. **tenant を作る入口がない。** `createAuthMiddleware` が受け付けるのは鍵 1 つ（`WEB_FETCHER_API_KEY`。v5 では `SORA_API_KEY`）だけで、複数人が使うと全員が同じ tenant になる。鍵未設定なら全員が `legacy`。上の分離は、この状態では働かない。
2. **ウォッチに tenant がない。** `watch_targets`・`watch_history` に tenant の列がなく、`dbListWatchTargets`・`dbGetWatchTarget`・`dbDeleteWatchTarget` は全員分に効く。通知先の webhook URL と、取得した内容も見える。
3. **資源が公平でない。** ブラウザの同時実行枠（`browserSemaphore`、メモリから導く 1〜5）は全体で 1 つ。ブラウザセッションは全体で 20 件で、いっぱいなら全体で最も古いものを閉じる（他人のセッションを追い出せる）。日次クォータは鍵ごとで、全員で 1 つ。`POST /cache/clear` は全員分のキャッシュを消す。待ち行列に時間切れがない。
4. **Chromium が 1 プロセスを全員で共有し、守りが薄い。** root・`--no-sandbox --disable-setuid-sandbox`・Sora の環境変数を丸ごと継承（`env: { ...process.env, TZ }`）。ページの renderer が破られると、同じコンテナの秘密（環境変数・DB）と、同じプロセスの他人の BrowserContext に届く。
5. **ページ内の通信の検査に隙がある。**
   - 検査は Node 側の `dnsPromises.lookup` で、ブラウザが後で別に名前を解決する。DNS rebinding で、検査のあとに宛先を内部に替えられる（攻撃の再現はしていない）。
   - 検証結果は一定時間キャッシュされる。
   - `validateHostIpDns` は、DNS の失敗を通す（`catch` で空を返す）。攻撃者が自分の DNS で最初の問い合わせだけ失敗させれば、検査を抜けられる。
   - `ALLOW_LOCAL_FETCH=true` で全部通る。
6. **静的取得も、検証した IP に接続を固定していない。** 検証は `validateHostIpDns`（`http_fetcher.ts`）、接続は wreq-js が別に解決する。
7. **`/metrics` は認証なしの公開**（`PUBLIC_PATHS`）。中身に tenant の情報が無いかは未確認。

### ほかのツールの穴（監査、2026-11-12）

ブラウザと静的取得の本体以外の、すべての外向きの通信・状態・子プロセスを、コードで点検した。**(確認)** は、監査の指摘を、私がコードを読んで確かめたもの。そうでないものは、監査の報告のままで、未確認。再現は、どれもしていない。

外向きの通信:

8. **外向きの通信は 4 系統**: (A) wreq の `fetchWithSafeRedirects`（`http_fetcher.ts:442`。URL を呼び出し側が渡す操作）、(B) Bun の `fetch` 直（固定の提供元）、(C) Bun の `fetch` の webhook（`enrichment.ts:236`）、(D) 子プロセス（Yahoo のバイナリ・address-build・rs-trafilatura）。`node:http(s)`・`net`・WebSocket のクライアントはない。宛先を呼び出し側か取得内容が決めるのは A と C。
9. **webhook の送信**（`scrape_batch`・`crawl_site`・ウォッチ。`enrichment.ts:203-259`）(確認): ホスト名と `dns.lookup` の全アドレスを検査する（DNS の失敗は拒否）が、接続は Bun の `fetch` が別に解決する。ポートの制限がなく、JSON の本文の一部は呼び出し側が決められる。
10. **URL を受けるすべての操作に、ポートの制限がない**（`scrape`・`scrape_batch`・`crawl_site`・`map_site`・ウォッチ・`check_product_compliance`・`generate_gcc_certificate`・`inspect_image`・`recognize_song`・検索語に入った URL）(確認): 公開ホストの 22・25・6379 などへ GET を送れ、応答の違いから第三者のポートを探れる。
11. **サイトマップの発見が、増幅に使える**（`map_site`・`crawl_site(listOnly)`。`scraper.ts:1153-1209・1285-1317`）(確認): robots.txt の `Sitemap:` 行と sitemapindex の `<loc>` は任意のホストを指せ（深さ 2）、本文は `response.text()` で上限がない。行の数・子の数・時間・件数にも上限がなく、クライアントが切断しても止まらない。1 回の呼び出しで、攻撃者が決めた多数の第三者へ GET を撃たせられ、メモリも食う。
12. **検索結果・フィード・GDELT が、取得先を決める**（`search_deep`・`search_web(formats)`・`research_country_context`・`official_web`）: 攻撃者が自分のページを検索結果に載せると、他人の呼び出しで Sora がそのページを取得する。止める設定は、研究系の `SORA_INTEL_SCRAPE=off` だけ。
13. **提供元の応答が決める URL を、検査なしで取りに行く**: GDELT（`lastupdate.txt` の最終行）・so360（302 の Location）・日本郵便（ページの href）。TikTok の字幕は、リダイレクト先を IP の検査だけで追う。固定の提供元への Bun の `fetch`（天気・防災・交通・法令・荷物追跡ほか）は、redirect を自動で追い、本文の上限もない。提供元が改ざん・乗っ取りにあったときだけ起きる。
14. **認証なしで、外部へ通信させられる**: `GET /health?detailed=true` は、JMA・P2PQuake・e-Gov の 3 か所へ通信する（`services/health.ts:56-58`）(確認)。キャッシュやレート制限は見つかっていない。

状態と tenant:

15. **MCP の tenant の決め方が、認証と食い違う**（`mcp.ts:119-128` と `auth.ts:23-34`）(確認): 認証は `Bearer `（大文字小文字を区別）か `X-API-Key` を見るが、MCP は `Authorization` の `Bearer <任意>`（大文字小文字を区別しない）から tenant を作る。`Authorization: bearer 任意` と `X-API-Key: 正しい鍵` を併せると、認証は通り、MCP は任意の tenant で動く。複数の鍵にしたとき、tenant ごとの上限・状態から逃げられる。
16. **共有キャッシュの規則が、資格情報の名前の一覧に頼る**（`credential_scope.ts`。キーに tenant は含めない。`scraper.ts:615-619`）(一部確認): 資格情報とみなすヘッダーは限られた名前だけ。`X-Auth`・`Api-Key`・`X-CSRF-Token`・URL 内の userinfo や token で得た内容は、共有キャッシュに入り、ほかの tenant に返りうる。tenant の保存済み Cookie で得た結果も共有される。
17. **tenant を渡さない経路**（`map`・`search_web(formats)`・ウォッチ・`inspect_image`・社会・intel の本文取得・音声の取得）は、全員が `legacy` の Cookie ジャーを共有する。
18. **ウォッチ**: 穴 2 に加えて、登録数の上限がない。`watch_check` は id を省くと、全 tenant の全件を順に取得して webhook も送る。`GET /watch/list` は `SELECT *` で、webhook URL（トークン入りが多い）と内容を、全員分返す。
19. **全員に効く操作**: `POST /cache/clear`、`POST /intelligence/country`（24 のプロバイダーへ通信し、共有 DB に保存）、`GET /intelligence/context/:id`（tenant の列がない）。ほぼすべての REST の `noCache`（上流へ直撃）。
20. **REST が `ENABLED_MODULES` で止まらない**（`src/index.ts:131-147`）: `isModuleActive` を見るのは lyrics・shazam・hts-archive だけで、watch・media・crawl・map・scrape・social・intel・trade・youtube などは見ない。運用者が無効にしても、外向きの口が REST に残る。

資源:

21. **利用者の文字列から作る正規表現・セレクタに、長さと個数の上限がない**（`html_parser.ts:698-710`: crawl の `includePatterns`・`excludePatterns` の `*` を `[^/]*` に直して `new RegExp`）(確認): `*a*a*a*a*b` のようなパターンと、長いリンクを並べた自分のサイトで、メインの 1 スレッドを止められる（ReDoS）。
22. **セマフォの外でブラウザを開く経路**（UPS・FedEx・DHL の追跡は、API の資格情報がないと必ず `browser_track.ts`。Weibo の匿名セッション）(一部確認: `browser_track` は `browserSemaphore` を使わない): 同時に開くページ数に上限がなく、1 ページ約 300MB の見込みで、並列の呼び出しでメモリが尽き、プロセスごと全員が落ちうる。
23. **`browser_action` の所要時間に上限がない**（`actions` の件数・`wait` の ms・`timeout` は 0 や巨大値も可）: 枠の数だけ投げると、全員のブラウザ描画が止まる。`sessionId` は呼び出し側が決められ、作成時に重複を検査しない。
24. **DB・メモリが増える一方**: `cache_entries` に行数と容量の上限がない(確認)。`domain_cookies_v2`・`domain_storage_v2` は、大きさの上限も期限切れの削除もない。`watch_targets` も件数の上限がない。ホスト名ごとの `Map` を掃除しない。DB の書き込みの失敗は握りつぶされ、日次クォータは失敗時に通す。
25. **共有の絞り・ブレーカー・待ち行列**: Yahoo（429 が 1 回で全員を 120 秒止める。待つ数の上限なし）・Nominatim（直列のキュー）・country intel（同時 4 件。待ちに時間切れなし）・住所データの構築（同時 1 件。予算 2GB を全員で共有）。1 人の連打で、全員が待つか止まる。
26. **重い処理を、1 スレッドで・上限なしで**: 30MB の PDF の解析・20MB の音声の展開（共有の Chromium）・gzip の同期解凍。入力の上限は、本文 10MB だけ。クォータは要求の数だけで、20 URL の一括も crawl 50 ページも 1 回と数える。認証の失敗に絞りがない。

秘密とプロセス:

27. **子プロセスが環境変数を丸ごと継承する**（Yahoo のバイナリ `yahoo.ts:202`・`address_builder.ts:40`・`rs_trafilatura.ts:33`。`spawn` に `env` の指定がない）(確認: yahoo): 通信する子プロセスに、運用者の秘密が渡る。
28. **利用者が渡した音声が、共有の Chromium（root・`--no-sandbox`）のメディアデコーダーに入る**（`audio_decode.ts:55-70`。`recognize_song`。`setupPageSecurity` なしのページで `decodeAudioData`）(確認): ブラウザの乗っ取りの入口になる。
29. **`TRUST_PROXY=true` かつ `ALLOW_LOCAL_NO_AUTH=true` のとき、認証を外せる**（`auth.ts` の `resolvePeerLocal`）(確認): クライアントが書ける `X-Forwarded-For` の先頭の値を信じる。
30. **webhook URL（トークン入りが多い）をそのままログに出す**（`enrichment.ts:231・252・256`）。`/docs`・`/swagger` が、SRI なしの CDN のスクリプト（unpkg の `swagger-ui-dist@5` の浮動版）を読み、CSP がない。GCC の証明書は、certifier を省くと、運用者の `SORA_GCC_CERTIFIER` の名前・住所・連絡先が利用者の出力に入る。

問題なしと確認されたのは、宛先が固定のホストだけで、入力が表・正規表現・エンコードを通ってから固定のホストのパスやクエリに入るもの（youtube・lyrics・music・gov・life・disaster・traffic・geocoding・poi・tracking・trade のデータ層・x_detail・address 系・社会の固定の提供元など）と、tenant・ブラウザセッションの所有者検査・MCP のツールの有効化・SQL のバインド変数・子プロセスの引数（配列・検証済み JSON・シェルなし）。

### 実測（2026-11-12）

公開イメージ（sha-dd656db: Bun 1.4.4・Debian の Chromium 156.0.8078.79）を、rootless Podman 5.7.0 で動かした。スクリプトは `isolation-experiments/`。

- **E1**: ページ（about:blank）から 127.0.0.1 への `fetch` と WebSocket は、`setupPageSecurity` の有無によらず届かない（ループバック側のサーバーには何も来ない）。Chromium 自身の制限（ローカルネットワークへのアクセス制限と見られる。原因の特定はしていない）。一方、ページの遷移（`page.goto`）は届く（検査なしで 200）。つまり、DNS rebinding で遷移先をループバックにされる経路は、この制限では塞がらない。
- **E2・E3b**: root の Chromium は `--no-sandbox` なしでは起動を拒否される。**非 root（65532）なら、既定の seccomp のままで、サンドボックス有効で動く。** `chrome://sandbox` は、PID・ネットワークの namespace と seccomp-bpf がすべて有効で、「You are adequately sandboxed.」。Docker の既定の seccomp での確認は、まだ（この環境に Docker がない）。
- **E3a**: root の Sora 本体から、Bun の `node:child_process` も `Bun.spawn` も、`uid`・`gid` を指定して子プロセスを起こせる（65532 で動いた）。puppeteer の `pipe: true`（TCP のデバッグポートを開かない接続）も、Bun で動く。
- **E5**: 出口プロキシの試作。Chromium に `--proxy-server`・`--proxy-bypass-list=<-loopback>`・`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1` を付けると、公開の https ページ（example.com）は、プロキシが名前を解決して接続した上で 200 で開く。ループバック（IP でも名前でも）とメタデータの IP は、すべてプロキシに回り、プロキシが拒否し、ループバックのサーバーには何も届かなかった。Chromium 自身の背景通信（Google への更新確認・時刻・アカウントなど）も、プロキシに見えた（試作の Chromium の引数での観測。Sora の起動引数での確認は、実装の PR で行う）。
- **E6**: Bun 1.4.4 の `fetch` は、実行中に設定した `HTTPS_PROXY`・`HTTP_PROXY` を守り、ループバックも既定でプロキシに回す（`NO_PROXY` を設定すると外れる）。`proxy` オプションも効く。
- **E8**（サンドボックス有効・非 root と、従来の root・`--no-sandbox`）: canvas のハッシュ・WebGL の vendor/renderer/パラメータ/ピクセル・navigator・画面・フォントのどれにも、**差がない**。
- **E9・E10**（パイプ接続の安定性。Chromium 148）: **Bun 1.4.4 は、起動と終了 15 回・5 並行 ×3・強制終了（SIGKILL）の検知（`disconnected`）・再起動が、すべて通る。** **Bun 1.3.3 は、同じ耐久試験で「Connection closed.」になり、並行の起動のテストのあとに、パイプ接続が 60 秒止まった**（1 回ずつの操作と、12MB の応答は通る）。パイプは、Bun 1.4.4 以上でだけ使う。
- **E11**（イメージの中。Bun 1.4.4・Chromium 156・root）: Sora の起動のまま、パイプで起動し（`--remote-debugging-pipe` があり、ポートの引数がない）、12MB の文字列と縦長のフルページ・スクリーンショットが完全に届く。強制終了は 50ms で検知し、次の `getBrowser()` が新しいブラウザを起動して描画できる。
- **E12**（PR 1c。ビルドしたイメージの中。Bun 1.4.4・Chromium 156・root・rootless Podman の既定）: Sora の起動のまま、Chromium が **uid 65532・補助グループなし**で動き、サンドボックスは有効（`chrome://sandbox` が「You are adequately sandboxed.」）。root の Sora 本体からは読める `/proc/<Sora の pid>/environ` を、Chromium に `file://` で開かせても、読めない。プロファイルは `/tmp/sora-chromium-*`（所有者は Chromium の uid・0700）で、`closeSharedBrowser()` のあとに消える。ユーザー名前空間を拒否する seccomp（`unshare`・`setns`・`CLONE_NEWUSER` つきの `clone`・`clone3` を拒否。Docker の既定と同じ種類のもの）をかけると、最初の起動が失敗して警告を出し、`--no-sandbox` に戻して起動し、同じ検査を通る（サンドボックスは off、uid は 65532 のまま）。実際の Docker の既定の seccomp での確認は、まだ。起動用バイナリは 376KB で、イメージの大きさはほとんど変わらない。落とした Chromium は dumpable でなくなるので、root でも `CAP_SYS_PTRACE` が無ければ `/proc/<pid>/environ` は読めない。この検査は `scripts/browser-isolation-check.ts` で、`scripts/verify-image.sh` が、CI のイメージのビルドで回す。

## 設計

### 0. 水準を 1 つのスイッチに

設定を増やさず、水準で切り替える（名前は未決の 1 を参照）。

- **`standard`（既定）**: ユーザーが 1 人、または互いに信頼できる少数。**見えない硬化だけ**を入れ、挙動を変えない（環境変数の許可リスト・Chromium を別 uid で・パイプ接続・サンドボックスの自動判定・DNS の失敗は閉じる）。
- **`strict`（共有のサービス）**: 起動時に次を要求し、満たさなければ起動を拒否する。名前つきの複数の鍵（匿名なし）・Chromium のサンドボックス有効・出口のゲートウェイ・tenant ごとのブラウザ・tenant ごとの上限。

### 1. 出口のゲートウェイ（I3）

すべての外向きの通信（ブラウザ・静的取得・Bun の `fetch`・子プロセス）の、唯一の出口にする。

- DNS を**ここで 1 回だけ**解決し、宛先 IP を検査し、**検査した IP に接続を固定する**（検査と接続の間の差をなくす）。DNS の失敗は**閉じる**。ポートは既定で 80・443 だけ（設定で広げる）。
- 検査する宛先は、数値に直した IP の範囲で判定する（文字列の前方一致にしない）: 0/8・10/8・100.64/10・127/8・169.254/16・172.16/12・192.0.0/24・192.0.2/24・192.168/16・198.18/15・198.51.100/24・203.0.113/24・224/4・240/4、IPv6 の `::`・`::1`・`fc00::/7`・`fe80::/10`・`ff00::/8`・`2001:db8::/32`・`100::/64`。IPv4 射影（`::ffff:a.b.c.d`）・NAT64（`64:ff9b::/96`）・6to4（`2002::/16`）は、中の IPv4 で判定する。`0x7f.1`・`2130706433`・`0177.0.0.1` のような別の書き方も、数値にしてから判定する。
- **ブラウザ**（E5 で実測）: `--proxy-server` でゲートウェイを指す。`--proxy-bypass-list=<-loopback>` で、ループバックもゲートウェイに通す（付けないと、Chromium はループバックだけプロキシを使わない）。`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE <ゲートウェイ>` で、ブラウザ自身の名前解決を全部失敗させる（直接の解決・接続の抜け道を塞ぐ）。`--disable-quic` で、UDP の抜け道を塞ぐ。WebRTC は既存の設定（`disable_non_proxied_udp`）。
- **静的取得**: wreq-js の proxy にゲートウェイを指定する。TLS は端から端のままで、ClientHello は変わらない（変わらないことは、`scripts/tls-fingerprint/run.ts` を、ゲートウェイ経由でも回して確かめる）。
- **Bun の `fetch` と子プロセス**（穴 8 の B・C・D。E6 で実測）: Bun の `fetch` は、実行中に設定した `HTTP_PROXY`・`HTTPS_PROXY` を守る（ループバックも既定でプロキシに回る。`NO_PROXY` を設定すると外れるので、`strict` では空にする）。`globalThis.fetch` を包んで `proxy` を付けても同じ。これで、webhook・固定の提供元・提供元の応答が決める URL（穴 9〜14）が、同じゲートウェイを通り、接続の固定・ポートの制限・DNS の失敗は閉じる、がそのまま効く。子プロセスは、同じ環境変数を引き継ぐ（Go 製の Yahoo のバイナリが守るかは未確認）。
- ゲートウェイは、CONNECT と、`http://` の転送（絶対 URI の要求）の両方に対応する（E5 の試作は CONNECT だけ）。
- 運用者の外向きのプロキシ（`SORA_PROXY_*`）があるときは、ゲートウェイからそのプロキシへつなぐ。最終の宛先 IP は上流のプロキシが解決するので、検査は名前と IP リテラルまでになる（上流のプロキシが内部に届かないことは、運用者が保証する）。
- 動く場所: 既定は Sora のプロセスの中（`Bun.listen`、ループバックの 1 ポート）。別コンテナ構成（3）では、別のコンテナで動かす（同じコードを別の入口で起動）。
- Chromium 自身の背景通信は、起動フラグで元から止める（`--disable-background-networking`・`--disable-component-update` など。止めても指紋に出ないことを確かめてから）。
- 限界: 乗っ取られたブラウザは、フラグを無視して直接つなげる。これは 2（別 uid・サンドボックス）と 3（ネットワークで閉じる）が受け持つ。

### 2. ブラウザのプロセス（I1・I5）

- **uid を落とす起動は、小さな起動用バイナリ（`native/chromium-launcher`。Rust）に任せる**（PR 1c）。`puppeteer.launch` は uid を渡せないので、`executablePath` に起動用バイナリを渡し、本物の Chromium の場所と落とし先の uid・gid を環境変数で伝える。起動用バイナリは、`PR_SET_NO_NEW_PRIVS` を立て、gid・uid を落とし、その環境変数を消してから Chromium を `exec` する（uid・gid が 0 の指定は断る）。puppeteer の起動・パイプ接続・終了の扱いをそのまま使えるので、当初案の自前の `spawn` と `puppeteer.connect({ transport })` は要らなくなった。Sora が root でないとき、または起動用バイナリが無いときは、これまでどおり直に起動する。
- **環境変数は許可リストだけ**: `PATH`・`TZ`・`LANG`・`HOME`（プロファイルの場所）と、フォント・描画に要るもの（実測して決める）。運用者の秘密は渡さない。
- **別 uid**: root の Sora 本体から、65532 以降の uid で起動する。プロファイルは、その uid だけが読める一時ディレクトリ（0700）に置き、終了時に消す。Sora が root でないとき（開発機など）は、uid を切り替えない。PR 1c で実装した（既定は 65532。`SORA_BROWSER_UID` で別の数か `off`。プロファイルは `/tmp/sora-chromium-*`）。tenant ごとの uid の池は、段階 6。
- **tenant ごとのプロセスと uid**（`strict`）: tenant ごとに別のプロセス・別の uid（uid の池から割り当てる）。同じコンテナの中でも、ほかの tenant のプロセスの `/proc`・プロファイル・シグナルに届かない。プロセス数の上限と、使われなくなったプロセスの閉じ方（LRU）が要る。コンテナを増やさずに、tenant を分けられる。
- **サンドボックスを有効にする**（`--no-sandbox` を外す）: E2・E3b のとおり、rootless Podman の既定で動く。Docker の既定の seccomp ではユーザー名前空間が作れず、動かない見込み（未検証）。そこで 3 段階にする。`auto`（既定。試して、使えなければ `--no-sandbox` に戻して警告し、状態を `/health` に出す）・`on`（使えなければ起動しない。`strict` の既定）・`off`。PR 1c で実装した（`SORA_BROWSER_SANDBOX`）。`auto` が試すのは、プロセスで最初の起動の 1 回だけで、結果を覚える（使えない環境で、起動のたびに 1 回余計に失敗しないように）。サンドボックスで起動できたあとの失敗は、戻さずに投げる。root のまま起動する（`SORA_BROWSER_UID=off` か起動用バイナリが無い）ときは、サンドボックスを使えないので、`on` は起動の計画の時点で断る。テスト（`NODE_ENV=test`）の既定は `off`。`/health` への表示は、`/health` の認証を決める段階（未決の 8）で入れる（認証なしの口に「サンドボックス off」を出さないため）。いまは、戻したときの警告のログだけ。
- **CDP はパイプ**（TCP のデバッグポートを開かない）。Bun 1.4.4 以上でだけ使い（`browserCdpMode`。実測 E9・E10）、それ未満はポートのまま。`SORA_BROWSER_PIPE` で上書きできる。PR 1b で入れた。
- **利用者のバイト列を処理する用途**（`recognize_song` の音声のデコード。穴 28）は、`strict` では、その tenant の専用のブラウザのプロセス（uid の池の 1 枠）で、`setupPageSecurity` を付けたページで、ナビゲーションなしに行う。長期的には、ブラウザを使わないデコーダーにする。
- **ブラウザを開くすべての経路**（追跡の `browser_track`・Weibo・音声のデコード）を、`browserSemaphore` と tenant の上限の下に置く（穴 22）。
- 取得の途中で乗っ取られても、ほかの tenant に届かないよう、プロセスの寿命は短くする（使われなくなったら閉じる。いまの再利用の回数の上限も残す）。

### 3. ブラウザを別コンテナに隔離する構成（任意・最も強い）

運用者が、さらに強くしたいときの構成。Sora 本体とは別のコンテナで Chromium を動かし、ネットワークも分ける。なお、Podman・Kubernetes の「pod」（ネットワークを共有するコンテナの組）とは違う。pod では、ブラウザと本体が同じネットワークに入り、分けられない。ここでは、ネットワークを共有しない別々のコンテナを、内部のネットワークでつなぐ。

- 3 つのコンテナ: `sora`（秘密を持つ。ブラウザを持たない）、`sora-browser`（Chromium と小さな中継。秘密なし・非 root・読み取り専用の根・capability なし。seccomp はユーザー名前空間を許す版、または gVisor）、`sora-egress`（1 のゲートウェイ。内部と外部の両方につながる）。ブラウザは、ゲートウェイにしか届かない内部のネットワークに置く。乗っ取られても、内部にも秘密にも届かない。
- Sora とブラウザの接続は、内部のネットワークの CDP（WebSocket）と、共有の秘密のトークン。
- tenant ごとの隔離を、コンテナの単位にしたい運用者のために、接続先を tenant から引く口（URL の雛形か、小さな HTTP の問い合わせ）を用意し、Kubernetes などの外の仕組みにつなげる。**コンテナを動的に作る処理は、Sora に入れない**（コンテナ実行環境の API を Sora に渡すと、ホストの root を取られうるため）。
- gVisor は、`sora-browser` を `runsc` で動かす案内だけを docs に書く。
- compose と Quadlet の例は `docs/operations/` に置く。

### 4. tenant（I2）

- **鍵ファイル**: 名前つきの複数の鍵（JSON。`name`・鍵（またはそのハッシュ）・`limits`・`admin`）。tenant の ID は、鍵のハッシュではなく**名前**から作る（鍵を入れ替えても、tenant の状態が消えない）。単一の鍵（`SORA_API_KEY`）は、従来どおりで、tenant は鍵のハッシュ。
- 鍵ファイルがあるときは、匿名を拒否する（`SORA_ALLOW_ANONYMOUS` は無視）。全体に効く操作（キャッシュの全消去・メトリクス）は、`admin` の鍵だけ。
- 鍵の比較は、定数時間で、鍵の数によらず一定の時間にする。
- **tenant の決め方を 1 か所にする**（穴 15）: 認証のミドルウェアが決めた tenant（`c.get('tenant')`）だけを使い、MCP も生のヘッダーから作らない。`Bearer` の解釈は、大文字小文字を区別しない形（RFC 7235）で、認証と MCP をそろえる。
- **`X-Forwarded-For`**（穴 29）: 信頼するプロキシの段数から数えた位置の値を使う（先頭を信じない）。`strict` では `ALLOW_LOCAL_NO_AUTH` を無視する。

### 5. 状態の分離（I2）

- **ウォッチ**: `watch_targets` に `tenant_id` の列を足す（マイグレーション。既存の行は `legacy`）。一覧・取得・更新・削除・履歴・巡回の実行のすべてを、tenant で絞る。
- **共有キャッシュ**（穴 16・17）: 共有してよいのは、資格情報も保存済みセッション（Cookie など）も使わずに得た結果だけ。**呼び出し側がヘッダーか Cookie を 1 つでも渡した取得は、共有キャッシュを使わない**（資格情報の名前の一覧には頼らない。無害なヘッダー（`Accept-Language` など）だけを、許可リストで除く）。保存済みセッションを使って得た結果は、共有キャッシュに入れない（または tenant をキーに含める）。tenant を渡さない経路をなくす（すべての経路が tenant を受け取る。型で必須にする）。
- **`POST /cache/clear`**: 呼んだ tenant の分だけ。全体は `admin`。
- **ブラウザセッション**: 所有者なしの `legacy` セッションは、`strict` では使えない。1 tenant あたりの上限を設ける。全体の上限に達したら、他人を追い出さず、新しい作成を断る（429）。
- **`/metrics`**: `strict` では、`admin` の鍵かループバックだけにする（中身に tenant の情報が無いかを確認する）。
- **ウォッチ・intel・全体に効く操作**（穴 18・19）: `watch_check` の id 省略は、呼んだ tenant の全件だけ。`POST /intelligence/country`・`GET /intelligence/context/:id` に tenant を付ける。全体に効く操作は `admin` の鍵だけ。
- **REST にも `ENABLED_MODULES` を適用する**（穴 20）: 運用者が無効にしたモジュールの口は、REST でも閉じる（ルーターの入口で一括して見る）。
- **`/health?detailed=true`**（穴 14）: `strict` では、認証つきにするか、結果をキャッシュして絞る（未決の 8）。

### 6. 資源の公平（I4）

- ブラウザの同時実行枠（`browserSemaphore`）を、tenant ごとの上限つきの公平な待ち行列にする。待ち時間の上限を超えたら、429 と `Retry-After`。静的取得の同時実行も同じ。
- tenant ごとのクォータ（いまの日次に加えて、分あたり）・セッション数・セッションの最長の時間・1 回のリクエストの時間とバイト数。
- 同じ宛先ホストへの丁寧さ（`throttleDomain`）は、tenant をまたいで共有する（宛先を守るため）。
- **増幅の上限**（穴 10・11・18・21・23・24・26）: サイトマップの `Sitemap:` 行の数・索引の子の数・URL の総数・本文の大きさ・1 回の全体の時間に上限を設け、`req.signal` で、切断したら止める。ウォッチは、tenant あたりの登録数と、巡回間隔の下限。crawl のパターンは、長さと個数の上限を設け、`*` の照合は、バックトラックしない実装にする（正規表現にしない）。セレクタの個数。`browser_action` の `actions` の件数・`wait` の長さ・`timeout` の上限。`sessionId` は Sora が発行し、作成時に重複を検査する。
- **共有の絞り・ブレーカー・待ち行列**（穴 25）: 待つ数と待ち時間に上限を設け、超えたら 429。Yahoo の 429 のブレーカーは、1 人の連打が全員を止めないよう、tenant ごとの予算で先に止める。
- **DB・メモリ**（穴 24）: `cache_entries` の行数と容量の上限と、期限切れの掃除。`domain_cookies_v2`・`domain_storage_v2` の大きさの上限と期限。ホスト名ごとの `Map` の掃除。DB の書き込みの失敗は、握りつぶさずに数える。
- **重い処理**（穴 26）: PDF のページ数、音声の長さと展開後の大きさ、同時実行の数に上限を設ける。

### 7. 秘密と資格情報（I1・I2）

- ブラウザのプロセスに、運用者の秘密を渡さない（2・3）。
- tenant が渡した資格情報は、その tenant のブラウザのプロセスと BrowserContext の中だけで扱い、ログに出さず、保存しない（いまのとおり）。
- 鍵ファイルは 0600。鍵を DB に平文で置かない。
- エラーメッセージとログに、ほかの tenant の URL や内容を入れない。
- 子プロセスにも、環境変数の許可リストを使う（ブラウザと同じ関数）。webhook URL は、ログにホスト名だけを出す（穴 27・30）。
- `/docs`・`/swagger` は、版を固定し、SRI と CSP を付ける（未確認: ここに入力した API キーが読まれうるか）。

### 8. 見える化

- セキュリティのカウンタ（`incrementSecurityCounter`）に、`sora_egress_denied_total`（理由別）・`sora_tenant_rejected_total`（理由別）・ブラウザのサンドボックスの状態を足す。
- `/health` に、水準・サンドボックス・ゲートウェイの状態を出す。

## 段階（PR の計画）

マージは、その都度の承認。各 PR は、`standard` で今までの挙動を変えない。

1. **ブラウザの起動**（2 の前半）: 別 uid・許可リストの環境変数・パイプ・サンドボックスの自動判定。子プロセスの環境変数の許可リストと、webhook URL のログ（穴 27・30）も、ここで。3 つの PR に分けた。1a = 子プロセスの環境変数の許可リストと webhook のログ（#92）、1b = CDP をパイプに（#93）、1c = 別 uid の起動と、サンドボックスの自動判定（#95）。
2. **出口のゲートウェイ**（1）: ゲートウェイ・ブラウザ・wreq・Bun の `fetch`・子プロセスの 4 系統を通す・DNS の失敗は閉じる・ポートの制限。ハーネスで、ゲートウェイ経由でも ClientHello が変わらないことを確かめる。
3. **tenant**（4）: 複数の鍵・MCP の tenant の一本化・`X-Forwarded-For`（穴 15・29）。
4. **状態の分離**（5）: ウォッチ・共有キャッシュの規則・intel・全体に効く操作・REST のモジュール・`/health`（穴 14・16〜20）。
5. **資源の公平と増幅の上限**（6）: tenant ごとの上限・待ち行列の時間切れ・サイトマップ・ウォッチ・正規表現・`browser_action`・DB の上限（穴 21〜26）。
6. **tenant ごとのブラウザ**（2 の後半）: uid の池。
7. **ブラウザの別コンテナ構成**（3）: イメージ・接続モード・運用の例。
8. **`strict` の起動検査と、運用の文書。**

順序の理由: 1・2 は、ユーザーが 1 人でも効き、ほかの前提になる。3 は 4〜6 の前提。7 は、ほかが入ってからでも、`standard` の運用者を待たせない。

## テスト

- **単体**: IP 範囲の判定の表（IPv4 射影・NAT64・6to4・別の書き方・IPv6 の省略形）。ゲートウェイ（DNS の失敗・rebinding の模擬リゾルバー・CONNECT 先がループバック・リダイレクト先がプライベート・ポート）。
- **tenant**: 2 つの tenant で、ウォッチ・セッション・キャッシュ・Cookie の横断を、すべて拒否する。
- **統合（イメージの中）**: ブラウザの環境変数が許可リストだけ・uid が違う・サンドボックスの状態・ゲートウェイを通らない通信が失敗する・rebinding するページで内部に届かない。
- **負荷**: 1 tenant が枠を使い切っても、別の tenant が、自分の上限の中で処理される。
- **ほかのツール**: MCP で `Authorization: bearer 任意` と正しい `X-API-Key` を併せても、別の tenant にならない。ヘッダー名を変えても、資格情報つきの取得が共有キャッシュに入らない。`Sitemap:` を数百行並べた robots.txt で、外向きが上限で止まる。`*a*a*a*a*b` のパターンが、時間内に終わる。ウォッチが、ほかの tenant に見えない。`ENABLED_MODULES` で無効にしたモジュールの REST が、404 になる。

## 互換性（挙動が変わるところ）

- `standard` で変わりうるのは、DNS の失敗を閉じること（検査の DNS が失敗したら、取得を始めない。いまは、取得側の解決に任せて続ける）と、ブラウザのプロセスの uid・環境変数・サンドボックス（使えるときだけ）。取得結果・指紋は変えない。
- ブラウザの通信をゲートウェイ経由にすること（`standard` でも入れるか）は、未決の 5。入れる場合、HTTP/3（QUIC）は使えなくなる（静的取得の指紋とは、むしろそろう）。
- 上限（増幅・ウォッチ・`browser_action` など）は、`standard` では緩い既定値にして、今までの利用を止めない。`strict` で締める。
- `strict` は、新しい水準で、既存の運用者には影響しない。

## 範囲外

- コード実行の隔離（別の設計。`docs/code-execution.md`）。
- 課金・利用規約・不正利用の判定（ここでは、クォータとレート制限まで）。
- カーネル・ホストの硬化（コンテナ実行環境の仕事。別コンテナ構成で、推奨の設定を示す）。
- Chromium の更新の速さ（別の話。週次の確認が遅れを知らせる）。

## 未決

1. 水準を切り替える環境変数の名前と値（案: `SORA_ISOLATION=standard|strict`）。v5 の環境変数の整理（`2026-11-11-env-vars-design.md`）の登録簿に合わせる。
2. `strict` が、1 つのコンテナ（uid の池 + サンドボックス）で足りるとするか、別コンテナ構成（3）を必須とするか。案: 足りるとする（別コンテナ構成は、さらに強くしたい運用者の任意）。
3. 鍵ファイルの形式（JSON の案）と、鍵の保存（平文かハッシュか）。
4. Docker の既定の seccomp で、Chromium のサンドボックスが使えるか（未検証）。使えないときの案内（ユーザー名前空間を許す seccomp のファイルを配る）。
5. ゲートウェイ経由にすることを、`standard` でも入れるか（案: `standard` は PR 2 のあと、ハーネスの結果を見てから既定にする）。
6. ゲートウェイの既定のポートの制限（案: 80・443 だけ）。
7. 増幅の上限の値（案: `Sitemap:` 行 5・索引の子 20・URL の総数 5 万・サイトマップ 1 本 10MB・1 回の全体 30 秒。ウォッチは tenant あたり 50 件・間隔の下限 15 分。`browser_action` は `actions` 50 件・`wait` 1 回 30 秒・`timeout` の上限 120 秒）。
8. `/health?detailed=true` を、`strict` で認証つきにするか（監視の使い方に影響する。案: 認証つきにし、結果を 1 分キャッシュする）。
9. 共有キャッシュを、「ヘッダーか Cookie を 1 つでも渡したら使わない」にしてよいか（命中率が下がりうる。案: はい）。
