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

- tenant（`src/security/tenant_context.ts`）: API キーのハッシュ（`key:<16 桁>`）。キーなしの匿名は共有の `legacy`（かつては、ループバックからの鍵なしの通過が使う `internal` もあった。PR 3c で、機能ごと廃止した）。
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
   - `validateHostIpDns` は、DNS の失敗を通す（`catch` で空を返す）。攻撃者が自分の DNS で最初の問い合わせだけ失敗させれば、検査を抜けられる。（PR 2c-2 で、Sora の手元で名前を引いて接続するときは、閉じた。下の「実装の状態」）
   - `SORA_FETCH_ALLOW_PRIVATE_NETWORK=true`（v4 までは `ALLOW_LOCAL_FETCH`）で全部通る。
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

15. **MCP の tenant の決め方が、認証と食い違う**（`mcp.ts:119-128` と `auth.ts:23-34`）(確認。E20 で再現。PR 3a で閉じた): 認証は `Bearer `（大文字小文字を区別）か `X-API-Key` を見るが、MCP は `Authorization` の `Bearer <任意>`（大文字小文字を区別しない）から tenant を作る。`Authorization: bearer 任意` と `X-API-Key: 正しい鍵` を併せると、認証は通り、MCP は任意の tenant で動く。複数の鍵にしたとき、tenant ごとの上限・状態から逃げられる。
16. **共有キャッシュの規則が、資格情報の名前の一覧に頼る**（`credential_scope.ts`。キーに tenant は含めない。`scraper.ts:615-619`）(確認。E25 で再現。PR 4a で閉じた): 資格情報とみなすヘッダーは限られた名前だけ。`X-Auth`・`Api-Key`・`X-CSRF-Token`・URL 内の userinfo や token で得た内容は、共有キャッシュに入り、ほかの tenant に返りうる。tenant の保存済み Cookie で得た結果も共有される。
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
29. **`TRUST_PROXY=true` かつ `ALLOW_LOCAL_NO_AUTH=true` のとき、認証を外せる**（`auth.ts` の `resolvePeerLocal`）(確認。E20 で再現。PR 3c で、機能ごと廃止して閉じた): クライアントが書ける `X-Forwarded-For` の先頭の値を信じる。
30. **webhook URL（トークン入りが多い）をそのままログに出す**（`enrichment.ts:231・252・256`）。`/docs`・`/swagger` が、SRI なしの CDN のスクリプト（unpkg の `swagger-ui-dist@5` の浮動版）を読み、CSP がない。GCC の証明書は、certifier を省くと、運用者の `SORA_GCC_CERTIFIER` の名前・住所・連絡先が利用者の出力に入る。

問題なしと確認されたのは、宛先が固定のホストだけで、入力が表・正規表現・エンコードを通ってから固定のホストのパスやクエリに入るもの（youtube・lyrics・music・gov・life・disaster・traffic・geocoding・poi・tracking・trade のデータ層・x_detail・address 系・社会の固定の提供元など）と、tenant・ブラウザセッションの所有者検査・MCP のツールの有効化・SQL のバインド変数・子プロセスの引数（配列・検証済み JSON・シェルなし）。

### 実測（2026-11-12）

公開イメージ（sha-dd656db: Bun 1.4.4・Debian の Chromium 156.0.8078.79）を、rootless Podman 5.7.0 で動かした。スクリプトは `isolation-experiments/`。

- **E1**: ページ（about:blank）から 127.0.0.1 への `fetch` と WebSocket は、`setupPageSecurity` の有無によらず届かない（ループバック側のサーバーには何も来ない）。Chromium 自身の制限（ローカルネットワークへのアクセス制限と見られる。原因の特定はしていない）。一方、ページの遷移（`page.goto`）は届く（検査なしで 200）。つまり、DNS rebinding で遷移先をループバックにされる経路は、この制限では塞がらない。
- **E2・E3b**: root の Chromium は `--no-sandbox` なしでは起動を拒否される。**非 root（65532）なら、既定の seccomp のままで、サンドボックス有効で動く。** `chrome://sandbox` は、PID・ネットワークの namespace と seccomp-bpf がすべて有効で、「You are adequately sandboxed.」。Docker の既定の seccomp（と AppArmor）では、サンドボックスを有効にした起動が失敗する（E12。GitHub Actions のランナーの Docker で確かめた）。ユーザー名前空間を許す seccomp（`deploy/seccomp-sora.json`）を渡せば、動く（E13）。
- **E3a**: root の Sora 本体から、Bun の `node:child_process` も `Bun.spawn` も、`uid`・`gid` を指定して子プロセスを起こせる（65532 で動いた）。puppeteer の `pipe: true`（TCP のデバッグポートを開かない接続）も、Bun で動く。
- **E5**: 出口プロキシの試作。Chromium に `--proxy-server`・`--proxy-bypass-list=<-loopback>`・`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1` を付けると、公開の https ページ（example.com）は、プロキシが名前を解決して接続した上で 200 で開く。ループバック（IP でも名前でも）とメタデータの IP は、すべてプロキシに回り、プロキシが拒否し、ループバックのサーバーには何も届かなかった。Chromium 自身の背景通信（Google への更新確認・時刻・アカウントなど）も、プロキシに見えた（試作の Chromium の引数での観測。Sora の起動引数での確認は、実装の PR で行う）。
- **E6**: Bun 1.4.4 の `fetch` は、実行中に設定した `HTTPS_PROXY`・`HTTP_PROXY` を守り、ループバックも既定でプロキシに回す（`NO_PROXY` を設定すると外れる）。`proxy` オプションも効く。
- **E8**（サンドボックス有効・非 root と、従来の root・`--no-sandbox`）: canvas のハッシュ・WebGL の vendor/renderer/パラメータ/ピクセル・navigator・画面・フォントのどれにも、**差がない**。
- **E9・E10**（パイプ接続の安定性。Chromium 148）: **Bun 1.4.4 は、起動と終了 15 回・5 並行 ×3・強制終了（SIGKILL）の検知（`disconnected`）・再起動が、すべて通る。** **Bun 1.3.3 は、同じ耐久試験で「Connection closed.」になり、並行の起動のテストのあとに、パイプ接続が 60 秒止まった**（1 回ずつの操作と、12MB の応答は通る）。パイプは、Bun 1.4.4 以上でだけ使う。
- **E11**（イメージの中。Bun 1.4.4・Chromium 156・root）: Sora の起動のまま、パイプで起動し（`--remote-debugging-pipe` があり、ポートの引数がない）、12MB の文字列と縦長のフルページ・スクリーンショットが完全に届く。強制終了は 50ms で検知し、次の `getBrowser()` が新しいブラウザを起動して描画できる。
- **E12**（PR 1c。ビルドしたイメージの中。Bun 1.4.4・Chromium 156・root・rootless Podman の既定）: Sora の起動のまま、Chromium が **uid 65532・補助グループなし**で動き、サンドボックスは有効（`chrome://sandbox` が「You are adequately sandboxed.」）。root の Sora 本体からは読める `/proc/<Sora の pid>/environ` を、Chromium に `file://` で開かせても、読めない。運用者の DB（`src/db.ts` が 0600 で作る。Cookie・キャッシュを持つ）も、落とした uid からは `EACCES`（DB と `-wal`・`-shm`。ディレクトリは `/data` と同じ 0755）。プロファイルは `/tmp/sora-chromium-*`（所有者は Chromium の uid・0700）で、`closeSharedBrowser()` のあとに消える。ユーザー名前空間を拒否する seccomp（`unshare`・`setns`・`CLONE_NEWUSER` つきの `clone`・`clone3` を拒否。Docker の既定と同じ種類のもの）をかけると、最初の起動が失敗して警告を出し、`--no-sandbox` に戻して起動し、同じ検査を通る（サンドボックスは off、uid は 65532 のまま）。実際の Docker の既定の seccomp・AppArmor（GitHub Actions のランナー）でも、同じ確認が通った: 最初の起動が失敗して警告が出て、`--no-sandbox` に戻り、uid は 65532 のまま、サンドボックスは off。起動用バイナリは 376KB で、イメージの大きさはほとんど変わらない。落とした Chromium は dumpable でなくなるので、root でも `CAP_SYS_PTRACE` が無ければ `/proc/<pid>/environ` は読めない。この検査は `scripts/browser-isolation-check.ts` で、`scripts/verify-image.sh` が、CI のイメージのビルドで回す。`--cap-drop=ALL` では、落とすのに要る capability が無く、最初の実装は、プロファイルの `chown` が `EPERM` になって、ブラウザが起動しなかった。直した形: 足りなければ、警告して従来どおり（uid 0）で動く（`scripts/browser-capdrop-check.ts`）。`--cap-drop=ALL` に `CHOWN`・`DAC_OVERRIDE`・`KILL`・`SETGID`・`SETUID` だけを足せば、uid 65532 に落ち、プロファイルも後始末される（`chown` のあとの `chmod` は `CAP_FOWNER` が要るので、順序を逆にした）。`KILL` が無いと、root の Sora は、別 uid の Chromium に信号を送れず（`kill(2)`: 送り手が特権を持つか、実 uid が対象の実・保存 uid と同じである必要がある）、puppeteer の後始末の `process.kill(pid, 0)` が `EPERM` になって、Bun が異常終了する（サンドボックスの起動に失敗したあとなど。2 回に 1 回ほど。GitHub の Docker の CI で見つけ、手元でも再現した。最初は 4 つで足りると考えていた）。この 2 つも、`verify-image.sh` が回す。なお、`--cap-drop=ALL` では、既定の seccomp が `chroot`（`CAP_SYS_CHROOT` の条件つき）を許さなくなり、サンドボックスの起動も失敗して、戻る。
- **E13**（PR 1d。Docker でサンドボックスを使う条件）: GitHub Actions のランナー（Ubuntu 26.04・kernel 7.0・Docker 29.4.2・`kernel.apparmor_restrict_unprivileged_userns=1`）で、公開イメージの Chromium を、非 root（65532）で、`--no-sandbox` なしに直接起動した（`--headless=new --dump-dom about:blank`）。(A) 既定の seccomp・既定の AppArmor: 失敗（`Failed to move to new namespace: ... errno = Operation not permitted`）。(B) `deploy/seccomp-sora.json`（既定の AppArmor）: 成功。(C) B に `apparmor=unconfined`: 失敗。(D) `seccomp=unconfined`: 成功。(E) 両方 unconfined: 失敗。(F) B に `--cap-drop=ALL`: 成功。(G) B に `no-new-privileges`: 成功。C・E が失敗するのは、このホストの sysctl が、AppArmor の制限を受けない（unconfined な）プロセスのユーザー名前空間を禁じるため。docker-default に閉じ込められた状態のほうが、使える。足す syscall の最小の組み合わせ（rootless Podman。moby 29.9.3 の既定に足す）: 既定の capability では `clone`・`unshare`（`setns` は要らない）。`--cap-drop=ALL` では、`chroot`（既定では `CAP_SYS_CHROOT` の条件つき）も要る。Sora のイメージの中（`verify-image.sh` の 6・7）では、`SORA_BROWSER_SANDBOX=on` で、`--cap-drop=ALL` に 5 つの capability と `no-new-privileges` を重ねた構成でも、サンドボックスが有効になり、`chrome://sandbox` が有効と答える。
- **E14**（PR 2a。手元の確認）: ゲートウェイを、既定の設定で起動し、Bun の `fetch`（`proxy` オプション）から、実際のサイトに届くかを確かめた。直接: `https://example.com/` は 200（CONNECT）、`http://example.com/` も 200（転送）。`https://127.0.0.1/`・`http://169.254.169.254/`・`https://example.com:8443/` は、いずれも 403（`private_ip`・`private_ip`・`port`）。上流（このホストの、運用者のプロキシ。CONNECT 専用）を指定すると、`https://example.com/` は 200。`http://example.com/` は、上流が 405 で断る（上流の制約。ゲートウェイの拒否ではない）。内部・メタデータ・許していないポートは、上流を指定しても、ゲートウェイが 403 で拒否する。単体テストは 100 件余りで、実装を 1 か所ずつ壊して、テストが落ちることを確かめた。
- **E15**（PR 2b-2。ブラウザをゲートウェイに通す確認。`scripts/browser-egress-check.ts`）: Sora の `getBrowser()` を `SORA_EGRESS_GATEWAY=on` で起動し、Chromium の起動の引数と通信を確かめた。起動の引数は `--proxy-server=http://127.0.0.1:<ポート>`・`--proxy-bypass-list=<-loopback>`・`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`・`--disable-quic`。(1) 既定の方針: `http://127.0.0.1:<ポート>/` は 403 と `X-Sora-Egress-Deny: private_ip`、`https://127.0.0.1:<ポート>/` はトンネルの失敗、`http://2130706433:<ポート>/`（別の書き方）も断られ、宛先のサーバーには、要求が 1 件も届かない（拒否のカウンターが増える）。(2) 名前の解決: OS では解決できない名前（`web.test`）の宛先に、ゲートウェイが（差し替えた resolver で）解決して届き、宛先は origin-form の `GET /p?x=1` を受ける。(3) ClientHello: ゲートウェイ越し（SNI `capture.test`）と直接（`SORA_EGRESS_GATEWAY=off`。SNI `localhost`）を、`diffHellos` で比べると、SNI 以外の全項目（暗号スイート・拡張の種類と順序・署名アルゴリズム・ALPN・鍵共有・ECH・ALPS など）が同じ。手元の Chromium 148、イメージの Chromium 156（Debian。rootless Podman の既定）、サンドボックス有効・`--cap-drop=ALL` に 5 つ・`no-new-privileges`・`deploy/seccomp-sora.json` の構成の、どれでも通った。確認が壊れたときに失敗することは、実装を壊して確かめた（ブラウザにゲートウェイの引数を渡さない・名前解決を止める引数を外す・ループバックをプロキシから外さない、のどれも失敗した。最後のものは、内部のサーバーに要求が届いて検出）。`verify-image.sh` の 8（既定の運用）・9（硬化した運用）が、CI のイメージで回す。実在のサイトでの補足: ECH を公開する Cloudflare の `https://crypto.cloudflare.com/cdn-cgi/trace`・`https://www.cloudflare.com/cdn-cgi/trace` を、手元の Chromium 148 とイメージの Chromium 156 で、直接（`SORA_EGRESS_GATEWAY=off`）とゲートウェイ越しで開くと、4 通りとも `http=http/2 tls=TLSv1.3 sni=plaintext`（実際の ECH は、どちらでも使われない = 差なし）。DoH などで HTTPS レコードを引く環境では、直接のときだけ ECH を使いうるが、未確認。
- **E16**（PR 2c-1。静的取得をゲートウェイに通す確認。`scripts/static-egress-check.ts`）: `fetchWithSafeRedirects`（wreq-js）を `SORA_EGRESS_GATEWAY=on` で動かして確かめた。(1) DNS rebinding（取得の前の検査の DNS では解決できない名前が、ゲートウェイの解決では 127.0.0.1 になる）: http は 403 と `X-Sora-Egress-Deny: private_ip`、https は接続の失敗で、宛先のサーバーには、要求が 1 件も届かない（拒否のカウンターが増える）。(2) 名前の解決: OS では解決できない名前（`web.test`）の宛先に、ゲートウェイが解決して届き、宛先は origin-form の `GET /p?x=1` を受ける。(3) ClientHello: ゲートウェイ越し（SNI `capture.test`）と直接（`SORA_EGRESS_GATEWAY=off`。SNI `localhost`）を、`diffHellos` で比べると、SNI 以外の全項目が同じ。手元（npm の wreq-js・`chrome_149`）と、イメージ（自前の native）の、どちらでも通った。確認が壊れたときに失敗することは、実装を壊して確かめた（wreq にゲートウェイを渡さない・ゲートウェイが内部の IP も通す、のどちらも失敗した）。平文 http の要求の頭部は、ゲートウェイを通しても、wreq が出した順序・表記のままで（`Host` は先頭）、違うのは `Host`（宛先の名前）と、末尾に付く `Connection: close` だけ（単体テスト `src/http_fetcher_egress.test.ts`。ゲートウェイの書き換えを 4 通りに壊して、すべて検出した）。`verify-image.sh` の 10 が、CI のイメージで回す。実在のサイトでの補足（2026-11-12。手元から直接）: `fetchWithSafeRedirects` で、`https://example.com/`・`http://example.com/`・`http://www.cloudflare.com/`（https への転送）・`https://www.cloudflare.com/cdn-cgi/trace`・`https://ja.wikipedia.org/wiki/日本`（本文 1.7MB）・`https://www.yahoo.co.jp/` を、ゲートウェイなし・ありで取ると、状態コード（すべて 200）・最終の URL・本文の大きさ（動的な部分を除く）・所要時間が同じ（`cdn-cgi/trace` は、どちらも `http=http/2 tls=TLSv1.3`）。許していないポートの `https://example.com:8443/` は、ゲートウェイなしでは 6 秒の時間切れ、ありでは 16ms で接続に失敗する（ゲートウェイが拒否。理由は、呼び出し側には出ず、カウンター `sora_egress_denied_port_total` に出る）。
- **E17**（PR 2d。Bun 1.4.4 の `fetch` と、ゲートウェイ（自前）。手元の確認）: `fetch(url, { proxy })` で確かめた。(1) 内部の宛先は、ゲートウェイが断る: `http://127.0.0.1:…` は 403（`private_ip`）、`http://localhost:…` は 403（`blocked_host`）、`https://127.0.0.1:…`（CONNECT）は `ERR_PROXY_TUNNEL`（宛先には何も届かない）。(2) **環境変数 `NO_PROXY` が宛先を挙げていると、`proxy` を指定しても、無視されて、直接つなぐ**（`NO_PROXY=127.0.0.1,localhost` で、ゲートウェイを指定した `http://127.0.0.1:…` が、宛先に届いた）。実行中に設定した `NO_PROXY` も、すぐ効く。(3) 名前（`web.test`）は、ゲートウェイが解決して届く。本文は、文字列・Uint8Array・Blob・FormData・Request オブジェクトのどれも、そのまま届く。長さが先にわからない（ストリームの）本文は、ゲートウェイが 400（`bad_request`）で断る（呼び出し元には、無い）。302 の追従（相対 URL）・5MB の本文・連続 40 件・並列 60 件は、すべて通る。`fetch.preconnect` がある（ゲートウェイを通らない。呼び出し元には、無い）。
- **E18**（PR 2d。同梱の Yahoo 検索バイナリ。イメージの中）: バイナリは、**Go ではなく Rust**（reqwest・hyper・tokio を含む）。環境変数 `HTTPS_PROXY` を、手元の待ち受け（要求行を記録して 403 を返すだけ）に向けて呼ぶと、`CONNECT search.yahoo.co.jp:443` が、そこに届いた（守る）。断られると、直接つながず、`Error: error sending request for url (…)`（`isError: true`）を返す。`NO_PROXY=search.yahoo.co.jp` を足すと、**プロキシを使わず、直接つないだ**（実際の検索結果が返り、待ち受けには何も来なかった）→ 子プロセスの環境から `NO_PROXY`・`ALL_PROXY` を消す。
- **E19**（PR 2d。Bun の `fetch` と子プロセスをゲートウェイに通す確認。`scripts/fetch-egress-check.ts`）: イメージの中（Bun 1.4.4）で、`SORA_EGRESS_GATEWAY=on`、環境変数 `NO_PROXY` に内部の宛先（127.0.0.1・localhost）と確認で使う名前を挙げたまま、`installEgressFetch()` を入れて確かめた。(1) Bun の `fetch`: `http://127.0.0.1:…`・`http://localhost:…` は 403（ゲートウェイが、解決の前に断る）、`https://127.0.0.1:…` は接続の失敗で、内部のサーバーには何も届かない。名前（`web.test`。OS では解決できない）は、ゲートウェイが解決して、宛先に origin-form の要求が届く。(2) 同梱の Yahoo 検索バイナリ（`callYahooMcp`）: `search.yahoo.co.jp` を、ゲートウェイが解決し（確認では、内部の IP に解決する名前にしてある）、内部の IP は断られ、バイナリは、直接つながずに `isError` を返す。(3) 住所データの構築の子プロセス（Bun）の `fetch` が、ゲートウェイ経由で、宛先に届く。**陰性対照**（配線を 1 か所ずつ壊す）: Yahoo の子プロセスがゲートウェイを指さない・構築の子プロセスがゲートウェイを指さない・`NO_PROXY` を外さない（内部のサーバーに 200 で届いた）・`fetch` に `proxy` を付けない・子プロセスの `NO_PROXY` を消さない、の 5 通りは、すべて、確認が失敗した（Yahoo のバイナリは、実際の検索結果を返した）。
- **E20**（PR 3a の前。main の 4debce3 で、穴 15・29 を再現した。手元の確認）: 本物のアプリ（認証のミドルウェア → MCP）に、`SORA_API_KEY` を設定して送った。穴 15: 正しい `X-API-Key` に `Authorization: bearer attacker-chosen-a`（小文字）を併せて初期化すると 200 でセッションができる（認証は `X-API-Key` で通る）。そのセッションを、正しい `X-API-Key` だけで続けると **404**（同じ鍵の同じ利用者が、自分のセッションを続けられない）、最初と同じ任意の bearer で続けると **200**（任意の文字列で、別の tenant になれる）。正しい鍵を小文字の `bearer <鍵>` だけで送ると、認証が **401**（RFC 7235 では scheme は大文字小文字を問わない）。穴 29: `SORA_AUTH_TRUST_PROXY=true`・`SORA_AUTH_LOOPBACK_NO_KEY=true` で、利用者が `X-Forwarded-For: 127.0.0.1` を付け、プロキシが本当の接続元 `198.51.100.7` を右に足した（`127.0.0.1, 198.51.100.7`）要求が、鍵なしで **200**（内部の tenant）。プロキシが足しただけの `198.51.100.7` は 401。
- **E21**（PR 3a。Bun 1.4.4 の `Bun.serve` が報告する接続元。手元の確認。この設定は、PR 3c で廃止した）: `Bun.serve({ port })`（`src/index.ts` と同じ。hostname 無し）は、IPv4 の `127.0.0.1` からの接続を **`::ffff:127.0.0.1`**（family は IPv6）と報告し、`localhost`（IPv6）からの接続は `::1` と報告する。`hostname: '127.0.0.1'` で待ち受けると `127.0.0.1`（IPv4）。`isLoopbackAddress` は `::ffff:127.0.0.1` をループバックと認めない（単体テストが固定している）ので、**`SORA_AUTH_LOOPBACK_NO_KEY=true` は、本物のサーバーでは、IPv4 の直接接続に効かない**（`::1` には効く）。閉じる側に外れていて、危険ではない。直すと通る範囲が広がるので、この PR では直していない（未決 11）。
- **E22**（PR 3a。認証の入口の確認。`scripts/auth-check.ts`。(3)(4) の `X-Forwarded-For` の場面は、PR 3c で機能ごと廃止したので、いまの確認にはない）: 本物のアプリを、待ち受けを `127.0.0.1` に固定した本物の `Bun.serve`（本物の TCP・接続元・HTTP の読み取り）に載せて、HTTP で叩いた。(1) 同じ鍵は、`X-API-Key`・`Bearer`・`bearer`・`BEARER` のどれでも、同じ tenant（セッションを続けられる）。誤った Bearer と正しい `X-API-Key` を併せると 401。(2) `SORA_ALLOW_ANONYMOUS=true` で、鍵を持つ利用者と匿名は別の tenant（互いのセッションは 404）。匿名どうしは、任意の bearer を付けても同じ scope。(3) `SORA_AUTH_TRUST_PROXY=true`: 利用者が左に書いた `127.0.0.1`（`127.0.0.1, 198.51.100.7`）は 401、右端がループバック（`198.51.100.7, 127.0.0.1`）は 200。`X-Forwarded-For` を 2 行に分けて送っても、Bun は 1 つの列として束ね、右から数える（左の行の `127.0.0.1` は効かない）。IP アドレスでない値（`localhost`・ポートつき・短縮形）は 401。`SORA_AUTH_PROXY_HOPS=2` は右から 2 番目で、段数に足りない列は 401。(4) `SORA_AUTH_TRUST_PROXY` なしでは、`X-Forwarded-For`・`X-Real-IP` つきの要求は、鍵なしで通らない。手元のイメージ（Bun 1.4.4・rootless Podman）でも通った。**陰性対照**（実装を 1 か所ずつ壊す）: Bearer を大文字小文字を区別して読む・先頭の値を信じる・段数を無視する・段数に足りないとき接続元に落とす・IP アドレスかを見ない・`X-Forwarded-For` つきを直接の接続とみなす・MCP に tenant を渡さない・MCP が生のヘッダーから tenant を作る・`SORA_AUTH_TRUST_PROXY` を見ない、の 9 通りは、すべて、確認が失敗した。`verify-image.sh` の 12 が、CI のイメージで回す。
- **E23**（PR 3b。鍵ファイルの確認。`scripts/auth-check.ts` の (4)）: 本物のアプリを `Bun.serve` に載せ、鍵ファイル（alice の 2 つの鍵・bob のハッシュの鍵）で確かめた。MCP: alice の 2 つの鍵（`X-API-Key`・`bearer`・`BEARER`）は同じセッションを続けられ、bob は 404（逆も 404）。鍵なし・知らない鍵・誤った bearer と正しい `X-API-Key` は、`SORA_ALLOW_ANONYMOUS=true` でも 401。REST の `/scrape`（手元のサイトの Cookie）: alice の 2 つの鍵はサイトごとの Cookie を引き継ぎ（`sess=1`、`sess=2`）、bob には見せない。鍵ファイルを読めない（起動のあとに壊れた）と、鍵なし・鍵つき・MCP のすべてが 503（`SORA_ALLOW_ANONYMOUS=true`・`SORA_AUTH_LOOPBACK_NO_KEY=true` でも匿名・鍵なしの通過にならない）。**陰性対照**: name から tenant を作らない・知らない鍵を通す・鍵ファイルのとき設定なしでループバックを通す・読めないとき匿名で通す・鍵ファイルのとき匿名を認める・tenant の ID に鍵を混ぜる・SHA-256 にせず鍵をそのまま引く・同じ name の 2 つ目の鍵を捨てる、の 8 通りは、確認が失敗した（起動の検査が読んだ表を覚えることは、単体テストが確かめる）。`verify-image.sh` の 12 が、CI のイメージで回す。
- **E24**（PR 3c。「接続元がループバック」の信頼性の実測。rootless Podman 5.7.0・Bun 1.4.4・イメージ `sora-uid-sandbox`。手元の確認）: (1) コンテナの IPv6 を `net.ipv6.conf.{all,default,lo}.disable_ipv6=1` で無効にしても、`Bun.serve({ port })` は、コンテナの中からの `127.0.0.1` への接続を `::ffff:127.0.0.1`（family は IPv6）と報告する。IPv4 の直接接続には、環境によらず、`isLoopbackAddress` が効かない（E21 の裏づけ）。(2) 公開したポート（`-p`）へのホストからの接続は、コンテナの中では、ループバックに見えない。pasta（既定）: ホストの `127.0.0.1` から → `::ffff:162.43.91.12`（ホスト自身の IP）、ホストの公開 IP から → `::ffff:169.254.1.2`、wg0 から → `::ffff:10.13.13.1`。`slirp4netns`（rootlesskit の転送）: どちらも `::ffff:10.0.2.100`。`slirp4netns:port_handler=slirp4netns`: `::ffff:10.0.2.2` と実際の公開 IP。bridge: どちらも `::ffff:10.88.0.2`。つまり、ポートの転送がループバックに見せるという心配は、否定された（Docker の docker-proxy は測っていない）。残る危険は、**同じホストのリバースプロキシが `X-Forwarded-For` を足さない**構成とホストネットワーク（どちらも、ソケットの相手が本当にループバックになる）。この実測と、「接続元を認証の代わりにしない」考えから、鍵なしのループバック通過を、直さず、廃止した（ユーザーの判断、2026-11-13）。
- **E25**（PR 4a の前。保存済みの状態で得た結果が、共有キャッシュ経由で、別の tenant に返る。main の 61d47f9。手元の確認）: 手元のサーバーは、Cookie が `sess=ALICE` なら個人向けの本文、無ければ公開の本文を返す。tenant alice に、このホストの保存済みの Cookie を持たせ、alice → bob → carol の順に、同じ URL を `scrapeUrl` した。alice は個人向けの本文を得て、**bob も carol も、同じ個人向けの本文を `cached: true` で得た**（サーバーへの要求は最初の 1 回だけ）。共有キャッシュのキーに tenant が無く、共有してよいかの判定（`hasSensitiveRequestCredentials`）が、要求に付けたヘッダー・Cookie だけを見て、tenant の保存済みの状態（`http_fetcher` が戻す Cookie、`browser_stealth` が読み込む Cookie・localStorage）を見ないため。有効期間は 30 分で、SQLite の L2 にも残る。正確さのため: 保存される状態は、**取得のときにそのサイトがセットした Cookie・localStorage**（`http_fetcher` はセッションを閉じるとき、`browser_stealth` は描画のあとに保存する）で、呼び出し側が渡した資格情報（Cookie・認証系のヘッダー）と、`browser_action` のセッションの Cookie は、保存しない。つまり、アカウントのページがそのまま返るのではなく、言語・地域・同意・閲覧履歴・カートなどの、サイトが tenant ごとに変える内容が、別の tenant に返る。同じ判定の穴は、`search_deep` の応答（読んだページの内容を含む）の共有キャッシュにもあった。`scripts/auth-check.ts` の (5) が、本物のサーバー・鍵ファイル・REST の `/scrape` で、同じ再現を回帰にしている（4a の前の実装に当てると、bob・carol に alice のページが返って失敗する）。
- **E26**（PR 4b の前。ウォッチが、別の tenant に見え、確認でき、削除できる。main の 74876b3。手元の確認）: 鍵ファイルの 2 つの tenant（watch-alice・watch-bob）で、本物のサーバー（`Bun.serve`）に REST を送った。alice が `POST /watch/register`（通知先の Webhook URL つき）で登録したあと、**bob の `GET /watch/list` に alice のウォッチ（通知先と、最後に取得した内容を含む）が出て、bob の `POST /watch/check`（alice の id）が 200 で通り、id を省いた確認が alice の分も取得し（ページへの要求が 2 回）、bob の `DELETE /watch/:id` が alice のウォッチを消した**（そのあとの alice 自身の確認は「見つからない」になった）。`scripts/auth-check.ts` の (6) が、本物のサーバー・鍵ファイル・REST で、同じ再現を回帰にしている（4b の前の実装に当てると、上の確認が失敗する）。

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
- **Bun の `fetch` と子プロセス**（穴 8 の B・C・D。E6・E17・E18 で実測）: Bun の `fetch` は、実行中に設定した `HTTP_PROXY`・`HTTPS_PROXY` を守る（ループバックも既定でプロキシに回る）。`globalThis.fetch` を包んで `proxy` を付けても同じ。ただし、**環境変数 `NO_PROXY` が宛先を挙げていると、`proxy` を付けても、直接つなぐ**（E17）ので、ゲートウェイが読み終えたあとで、プロセスの環境から `NO_PROXY` を外す。これで、webhook・固定の提供元・提供元の応答が決める URL（穴 9〜14）が、同じゲートウェイを通り、接続の固定・ポートの制限・DNS の失敗は閉じる、がそのまま効く。子プロセスは、`HTTP_PROXY`・`HTTPS_PROXY` でゲートウェイを指す（同梱の Yahoo のバイナリは Rust 製で、守る。E18）。`ALL_PROXY`・`NO_PROXY` は渡さない（Yahoo のバイナリは、`NO_PROXY` の宛先には、プロキシを使わず直接つなぐ）。
- ゲートウェイは、CONNECT と、`http://` の転送（絶対 URI の要求）の両方に対応する（E5 の試作は CONNECT だけ）。
- 運用者の外向きのプロキシ（`SORA_PROXY_*`）があるときは、ゲートウェイからそのプロキシへつなぐ。最終の宛先 IP は上流のプロキシが解決するので、検査は名前と IP リテラルまでになる（上流のプロキシが内部に届かないことは、運用者が保証する）。
- 動く場所: 既定は Sora のプロセスの中（`Bun.listen`、ループバックの 1 ポート）。別コンテナ構成（3）では、別のコンテナで動かす（同じコードを別の入口で起動）。
- Chromium 自身の背景通信は、起動フラグで元から止める（`--disable-background-networking`・`--disable-component-update` など。止めても指紋に出ないことを確かめてから）。
- 限界: 乗っ取られたブラウザは、フラグを無視して直接つなげる。これは 2（別 uid・サンドボックス）と 3（ネットワークで閉じる）が受け持つ。
- **実装の状態（PR 2a。#97）**: 核は `src/net/egress_gateway.ts`、IP の判定は `src/net/ip_policy.ts`（`browser_engine.ts` から移した。`192.0.0.0/24` を足した）。まだ、どこにもつないでいない。実装で決めたこと:
  - 待ち受けは、`Bun.listen` でなく `node:net`（E5 の試作が Chromium と動いた。背圧と半閉じを `pipe` に任せられる）。
  - 名前の解決は 1 回。答えが 1 つでも非公開なら、全体を拒否する。IP リテラルと別の書き方（`0x7f.1`・`2130706433`・`[::ffff:7f00:1]`）・内部の名前（`localhost`・`*.internal`・メタデータ）は、解決の前に拒否する。解決できない・答えが空・時間切れは、閉じる（502・`dns`）。
  - `http://` の転送は、**1 つの接続で 1 つの要求だけ**を通す: 宛先へは origin-form・`Connection: close`・`Host` は宛先から付け直す。要求本文は `Content-Length` の長さまで（`Transfer-Encoding` の要求本文・数でない値・食い違う値は 400）。頭部と同じ送信に枠を超えるバイトが混じっていたら、何も転送せずに 400。あとから届いたら、枠までを送り終えて切る。上流のプロキシへ連鎖するとき、続けて送られた別の要求（検査していない宛先への要求）が、上流に処理されるのを防ぐため。宛先側へ、クライアントの送信終了（FIN）は伝えない（要求の途中で閉じられたと見て、応答をやめるサーバーがある）。
  - 上流のプロキシは、http・https（プロキシへの接続が TLS。証明書を検証する）・socks5（名前を、名前のまま渡し、プロキシに解決させる）。資格情報は、http・https が Basic、socks5 がユーザー名・パスワード（RFC 1929）。名前の解決は上流が行うので、ここでの検査は、名前・IP リテラル・ポートまで。`parseUpstreamProxyUrl` が `SORA_PROXY_URL` などの URL を読む（`socks4://` など、ほかのスキームは、理由を添えて断る。Sora は `http://`・`https://`・`socks5://` を受け付けると書いているので、そろえた）。socks5 は、`socks` ライブラリ（MIT。依存の木にすでにあった）を直接の依存にして使い、手で書かない（PR 2b の最初の PR。#98）。
  - 上流の接続の失敗（接続できない・認証・証明書・CONNECT を断られた）は、同じ文につき 1 回だけ、警告に出す（設定の誤りに気づけるように。上流の種類と宛先は出し、資格情報は出さない）。
  - 拒否のカウンターは `sora_egress_denied_<理由>_total`（理由は `port`・`private_ip`・`blocked_host`・`dns`・`bad_request`・`limit`。`/metrics` は、名前だけのカウンターなので、理由ごとに別の名前）。応答には `X-Sora-Egress-Deny: <理由>` を付ける。接続の失敗（502）は、方針の拒否ではないので、数えない。
  - 既定の上限: 同時のクライアント接続 512・無通信 5 分・頭部 16KB・解決と接続は 10 秒。`stop()` は、中継中の接続もすべて切る。
- **実装の状態（PR 2b-2。#99。ブラウザを通す）**: `SORA_EGRESS_GATEWAY`（既定 off）が on のとき、`launchStealthChromium` が、ゲートウェイ（`src/net/egress.ts` の `getEgressGateway()`。プロセスで 1 つ。使うときに、初めて起動する）を、Chromium の起動の引数（`browserProxyArgs`）で指す。使わないユーザーには、何も起動しない。実装で決めたこと:
  - 設定は環境変数から: `SORA_EGRESS_GATEWAY`（`on`・`true`・`1`・`yes`。書き方の誤りは、起動のときにエラーにして止める。起動の検査を通らない経路でも、ゲートウェイを使うかの判定は、同じエラーにする。打ち間違いで、検査が黙って外れないため）、`SORA_EGRESS_PORTS`（誤りは、起動のときに、その名前を書いたエラー）。2 つとも、環境変数の登録簿（`src/config.ts`、領域 `egress`）に登録してあり、README の表はそこから作る（`bun run gen:env`）。`SORA_FETCH_ALLOW_PRIVATE_NETWORK=true`（内部への取得を許す設定。v4 までは `ALLOW_LOCAL_FETCH`）のときは、警告して off にする（内部を許す設定と、内部を断る設定は、同時に成り立たない）。
  - 運用者のプロキシ（`SORA_PROXY_URL`・`HTTPS_PROXY` など。優先順位はこれまでと同じ。読む処理は `src/net/proxy_config.ts` に移した）は、ゲートウェイの上流にする。`NO_PROXY` は、これまでの `--proxy-bypass-list` と同じ書き方（IP・CIDR・サブドメイン）で、ゲートウェイの `bypassUpstream` が受ける: 該当する宛先は、上流を通さず、ゲートウェイが直接つなぐ（宛先の検査は、同じに受ける）。ブラウザの `--proxy-bypass-list` は `<-loopback>` だけにして、`NO_PROXY` の宛先も、ゲートウェイを通す。
  - `getBrowser(overrideProxyUrl)`（ブラウザごとの別のプロキシ）は、ゲートウェイが有効なときは、エラーにする。黙って無視すると、ゲートウェイを迂回したと思わせるため（呼ぶ側は、いまのところ無い）。
  - ゲートウェイは、ブラウザを閉じても止めない（無操作で閉じたあとの再起動も、同じゲートウェイを使う）。起動に失敗しても、その失敗は覚えない（設定を直して、もう一度呼べる）。
  - 確認は、イメージの中で、実際のブラウザで行う（E15。`scripts/browser-egress-check.ts`）。
- **実装の状態（PR 2c-1。#100。静的取得を通す）**: `SORA_EGRESS_GATEWAY` が on のとき、`fetchWithSafeRedirects` が、`getEgressGateway()` の URL を、wreq のセッションのプロキシ（`getOrCreateHttpSession` の `proxyUrl`）にする。使わないときは、何も変わらない。実装で決めたこと:
  - 取得ごとのプロキシの指定（`proxyUrl` 引数）は、on のときはエラー（ブラウザの `getBrowser` と同じ。呼ぶ側は、いまのところ無い）。環境変数のプロキシ・`NO_PROXY` は、ゲートウェイの設定（上流・`bypassUpstream`）が受ける。
  - wreq が読み込めないときの代わり（`NativeFetchSession`。Bun の `fetch`）も、on のときは、`proxy` にゲートウェイを渡す（代わりの経路が、ゲートウェイを迂回する穴にならないように）。
  - `SORA_PROXY_LIST`（静的取得が、リクエストごとに替える一覧）は、ゲートウェイの上流が 1 つなので、一緒には使えない（`egressGatewayOptionsFromEnv` がエラー。黙って 1 つに偏らせない）。必要になったら、上流を複数にする（ブラウザは、一覧を使っていないので、用途ごとにゲートウェイを分ける必要がある）。
  - 取得の前の検査（`validateHostIpDns`）は、そのまま残す（二重の防御。on のときは、ゲートウェイが、接続の固定まで行う）。検査の DNS の失敗を閉じること（`standard` の挙動の変更）は、次の PR（2c-2）。
  - 平文の `http://` の転送は、1 接続で 1 要求（末尾に `Connection: close`）。Chrome は HTTP/1.1 で `Connection` ヘッダーを付けないので、平文の `http://` を取る要求は、その分だけ、頭部が違う。https（CONNECT）は、端から端のままで、影響が無い。
  - 確認は、イメージの中で、実際の wreq で行う（E16。`scripts/static-egress-check.ts`）。
- **実装の状態（PR 2c-2。#101。検査の DNS の失敗を閉じる。`standard` の挙動が変わる）**: `validateHostIpDns(hostname, { failClosed })` は、名前を解決できないとき（失敗か、答えが空）、`failClosed: true` なら遮断する。既定（false）は、これまでどおり、空を返して通す。実装で決めたこと:
  - 閉じるのは、**Sora の手元で名前を引いて接続するときだけ**。名前を相手（運用者のプロキシ・出口のゲートウェイ）が解決するときは、手元の DNS が失敗するのは普通なので、これまでどおり通す（一律に閉じると、DNS が使えず、プロキシが名前を解決している運用が壊れる）。静的取得は、`fetchWithSafeRedirects` が決めたプロキシ（`effectiveProxyUrl`）が無いとき。ブラウザは、`browserResolvesLocally(host, env?)`（ゲートウェイが無効で、運用者のプロキシが無いか、`NO_PROXY` の宛先）のとき。
  - 閉じる場所は 3 つ: 静的取得の検査（`fetchWithSafeRedirects`）、ブラウザの `navigate`（`browser_session.ts`）、ブラウザのページの副要求の検査（`setupPageSecurity`。中止の理由は `namenotresolved`）。副要求の検査は、答えが空のときも、同じに扱う（これまでは、空をキャッシュして通していた）。
  - 防げるのは、検査のときだけ DNS を失敗させ、接続のときに内部の IP を答える手口。検査のあとに、接続のときの解決で答えを替える DNS rebinding（穴 6）は、これでは防げず、出口のゲートウェイ（on）が受け持つ。
- **実装の状態（PR 2d。Bun の `fetch` と子プロセスを通す）**: `SORA_EGRESS_GATEWAY` が on のとき、`globalThis.fetch` を、ゲートウェイを通す包み（`src/net/egress_fetch.ts` の `installEgressFetch()`）に替え、通信する子プロセス（同梱の Yahoo 検索バイナリ・住所データの構築）の環境変数で、ゲートウェイを指す（`egressChildProxyEnv()`）。使わないときは、何も変わらない（引数は、数も中身も、元の `fetch` にそのまま渡る）。実装で決めたこと:
  - 包みは、起動の入口（`index.ts`・`stdio.ts`）が、起動時の検査のあとに、1 回だけ入れる。包みの中で、呼ぶたびに設定を読む（書き方の誤りは、使わないことにせず、エラー）。呼び出し元（約 85 か所。`fetchFn: typeof fetch = fetch` のような、差し込みの既定値を含む）は、変えない。
  - on のとき、`proxy` にゲートウェイの URL を付ける。呼び出しごとの別の `proxy` は、エラー（ブラウザ・静的取得と同じ。`proxy: undefined` の明示は、指定なしと同じ）。ゲートウェイを始められないとき（設定の誤り）は、失敗する（直接つなぐ道に落ちない）。
  - **`NO_PROXY`**（E17）: Bun は、`NO_PROXY` が挙げた宛先には、`proxy` も使わず直接つなぐ。そこで、最初の `fetch` で、ゲートウェイを作ってから（ゲートウェイは、運用者の `NO_PROXY` を、作るときに読む）、プロセスの環境から `NO_PROXY`・`no_proxy` を外す（`config.ts` の `envForgetNoProxy`。環境に触れるのは `config.ts` の中だけ、という決まりのため）。運用者の `NO_PROXY` は、これまでどおり、ゲートウェイが、上流のプロキシを使わず直接つなぐ宛先（検査は受ける）として受け持つ。
  - `fetch.preconnect`（ゲートウェイを通らない、先行の接続）は、on のとき何もしない。
  - 子プロセス: `egressChildProxyEnv()` を `childEnv()` に重ねる。`HTTP_PROXY`・`HTTPS_PROXY`（大文字・小文字）はゲートウェイの URL、`ALL_PROXY`・`NO_PROXY` は消す（E18。残すと、子が、ゲートウェイを通さず、直接つなぐ）。対象は、通信する 2 つ（Yahoo の同梱バイナリ・住所データの構築）。本文の抽出（rs-trafilatura）と Chromium の版の問い合わせは、通信しない。ゲートウェイを始められないときは、子プロセスを起こさずに失敗する。
  - **限界**: 環境変数だけの指定なので、守らない子プロセスと、乗っ取られた子プロセスは、止められない（段階 7 のネットワークの分離が受け持つ）。ストリームの要求本文は、通らない（いまの呼び出し元に無い）。ゲートウェイを有効にすると、運用者が設定した内部の宛先（自前の FxEmbed など）にも、届かなくなる。届かせる宛先は、`SORA_EGRESS_ALLOW_HOSTS` に挙げる（下の「許す宛先の一覧」。未決の 10 は決定済み）。
  - ガード（`src/egress_paths_guard.test.ts`）: 外向きの口（node:http(s)・WebSocket・`Bun.fetch`・生のソケット・UDP）は、ゲートウェイのほかに作らない。子プロセスは、通信するかを決めた 4 つのファイルだけ（通信する 2 つは `egressChildProxyEnv()` を重ねる）。入口が、検査のあとに包みを入れる。
  - **許す宛先の一覧**（`SORA_EGRESS_ALLOW_HOSTS`。未決の 10 の決定）: ゲートウェイの `allowDestinations`（`host:port`）。挙げた宛先だけ、許していないポートと、内部の名前・IP リテラルの検査を通し、解決した IP が内部でも通す。通す内部の IP は、ループバック・プライベート（10/8・172.16/12・192.168/16）・100.64/10・`::1`・fc00::/7 だけ（`ip_policy.ts` の `isAllowableInternalIp`。通す範囲を挙げ、それ以外の内部の範囲は、既定で通さない）。リンクローカル（169.254.169.254 のメタデータを含む）・未指定・マルチキャスト・予約・ドキュメント用の IP と、メタデータの名前・IP（通す範囲の中にある、Alibaba Cloud の 100.100.100.200 と AWS の IPv6 の fd00:ec2::254 を含む）は、挙げても通さない: 挙げると、起動のときにエラー（`egressGatewayOptionsFromEnv`）、名前が、そうした IP に解決されたときは、断る（内部の DNS を書き換えられても、メタデータには届かない）。名前の解決は 1 回・接続は検査した IP に固定は、同じに受ける。答えに通さない IP が 1 つでも混じれば、全体を断る。
  - 一覧の読み方は登録簿の `item`（`hostPort`）が検査して整える（名前は小文字・末尾のドットなし、IPv6 は `[ ]` で囲み URL の正規形、ポートは `port` と同じ）。照合は、挙げた側も、要求の宛先も、同じ関数（`canonicalHost`）で整えてから比べる。IP の別の書き方（`0x7f.1`・`127.1`・整数・8 進）は、一覧に書けず、要求の側も一致しない。書き方の誤りは、`SORA_EGRESS_PORTS` と同じに、起動のときにエラー。ゲートウェイを使わないとき（off・`SORA_FETCH_ALLOW_PRIVATE_NETWORK=true`）は効かないので、起動のときに警告する。
  - 運用者のプロキシがあるときは、挙げた宛先も、そのプロキシに回る（名前の解決はプロキシが行うので、検査は名前・IP リテラル・ポートまで）。内部のサーバーに直接つなぐには、同じ宛先を `NO_PROXY` にも挙げる（ゲートウェイが、プロキシを通さず、通してよい内部の IP にだけ直接つなぐ）。
  - 確認は、イメージの中で、実際の Bun・Yahoo のバイナリ・Bun の子プロセスで行う（E19。`scripts/fetch-egress-check.ts`）。

### 2. ブラウザのプロセス（I1・I5）

- **uid を落とす起動は、小さな起動用バイナリ（`native/chromium-launcher`。Rust）に任せる**（PR 1c）。`puppeteer.launch` は uid を渡せないので、`executablePath` に起動用バイナリを渡し、本物の Chromium の場所と落とし先の uid・gid を環境変数で伝える。起動用バイナリは、`PR_SET_NO_NEW_PRIVS` を立て、gid・uid を落とし、その環境変数を消してから Chromium を `exec` する（uid・gid が 0 の指定は断る）。puppeteer の起動・パイプ接続・終了の扱いをそのまま使えるので、当初案の自前の `spawn` と `puppeteer.connect({ transport })` は要らなくなった。Sora が root でないとき、または起動用バイナリが無いときは、これまでどおり直に起動する。
- **環境変数は許可リストだけ**: `PATH`・`TZ`・`LANG`・`HOME`（プロファイルの場所）と、フォント・描画に要るもの（実測して決める）。運用者の秘密は渡さない。
- **別 uid**: root の Sora 本体から、65532 以降の uid で起動する。プロファイルは、その uid だけが読める一時ディレクトリ（0700）に置き、終了時に消す。Sora が root でないとき（開発機など）は、uid を切り替えない。PR 1c で実装した（既定は 65532。`SORA_BROWSER_UID` で別の数か `off`。プロファイルは `/tmp/sora-chromium-*`）。落とすには、コンテナに capability `CHOWN`（プロファイルを渡す）・`DAC_OVERRIDE`（終了後に、別 uid 所有の 0700 を消す）・`KILL`（別 uid の Chromium に信号を送る）・`SETGID`・`SETUID`（起動用バイナリ）が要る。Docker の既定にはあるが、`--cap-drop=ALL` の運用では無く、足りないと、プロファイルの `chown` が `EPERM` になって、ブラウザが起動しなくなる（E12 の確認で見つけた）。そこで、足りないときは、`auto` は、警告して、落とさずに従来どおり起動し（`standard` の「挙動を変えない」）、数を明示したときは失敗させる（明示した設定を黙って捨てない）。`strict` は、落とせないなら起動を拒否する。tenant ごとの uid の池は、段階 6。
- **tenant ごとのプロセスと uid**（`strict`）: tenant ごとに別のプロセス・別の uid（uid の池から割り当てる）。同じコンテナの中でも、ほかの tenant のプロセスの `/proc`・プロファイル・シグナルに届かない。プロセス数の上限と、使われなくなったプロセスの閉じ方（LRU）が要る。コンテナを増やさずに、tenant を分けられる。
- **サンドボックスを有効にする**（`--no-sandbox` を外す）: E2・E3b のとおり、rootless Podman の既定で動く。Docker の既定の seccomp ではユーザー名前空間が作れず、動かない（E12）。そこで 3 段階にする。`auto`（既定。試して、使えなければ `--no-sandbox` に戻して警告し、状態を `/health` に出す）・`on`（使えなければ起動しない。`strict` の既定）・`off`。PR 1c で実装した（`SORA_BROWSER_SANDBOX`）。`auto` が試すのは、プロセスで最初の起動の 1 回だけで、結果を覚える（使えない環境で、起動のたびに 1 回余計に失敗しないように）。サンドボックスで起動できたあとの失敗は、戻さずに投げる。root のまま起動する（`SORA_BROWSER_UID=off` か起動用バイナリが無い）ときは、サンドボックスを使えないので、`on` は起動の計画の時点で断る。テスト（`NODE_ENV=test`）の既定は `off`。`/health` への表示は、`/health` の認証を決める段階（未決の 8）で入れる（認証なしの口に「サンドボックス off」を出さないため）。いまは、戻したときの警告のログだけ。Docker で有効にするには、既定のプロファイルに `clone`・`unshare`・`chroot` の許可だけを足した `deploy/seccomp-sora.json` を、`--security-opt seccomp=` で渡す（PR 1d。E13。README 4.5）。
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
- **鍵なしのループバック通過は、廃止した**（穴 29。PR 3c）: 「接続元がループバック」を認証の代わりにしない。鍵を設定したら、ループバックからでも鍵が要る。`X-Forwarded-For` を読む使い道は、この判定だけだったので、読み方（`SORA_AUTH_TRUST_PROXY`・`SORA_AUTH_PROXY_HOPS`）も廃止した。`X-Forwarded-For` を読む必要が出たとき（段階 5 の認証失敗の絞りなど）は、使い道と一緒に足し直す。`strict` で `ALLOW_LOCAL_NO_AUTH` を無視する話（段階 8）は、なくなった。
- **実装の状態（PR 3a。#104。認証の tenant の一本化。新機能なし。`X-Forwarded-For` の部分は PR 3c で廃止した）**: `extractAuthToken`（`auth.ts`）が、`Authorization` の `Bearer` を大文字小文字を区別せずに読む（あれば鍵はそれだけ。無ければ `X-API-Key`）。`McpSessionManager.handleRequest` は、生のヘッダーから tenant を作らず、呼び出し側が渡す `tenantId` を使う（渡さなければ `legacy`）。`/mcp`・`/sse`・`/message` のルートは、認証のミドルウェアが決めた `c.get('tenant')` を渡す（`mcpTenantFromRequest` は消した）。有効な鍵の tenant は変わらない（`key:<鍵の SHA-256 の先頭 16 桁>`）。変わるのは、鍵が決める tenant ではないとき: 鍵を設定していない・匿名（`SORA_ALLOW_ANONYMOUS=true` で鍵が無いか誤り）の MCP は、REST と同じ `legacy`（以前は、送ってきた文字列ごとの tenant）。（PR 3a では、`SORA_AUTH_LOOPBACK_NO_KEY` で通る MCP を REST と同じ `internal` にし、`X-Forwarded-For` を右から `SORA_AUTH_PROXY_HOPS` 番目で読む形に直したが、どちらも PR 3c で、機能ごと廃止した。） 確認は `scripts/auth-check.ts`（E22。`verify-image.sh` の 12）。REST の `/browser/action` の所有者の検査（`ownerToken` に生の鍵を渡す）は、変えていない。
- **実装の状態（PR 3b。#105。名前つきの複数の鍵）**: 設定 `SORA_AUTH_KEYS_FILE`（kind path。無ければ従来どおり）。形式は `{"keys": [{"name": …, "key": …（または "keyHash": "sha256:…"）}]}`（`src/security/api_keys.ts`）。`name` は `^[a-z0-9][a-z0-9_-]{0,63}$`、tenant の ID は `name:<name>`（`legacy`・`internal`・`key:<ハッシュ>` と混ざらない）。`key` は 16〜256 字の空白を含まない ASCII、`keyHash` は `sha256:` と 64 桁の 16 進。同じ `name` を複数の行に書ける（鍵の入れ替えの移行期。どちらの鍵も同じ tenant）。同じ鍵（平文とそのハッシュを含む）を 2 回は書けない。未対応の項目（`limits`・`admin` など、あとの段階が足すもの）は誤り（古い版が黙って無視しない）。`admin` は段階 4（全体に効く操作を締めるとき）、`limits` は段階 5 で足す。鍵の照合は、鍵を SHA-256 にして `Map` を引く（鍵の数によらず、一定の時間）。誤りは、鍵の値もハッシュも文に入れず、すべてを一度に知らせ、1 つでもあれば鍵の表を作らない。起動の検査（`startup_check.ts`）が鍵ファイルを読み、ファイルが無い・読めない・誤り・鍵が 0 件・`SORA_API_KEY` との併用は、起動を止める（鍵が無い状態を Fail-Open の匿名にしない。a1 の指摘）。読んだ表は覚え、認証は要求のたびに読み直さない（鍵を変えたら再起動。ホットリロードは、単一ファイルの bind mount が差し替えを見ないので、確実でなく、入れていない）。起動のあとに読めなくなったら、認証が要る要求をすべて 503（`AUTH_UNAVAILABLE`）で断る。鍵ファイルがあるとき、匿名は認めず（`SORA_ALLOW_ANONYMOUS` は効かず、真なら警告）、`SORA_AUTH_LOOPBACK_NO_KEY` は従来どおり（`internal`）。日次の上限は tenant の ID で数える。拒否は `sora_auth_rejected_missing_total`・`sora_auth_rejected_invalid_total` で数える（単一の鍵も）。REST の `/browser/action` の持ち主の確認は、名前つきの鍵の tenant では、鍵の値でなく tenant に任せる（セッションは tenant に結び付くので足り、鍵の入れ替えでセッションが使えなくなるのを避ける）。確認は E23（`verify-image.sh` の 12）。平文の `key` を書いたファイルを、所有者以外も読めるときは警告する。
- **実装の状態（PR 3c。#106。鍵なしのループバック通過の廃止。`standard` でも挙動が変わる）**: 消したもの: `SORA_AUTH_LOOPBACK_NO_KEY`（v4 の `ALLOW_LOCAL_NO_AUTH`）、`SORA_AUTH_TRUST_PROXY`（v4 の `TRUST_PROXY`）、`SORA_AUTH_PROXY_HOPS`、`internal` の tenant（`TenantAuthMode` から）、`resolvePeerLocal`・`isLoopbackAddress`・`getPeerAddress`・`forwardedClientAddress`、`src/index.ts` が `server.requestIP` を認証に渡す受け渡し（`remoteAddr`）。レジストリでは、5 つの名前を `REMOVED`（廃止した名前。旧名だけのとき「廃止」と警告）に移した。`TRUST_PROXY` はほかのプログラムも使う名前なので、廃止の警告に「Sora のための設定なら消してください（ほかのプログラムのものなら、そのままで構いません）」を添える（汎用の旧名の、改名の警告と同じ）。`SORA_AUTH_*` の 3 つは v5 の開発中にだけあった名前（リリースされていない）だが、イメージの `latest` を使った人のために、廃止の警告を出す。設定が残っていても読まず、鍵を設定していればループバックからでも 401（閉じる側）。ユーザーの質問「後方互換性を無視した場合でもその推奨？」（2026-11-13）への答えで、未決 11 の案（直さない）を、「機能ごと廃止」に替えた。確認は `scripts/auth-check.ts` の (3)（本物の `Bun.serve` に、旧い設定を置いたまま、`127.0.0.1` と `::1`、`X-Forwarded-For`・`X-Real-IP` つきで、鍵なしの要求が通らないこと）。廃止前の実装にこの確認を当てると失敗する（`X-Forwarded-For: 127.0.0.1` つきが通る）ことを確かめた。
- **実装の状態（PR 4a。#107。共有キャッシュと tenant。`standard` の挙動が変わるところがある）**: 方針は、ユーザーの選択（2026-11-13。案 A）: 保存済みの状態で得た結果は、その tenant のキーにだけ置く（案 B の「状態を持つ tenant は共有キャッシュを使わない」は採らない。命中率を保つため）。部品は `src/security/tenant_state.ts`（`AsyncLocalStorage` で、取得が状態を使ったかの印を集める。`trackTenantState`・`markTenantStateUsed`・`tenantStateUsed`・`tenantCacheKey`。内側の範囲の印は外側にも伝わる）。印を立てる側: `fetchWithSafeRedirects` は、取得の最初に、セッションの Cookie が 1 つ以上あれば立てる（保存済みの Cookie を戻した新しいセッションも含む。取得の途中で受け取る Cookie は数えない）。`renderWithStealthBrowser` は、保存済みの Cookie か localStorage を読み込んだときに立てる。置く側: `scrapeUrl` は、`cacheResult` が、印が立っていれば `tenant:<ID>:scrape:v11:…`（tenant のキー）、立っていなければ `scrape:v11:…`（共有のキー）に置く。読むのは、tenant のキー、共有のキーの順（`getFromCache` の `countMiss: false` で、tenant のキーの外れを数えない）。取得をまとめる（single-flight）のは、tenant のキーで（別の tenant の取得と、まとめない）。`integratedSearch` は、全体を `trackTenantState` で囲み、読んだページが状態を使ったなら、応答を tenant のキー（`tenant:<ID>:search:integrated:v14:…`）に置く。キーの版を上げた（`scrape:v10` → `v11`、`search:integrated:v13` → `v14`）ので、以前の共有のキー（状態で見える内容が入っているかもしれない）は読まれない。未決 9 の決定: Cookie か、無害と決めたもの（`accept`・`accept-language`・`user-agent`・`referer`・`cache-control`・`pragma`・`dnt`）以外のヘッダーを渡した取得は、共有キャッシュを読まず、書かない（`bypassesSharedCache`。以前は 6 つの名前の一覧だけ）。セッションの分離（`credentialScopeFor`）と、ブラウザの保存の判断（`hasSensitiveRequestCredentials`）は、変えていない。カウンター `sora_tenant_cache_write_total`（tenant のキーに置いた回数）を足した。**安全側の動き**: サイトが Cookie を出すと、その tenant の以降の取得の結果は tenant のキーに置かれ、別の tenant は取り直す（同じ tenant の繰り返しは、共有のキーから読むので、命中する）。**対象外（段階 4 の次の PR）**: `search_web` の formats の応答のキャッシュ・`map_site`・GCC・trade・国の情報は、tenant を渡さず `legacy` として動く（tenant を必須にする 4c で、同じ印を使う）。確認は E25（単体 `scrape_tenant_cache.test.ts`・`integrated_search_tenant_cache.test.ts`・`security/tenant_state.test.ts` と、`scripts/auth-check.ts` の (5)）。
- **実装の状態（PR 4b。#108。ウォッチの tenant 化。`standard` の挙動が変わるところがある）**: ユーザーの決定（2026-11-13）: 既存の行（持ち主の列ができる前に登録された行）の見せ分けの互換の規則は作らない（誰も使っていない）。列を足し、既存の行は `legacy` になるだけ。移行は `security/migrations.ts` の 102（`ALTER TABLE watch_targets ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy'` と、`(tenant_id, created_at)` の索引）。DAO（`db.ts`）: `dbGetWatchTarget(id, tenantId)`・`dbListWatchTargets(tenantId)`・`dbDeleteWatchTarget(id, tenantId)` は、tenant を必須にして絞る（別の tenant の id は、存在しない id と同じ結果）。`dbSaveWatchTarget` は、`ON CONFLICT(id) DO UPDATE … WHERE watch_targets.tenant_id = excluded.tenant_id` で、別の tenant の id への上書きをしない（保存のあと、持ち主で読み直し、読めなければ `Watch target id is not available` で断る。いま id を渡せる経路は無いが、渡せるようになっても、書き換えられない）。応答の列は `tenant_id` を含まない（`WATCH_TARGET_COLUMNS`。API の形は変えない）。サービス（`services/watch.ts`）: `registerWatchTarget({ tenantId, … })`・`checkWatchTarget(id, tenantId)`・`checkAllWatchTargets(tenantId)`・`listWatchTargets(tenantId)`・`deleteWatchTarget(id, tenantId)`（型で必須）。確認のときの取得は、持ち主の tenant で行う（以前は `legacy` で、持ち主の保存済みのセッションが使われなかった）。REST（`routes/watch.ts`）は認証が決めた tenant（`c.get('tenant')`。無ければ `legacy`）を、MCP の `watch` はセッションの tenant（`serverTenantId`）を渡す。本文や引数では、tenant も id も指定できない。履歴（`watch_history`）は、書くだけで、読む公開の口が無い（`dbListWatchHistory` はテストだけ）ので、列を足さない（読む口を作るときは、持ち主を確かめてから読む）。確認は E26（単体 `services/watch_tenant.test.ts`・`security/watch_migration.test.ts`・`routes/watch.test.ts`・`mcp_tool_params.test.ts` と、`scripts/auth-check.ts` の (6)）。

### 5. 状態の分離（I2）

- **ウォッチ**: `watch_targets` に `tenant_id` の列を足す（マイグレーション。既存の行は `legacy`）。一覧・取得・更新・削除・履歴・巡回の実行のすべてを、tenant で絞る。
- **共有キャッシュ**（穴 16・17）: 共有してよいのは、資格情報も保存済みセッション（Cookie など）も使わずに得た結果だけ。**呼び出し側がヘッダーか Cookie を 1 つでも渡した取得は、共有キャッシュを使わない**（資格情報の名前の一覧には頼らない。無害なヘッダー（`Accept-Language` など）だけを、許可リストで除く）。保存済みセッションを使って得た結果は、共有キャッシュに入れない（または tenant をキーに含める）。tenant を渡さない経路をなくす（すべての経路が tenant を受け取る。型で必須にする）。
- **`POST /cache/clear`**: 呼んだ tenant の分だけ。全体は `admin`。
- **ブラウザセッション**: 所有者なしの `legacy` セッションは、`strict` では使えない。1 tenant あたりの上限を設ける。全体の上限に達したら、他人を追い出さず、新しい作成を断る（429）。
- **`/metrics`**: `strict` では、`admin` の鍵だけにする（接続元がループバックかどうかは、認証に使わない。PR 3c）。中身に tenant の情報が無いかを確認する。
- **ウォッチ・intel・全体に効く操作**（穴 18・19）: `watch_check` の id 省略は、呼んだ tenant の全件だけ。`POST /intelligence/country`・`GET /intelligence/context/:id` に tenant を付ける。全体に効く操作は `admin` の鍵だけ。
- **REST にも `SORA_MODULES` を適用する**（穴 20。ユーザーの決定、2026-11-13: `standard` でも入れる。v5 で `ENABLED_MODULES` から改名）: 運用者が無効にしたモジュールの口は、REST でも閉じる（ルーターの入口で、操作の台帳 `rest_operations.ts` の category を引いて一括して見る）。影響を受けるのは、`SORA_MODULES` を `all` 以外に絞った運用だけ（`all` と未設定は変わらない）。
- **`/health?detailed=true`**（穴 14。ユーザーの決定、2026-11-13）: 結果を 1 分キャッシュする（`standard` でも。外向きの通信は、何人が呼んでも 1 分に 3 回まで。結果が最大 1 分古くなる）。鍵の要求（`strict` では `admin` の鍵だけ）は、`strict` の切り替えを作るとき（段階 8）に入れる。詳しくない `/health` は、コンテナの死活確認に使うので、公開のまま。

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

1. **ブラウザの起動**（2 の前半）: 別 uid・許可リストの環境変数・パイプ・サンドボックスの自動判定。子プロセスの環境変数の許可リストと、webhook URL のログ（穴 27・30）も、ここで。4 つの PR に分けた。1a = 子プロセスの環境変数の許可リストと webhook のログ（#92）、1b = CDP をパイプに（#93）、1c = 別 uid の起動と、サンドボックスの自動判定（#95）、1d = Docker でサンドボックスを使う seccomp プロファイルと、CI の確認（#96）。
2. **出口のゲートウェイ**（1）: ゲートウェイ・ブラウザ・wreq・Bun の `fetch`・子プロセスの 4 系統を通す・DNS の失敗は閉じる・ポートの制限。ハーネスで、ゲートウェイ経由でも ClientHello が変わらないことを確かめる。6 つの PR に分ける。2a = ゲートウェイの核と、IP 判定の共通化（#97。どこにもつなげない。既定の挙動は変わらない）、2b は 2 つに分けた: 2b-1 = 運用者の上流のプロキシの種類を広げる（socks5・https。#98）、2b-2 = ブラウザを通す（`SORA_EGRESS_GATEWAY=on` で有効化。#99）。2c も 2 つに分ける: 2c-1 = 静的取得（wreq）を通す（`SORA_EGRESS_GATEWAY=on` で有効化。#100）、2c-2 = 検査の DNS の失敗を閉じる（`standard` の挙動が変わる。#101）。2d = Bun の `fetch` と子プロセスを通す（`SORA_EGRESS_GATEWAY=on` で有効化。#103）。
3. **tenant**（4）: 3 つの PR に分けた。3a = MCP の tenant の一本化（#104。穴 15。新機能なし。`standard` でも、鍵が決める tenant ではないときの MCP の tenant が変わる）、3b = 名前つきの複数の鍵（#105。鍵ファイル。`SORA_AUTH_KEYS_FILE`。既定は変わらない）、3c = 鍵なしのループバック通過と `X-Forwarded-For` の読み方の廃止（#106。穴 29。`standard` の挙動が変わる）。
4. **状態の分離**（5）: 共有キャッシュの規則・ウォッチ・tenant を渡さない経路・全体に効く操作（`admin`）・REST のモジュールと `/health`（穴 14・16〜20）。5 つの PR に分ける: 4a = 共有キャッシュ（#107。穴 16。E25）、4b = ウォッチの tenant 化（#108。穴 2・18）、4c = tenant を渡さない経路を、型で必須にする（穴 17）、4d = `admin` と全体に効く操作（穴 19）、4e = REST のモジュールと `/health`（穴 14・20）。
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

- `standard` で変わりうるのは、DNS の失敗を閉じること（検査の DNS が失敗したら、取得を始めない。いまは、取得側の解決に任せて続ける。ただし、名前を相手が解決する取得（運用者のプロキシ・出口のゲートウェイ越し）は、これまでどおり。PR 2c-2）と、ブラウザのプロセスの uid・環境変数・サンドボックス（使えるときだけ）。取得結果・指紋は変えない。
- 段階 3a で `standard` でも変わるのは、(1) 鍵が決める tenant ではないときの MCP の tenant（鍵なし・匿名）、(2) `Authorization` の `bearer`（小文字）も鍵として読むことと、`Bearer` があれば `X-API-Key` を読まないこと。有効な鍵の tenant と、REST の tenant は変わらない。サイトごとの Cookie / localStorage は tenant ごとなので、(1) で tenant が変わる MCP は、以前の tenant に保存した分を引き継がない（次の取得で作り直される）。
- 段階 3c で変わるのは、鍵なしのループバック通過（`ALLOW_LOCAL_NO_AUTH`・`SORA_AUTH_LOOPBACK_NO_KEY`）と `X-Forwarded-For` の読み方（`TRUST_PROXY`・`SORA_AUTH_TRUST_PROXY`・`SORA_AUTH_PROXY_HOPS`）をやめたこと。鍵を設定していれば、ループバックからでも 401（閉じる側）。実際のサーバーでは、IPv4 の `127.0.0.1` には、もともと効いていなかった（E21・E24）ので、影響を受けるのは、`::1` で使っていた運用者だけ。v5.0.0 は未公開で、環境変数の改名ですでに破壊的な変更を含むので、今が最も安い。
- 段階 4a で `standard` でも変わるのは、(1) 共有キャッシュのキーの版（更新後の最初の取得は、キャッシュに当たらない）、(2) 保存済みの状態（Cookie・localStorage）を使った結果が、tenant のキーにだけ置かれること（tenant が 1 つなら、結果は同じ。サイトが Cookie を出すと、別の tenant は取り直す）、(3) Cookie か、無害なヘッダー（`Accept`・`Accept-Language`・`User-Agent`・`Referer`・`Cache-Control`・`Pragma`・`DNT`）以外を渡した取得が、共有キャッシュを使わないこと（以前は 6 つの名前だけで、ほかのヘッダーは、キャッシュされていた）。
- 段階 4b で `standard` でも変わるのは、(1) ウォッチの一覧・確認・削除が、持ち主の分だけになること（鍵を設定した運用の利用者は、v4 までに登録した行が見えなくなる。行は DB に残る）、(2) 確認のときの取得が、持ち主の tenant の保存済みのセッションで行われること（以前は `legacy`）、(3) 起動のときに、DB に列を足す移行（102）が 1 回走ること。
- 段階 3b の鍵ファイル（`SORA_AUTH_KEYS_FILE`）は、設定しなければ何も変わらない。設定すると、匿名を認めず（`SORA_ALLOW_ANONYMOUS` は効かない）、`SORA_API_KEY` と併用できない。
- ブラウザの通信をゲートウェイ経由にすること（`standard` でも入れるか）は、未決の 5。入れる場合、HTTP/3（QUIC）は使えなくなる（静的取得の指紋とは、むしろそろう）。
- ゲートウェイを有効にすると（既定は off）、Bun の `fetch` も、内部の宛先・許していないポートに届かなくなる。運用者が設定した内部の宛先（`SORA_X_DETAIL_BASE_URL` に指定した自前の FxEmbed など）も同じで、届かせるには `SORA_EGRESS_ALLOW_HOSTS` に挙げる（未決の 10）。`standard` の挙動は変わらない。
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
3. （決定済み、2026-11-13。案どおり）鍵ファイルは JSON で、鍵は平文の `key` と SHA-256 の `keyHash` の両方を受け付ける（1 行にどちらか 1 つ。README はハッシュを勧める）。設計書の「鍵（またはそのハッシュ）」のとおり。
4. （決定済み）Docker の既定の seccomp では、Chromium のサンドボックスは使えない（E12。GitHub Actions のランナーの Docker で確かめた）。`standard` は、`auto` が `--no-sandbox` に戻すので困らない。`strict`（`on`）の運用者のために、ユーザー名前空間を許す seccomp のファイル `deploy/seccomp-sora.json` を配る（PR 1d。README 4.5。E13）。Kubernetes は、別の形式（OCI）の `Localhost` プロファイルが要り、未確認。別コンテナ構成（3）の例には、このプロファイルを、ブラウザのコンテナにだけ渡す形で含める（案）。
5. ゲートウェイ経由にすることを、`standard` でも入れるか（案: `standard` は PR 2 のあと、ハーネスの結果を見てから既定にする）。ブラウザは E15、静的取得は E16 で、ClientHello が変わらないことを確かめた（どちらも、手元のサーバーとの比較。実在のサイトでの ECH の補足は E15）。
6. ゲートウェイの既定のポートの制限（案: 80・443 だけ）。
7. 増幅の上限の値（案: `Sitemap:` 行 5・索引の子 20・URL の総数 5 万・サイトマップ 1 本 10MB・1 回の全体 30 秒。ウォッチは tenant あたり 50 件・間隔の下限 15 分。`browser_action` は `actions` 50 件・`wait` 1 回 30 秒・`timeout` の上限 120 秒）。
8. （決定済み。ユーザーの選択、2026-11-13）`/health?detailed=true`: 1 分のキャッシュを `standard` でも入れる。鍵の要求（`strict` では `admin` の鍵だけ）は、`strict` の切り替えを作るとき（段階 8）に入れる。
9. （決定済み。ユーザーの選択、2026-11-13）共有キャッシュは、案 A: 保存済みの状態で得た結果は、その tenant のキーにだけ置く。ヘッダーか Cookie を渡した取得は、共有しない（無害な `Accept-Language` などは除く）。命中率は、下がりうる（PR 4a）。
10. （決定済み。ユーザーの指示、2026-11-13）ゲートウェイを有効にしたとき、運用者が設定した内部の宛先（`SORA_X_DETAIL_BASE_URL`・`SORA_OPENPOI_BASE_URL` に指定した自前のサーバーなど。プライベートな IP や 80・443 以外のポート）は、届かない（Bun の `fetch` も、ゲートウェイを通るため）。許す宛先を一覧で渡せるようにした: `SORA_EGRESS_ALLOW_HOSTS`（PR 2d の同じ PR）。宛先は 1 つずつ挙げ、ワイルドカード・CIDR は使えない。挙げた宛先は、利用者が指定した URL にも効く（ゲートウェイは、呼び出し元を見分けない）ので、必要なものだけを挙げる。
11. （決定済み。ユーザーの指示、2026-11-13）`SORA_AUTH_LOOPBACK_NO_KEY=true` が、本物のサーバーでは IPv4 の直接接続（`127.0.0.1`）に効かない（E21・E24）件。案は「直さない」だったが、ユーザーの「後方互換性を無視した場合でもその推奨？」への答えで、後方互換性を除くと、推奨は「機能ごと廃止」に変わった（PR 3c）。理由: IPv4 では最初から動かない機能で、直して生かす価値より、消す簡潔さが勝つ。直すと、認証全体が「ホストの手前にあるものを、運用者が間違えない」という前提に乗る。同じ便利さは、鍵を渡す・`/health` は公開・鍵を設定しなければもともと鍵は要らない・ポート公開を `127.0.0.1` に絞る、で足りる。v5.0.0 は未公開で、今が最も安い。
12. （決定済み。ユーザーの選択、2026-11-13）REST のモジュールの絞り込み（`SORA_MODULES`）を、`standard` でも入れる（影響を受けるのは、`all` 以外に絞った運用だけ）。
13. （決定済み。ユーザーの指示、2026-11-13）ウォッチの既存の行は、見せ分けの互換の規則を作らない（誰も使っていない）。持ち主の列を足し、既存の行は `legacy` にするだけ（PR 4b）。
