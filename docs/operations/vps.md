# VPS に公開する（リバースプロキシ・TLS・鍵の発行・日々の運用）

[`strict.md`](strict.md) は、Sora のコンテナを強くする手引です。この手引は、その**手前と周り**を書きます。インターネットに出すときに Sora の前に置くもの、利用者に鍵を配る仕組み、日々の運用です。

**確かめた構成:** rootless Podman で動かした公開イメージ（`SORA_ISOLATION=strict`）の手前に、Caddy 2.11 または nginx 1.28。TLS は、ローカルの認証局（Caddy の `tls internal`）で確かめました。公開ホスト名での証明書の取得（Let's Encrypt）は、Caddy・certbot の標準の動作で、ここでは確かめていません。

## 1. 全体の形

```text
利用者 ──HTTPS──▶ リバースプロキシ（TLS・本文の上限・ログ・/metrics を隠す）
                         │ HTTP
                         ▼
                 127.0.0.1:3016 の Sora（strict） ◀── 鍵のディレクトリ（読み取り専用でマウント）
                                                          ▲
                              鍵の発行の仕組み（deploy/issue-key.sh）┘ 書き込む
```

- Sora のポートは、**127.0.0.1 にだけ**開けます（`-p 127.0.0.1:3016:8000`）。外から直接つなげないようにします。
- 鍵を設定した Sora は、ループバックからの要求にも鍵を求めます（README 4.6）。同じホストのプロキシ経由で、外からの要求が鍵なしで通ることはありません（確認: プロキシ経由で鍵なしは 401）。
- Sora に、**接続元の IP ごとの上限はありません**。鍵なしの要求は Sora が 401 を返すだけですが、数を絞りたいときは、プロキシで絞ります（4 章）。Sora が `X-Forwarded-For` を使うのは、JSON ログ（`SORA_LOG_FORMAT=json`）の `ip` を書くときだけで、何かを決めるのには使いません。

## 2. Sora の起動

[`strict.md` の 1 章](strict.md#1-起動に必要なもの)の起動の例に、次の 2 つ（`-p` と `SORA_ALLOWED_HOSTS`）を足した形です（鍵のディレクトリは、5 章の `KEYS_DIR` です）。

```bash
docker run -d --name sora -p 127.0.0.1:3016:8000 \
  --security-opt seccomp=$PWD/seccomp-sora.json \
  -v "/srv/sora/keys:/run/secrets/sora-keys:ro" \
  -e SORA_ISOLATION=strict \
  -e SORA_AUTH_KEYS_FILE=/run/secrets/sora-keys/keys.json \
  -e SORA_BROWSER_SANDBOX=on \
  -e SORA_EGRESS_GATEWAY=on \
  -e SORA_ALLOWED_HOSTS=sora.example.com \
  ghcr.io/ikenokazuki/sora:latest
```

- `-p 127.0.0.1:3016:8000`: 上のとおり、手元のポートにだけ開けます。
- `SORA_ALLOWED_HOSTS`: 公開ホスト名です（**Host ヘッダーと同じ書き方**。標準のポート 443 なら、ポートは書きません）。MCP（`/mcp`・`/sse`・`/message`）と、ブラウザ上のページからの REST が、許可していない Host を 403 で断ります（確認: 許可していない Host の MCP は 403）。curl やサーバー間通信の REST は、Host を見ません。プロキシは、Host をそのまま渡します（下の例のとおり）。

## 3. Caddy

TLS を自動で取得します。HTTP/2 も使えます。

```text
sora.example.com {
	# /metrics は、鍵なしで全利用者の合計の数字が見えるので、外には出さない
	@metrics path /metrics
	respond @metrics 404

	# 本文の上限。Sora が受ける本文は小さい（URL とオプション）ので、小さく絞る
	request_body {
		max_size 2MB
	}

	# アクセスログから、鍵を除く
	log {
		output file /var/log/caddy/sora-access.log
		format filter {
			wrap json
			request>headers>X-Api-Key delete
			request>headers>Authorization delete
		}
	}

	reverse_proxy 127.0.0.1:3016
}
```

確かめたこと:

- 鍵（`X-API-Key`・`Authorization: Bearer`）は、プロキシを通って Sora に届き、管理者・一般・鍵なしが、直接つないだときと同じ結果（200・403・401）になります。
- 2 MB を超える本文は、Caddy が 413 で断ります。
- `/metrics` は 404 になります（`/METRICS`・`//metrics` も 404）。手元からは、Sora に直接（`curl http://127.0.0.1:3016/metrics`）読めます。`/health` は開けたままです（外からの死活監視用）。
- **Caddy の既定のアクセスログは、`X-API-Key` を平文で残します**（`Authorization` は `REDACTED` になります）。上の `format filter` で、どちらも除きます。除いた設定のログには、鍵の文字列が残りませんでした。
- 進行状況のストリーミング（`POST /scrape/stream`・`/crawl/stream`）は、追加の設定なしで、取得の進みに合わせて届きます（`start` と `render` はすぐ、`enrich` と `done` は取得が終わってから）。
- `SORA_ALLOWED_HOSTS` に合わない Host の要求には、Caddy が空の応答を返し、Sora まで届きません。

## 4. nginx

```nginx
limit_req_zone $binary_remote_addr zone=sora:10m rate=5r/s;
limit_req_status 429;

server {
	listen 443 ssl;
	http2 on;
	server_name sora.example.com;
	ssl_certificate     /etc/letsencrypt/live/sora.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/sora.example.com/privkey.pem;

	client_max_body_size 2m;

	# /metrics は、鍵なしで全利用者の合計の数字が見えるので、外には出さない
	location = /metrics { return 404; }

	location / {
		limit_req zone=sora burst=20 nodelay;
		proxy_pass http://127.0.0.1:3016;
		proxy_http_version 1.1;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-For $remote_addr;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_read_timeout 300s;
		proxy_send_timeout 300s;
	}
}
```

確かめたこと:

- 設定の構文（`nginx -t`）、HTTPS、HTTP/2、鍵の受け渡し、本文の上限（3 MB の POST は 413）、`/metrics` の 404（`//metrics` も 404）。
- ストリーミングは、`proxy_buffering off` を書かなくても、取得の進みに合わせて届きます。Sora が、SSE の応答に `X-Accel-Buffering: no` を付けるので、nginx はバッファしません。
- `limit_req`: `/health` に 60 回を続けて送ると、26 回が 200、34 回が 429 でした。6 秒おくと、200 に戻りました。**この数（5 回/秒・突発 20）は、確かめるために選んだ値です。** 利用者の使い方に合わせて決めてください。
- アクセスログ（既定の形式）に、鍵は残りません（ヘッダーを記録しないため）。
- `proxy_read_timeout` の既定は 60 秒です（[nginx の資料](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)）。クロールなど長い取得を切らないよう、延ばしてあります。この値で長い取得が切れないかは、試していません。

## 5. 鍵の発行と失効（サインアップの仕組みから呼ぶ）

[`deploy/issue-key.sh`](../../deploy/issue-key.sh) と [`deploy/revoke-key.sh`](../../deploy/revoke-key.sh) を使います（`jq` と `flock` が要ります）。

```bash
export KEYS_DIR=/srv/sora/keys                 # 鍵ファイルのディレクトリ（Sora には、これをディレクトリごとマウントする）
./issue-key.sh ops admin                       # 最初の管理者の鍵。Sora を起動する前に 1 つ作る（0 件では起動しない）
./issue-key.sh alice                           # 利用者の鍵。48 字の鍵を、標準出力に 1 回だけ出す
./revoke-key.sh alice                          # alice の鍵を全部消す
```

- **鍵は、標準出力に 1 回だけ出ます。** ファイルに残るのは SHA-256 だけで、あとから鍵は分かりません。利用者に渡す仕組み（登録の画面・メールなど）で受け取ってください。
- 鍵ファイルは、同じディレクトリの一時ファイルに書いてから置き換えます。Sora は、**約 1 秒で**読み直します（確認: 発行の 1.3 秒後に 403（一般の鍵）、失効の 1.3 秒後に 401）。
- `flock` で順番にするので、同時に呼んでも行は消えません（確認: 8 つを同時に発行して、8 行が足されました）。
- 名前は、英小文字・数字・`-`・`_` の 1〜64 字です。同じ名前でもう 1 つ発行すると、どちらの鍵も使えます（鍵の入れ替え。移ったら、古い行を消します）。
- **最後の 1 件は、失効できません**（Sora は、鍵が 0 件のファイルを誤りとして断ります）。
- 鍵ファイルを書き換えたときの扱い（壊れた書き換えのあいだは前の鍵のまま、など）と、書き込み権の意味は、README 4.6 にあります。**鍵ファイルとそのディレクトリを書ける人は、管理者の鍵を作れます。** 発行の仕組みと Sora を動かすユーザーだけに絞ってください。
- 試験: `scripts/keys/keys_scripts.test.ts`（作ったファイルを、Sora 自身の読み込みで読んで確かめます）。

## 6. 日々の運用

- **更新:** `docker pull ghcr.io/ikenokazuki/sora:latest` で取り直して、作り直します。Chromium が入っているので、その修正を取り込むため、定期的に（目安: 週に 1 回）。戻せるよう、動かしていたイメージのタグ（`sha-` と 7 桁）を控えておきます。
- **見るもの:** `/metrics`（JSON）の `counters` に、`sora_auth_rejected_missing_total`（鍵なし）・`sora_auth_rejected_invalid_total`（誤った鍵）・`sora_auth_rejected_not_admin_total`・`sora_auth_keys_reload_total`・`sora_auth_keys_reload_failed_total` などがあります（起きるまで出ないものもあります）。拒否が急に増えたら、プロキシのログで接続元を探して、プロキシかホストのファイアウォールで止めます。利用者ごとの詳しい状態は、管理者の鍵で `/health?detailed=true` です。
- **悪用への対応:** その利用者の鍵を失効します（約 1 秒で効きます）。量は、日次の上限（`SORA_AUTH_DAILY_LIMIT`）で利用者ごとに絞れます。接続元の遮断は、プロキシかファイアウォールです。
- **メモリ:** [`strict.md` の 1 章](strict.md#1-起動に必要なもの)のとおりです。同時に持つブラウザのプロセス（既定 4。`SORA_BROWSER_MAX_PROCESSES`）と、同時に開くページ（`SORA_BROWSER_MAX_CONCURRENCY`）が、メモリを決めます。VPS のメモリに合わせて決めてください。
- **外向きの制限:** [`strict.md` の 5 章](strict.md#5-ネットワークを絞るコンテナの外側で)です。

## 7. この手引で確かめていないこと

- 公開ホスト名での証明書の取得（Let's Encrypt）、HTTP/3。
- root の Docker での通しの確認（rootless Podman だけです）。
- nginx の `proxy_read_timeout 300s` で、長い取得が切れないか。
- プロキシの手前に CDN を置く構成。
- 鍵の渡し方（登録の画面・メール）は、この手引の外です。
