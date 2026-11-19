# strict で運用する（互いに信頼できない利用者に公開する）

`SORA_ISOLATION=strict` は、互いに信頼できない利用者に、1 つの Sora を公開するための水準です。1 つのコンテナ・1 つの公開イメージのまま動きます（Sora 本体とブラウザを別のコンテナに分ける構成は、必要としません）。

`strict` は、弱い側に黙って戻りません。必要な設定と実行環境がそろっていなければ、**起動しません**。この手引は、そろえるもの、起動のときに起きること、起動を断られたときの直し方、そして、`strict` でもまだ足りないものを書きます。

`strict` が切り替えるものの全体は、README の 4.5（ブラウザの隔離）と 4.6（複数のユーザー）、設計は [`docs/superpowers/specs/2026-11-12-isolation-design.md`](../superpowers/specs/2026-11-12-isolation-design.md) にあります。

## 1. 起動に必要なもの

設定（環境変数）:

| 設定 | 値 | 理由 |
|---|---|---|
| `SORA_ISOLATION` | `strict` | 水準 |
| `SORA_AUTH_KEYS_FILE` | 鍵ファイルのパス | 利用者（tenant）を分ける単位。単一の鍵（`SORA_API_KEY`）や鍵なしでは、利用者ごとに状態を分けられません（README 4.6） |
| `SORA_BROWSER_SANDBOX` | `on` | `auto`（未設定を含む）は、サンドボックスを使えないと、黙って `--no-sandbox` に戻ります |
| `SORA_EGRESS_GATEWAY` | `on` | 外向きの通信を、出口のゲートウェイに通して、内部のネットワークへの接続を断ちます |
| `SORA_BROWSER_UID` | `off` 以外（未設定でよい） | tenant ごとの Chromium を、別の uid に落として分けるため |
| `SORA_BROWSER_PIPE` | `false` にしない（未設定でよい） | ブラウザとの接続をパイプにするため。ポートだと、Chromium が 127.0.0.1 の TCP で待ち受け、同じコンテナの別の uid（ほかの利用者）のプロセスから操作できます。未設定の既定は、Bun 1.4.4 以上でパイプです（公開イメージの Bun は 1.4.4）。自分でイメージを作って Bun が古いときは、`true` にします |
| `SORA_FETCH_ALLOW_PRIVATE_NETWORK` | `true` にしない | `true` のとき、出口のゲートウェイは使われません |

実行環境:

- **Sora を root で起動します**（公開イメージの既定です。Chromium だけが別の uid に落ちます）。`user:`・`runAsUser`・`USER` で root 以外を指定すると、uid を落とせず、起動しません。
- **capability** `CHOWN`・`DAC_OVERRIDE`・`KILL`・`SETGID`・`SETUID`（Docker の既定にあります。`--cap-drop=ALL` の運用は、この 5 つを足します）。
- **uid 65532〜65535**（`SORA_BROWSER_UID` の基準 + 0〜3）は、Sora の Chromium 専用にします。利用者の入れ替えのときと、起動の確認のあとに、その uid で動いているプロセスを、Sora が終わらせます。ホストで直接動かすときは、別の用途に使わないでください（コンテナなら問題になりません）。
- **ユーザー名前空間を許す seccomp。** Docker の既定は止めているので、[`deploy/seccomp-sora.json`](../../deploy/seccomp-sora.json) を渡します（README 4.5）。rootless Podman の既定は、渡さなくても動きました。AppArmor は、Docker の既定のままにします。
- 起動用バイナリ（`/usr/local/bin/sora-chromium-launch`。公開イメージに入っています）と、Chromium。
- **stdio では使えません。** `strict` は共有のサービス（HTTP）用で、stdio には、利用者を分ける鍵がありません。

起動の例（鍵ファイルの作り方は README 4.6）:

```bash
docker run -d --name sora -p 3016:8000 \
  --security-opt seccomp=$PWD/seccomp-sora.json \
  -v "$PWD/sora-keys.json:/run/secrets/sora-keys.json:ro" \
  -e SORA_ISOLATION=strict \
  -e SORA_AUTH_KEYS_FILE=/run/secrets/sora-keys.json \
  -e SORA_BROWSER_SANDBOX=on \
  -e SORA_EGRESS_GATEWAY=on \
  ghcr.io/ikenokazuki/sora:latest
```

メモリは、利用者ごとのプロセスのぶん増えます（空のページ 1 つで、1 プロセスあたり約 120〜160 MB。README 4.5）。同時に持てるプロセスは 4 つまでです。

## 2. 起動のときに起きること

次の順に進み、どこかで失敗したら、終了コード 1 で終わります。待ち受けは、すべてが通ったあとです。

1. **環境変数の検査。** 誤りを、すべて標準エラーに出します（1 つ直すたびに起動し直さなくてよいように）。
2. **`strict` の検査。** 上の設定と実行環境を満たしているかを調べます。
3. **前回の異常終了が残したプロファイルの掃除**（3 章）。
4. **Chromium の試し起動。** サンドボックス有効・別の uid で、実際に 1 回起動して、閉じます。設定の値を見るだけでは分からない、実際に起動できるか（seccomp・ユーザー名前空間・capability）を、最初の要求ではなく、起動のときに知るためです。
5. 待ち受けます。

通ったときのログ:

```
[Sora/Strict] 起動の確認が通りました（Chromium を、サンドボックス有効・別の uid で起動できました）
Starting Sora service on port 8000...
```

Chromium が見つからない環境では、試し起動を省いて、警告します（ブラウザを使う機能は動きません）。

### 起動を断られたとき

| ログの文 | 直し方 |
|---|---|
| `SORA_AUTH_KEYS_FILE（名前つきの複数の鍵のファイル）が必要です` | 鍵ファイルを作って渡します（README 4.6） |
| `SORA_BROWSER_SANDBOX=on が必要です` | `on` にします。Docker は、あわせて `deploy/seccomp-sora.json` を渡します |
| `SORA_EGRESS_GATEWAY=on が必要です` | `on` にします |
| `SORA_FETCH_ALLOW_PRIVATE_NETWORK=true は使えません` | 外します。内部の特定の宛先だけを通すなら、`SORA_EGRESS_ALLOW_HOSTS` を使います |
| `SORA_BROWSER_UID=off は使えません` | `auto`（未設定）にするか、数を指定します |
| `ブラウザとの接続をパイプにする必要があります` | `SORA_BROWSER_PIPE=false` を外します。Bun が 1.4.4 未満なら、Bun を上げるか、`SORA_BROWSER_PIPE=true` にします |
| `前回の実行が残したプロファイル … を消せませんでした` | root で起動して `DAC_OVERRIDE` を足すか、そのディレクトリを手で消します |
| `Sora を root で起動する必要があります（いまは uid …）` | コンテナの `user:`・`runAsUser`・`USER` を外します |
| `…capability が足りません（CAP_…）` | 示された `--cap-add=…` を足します |
| `起動用バイナリ（…）がありません` | 公開イメージを使います。自分でイメージを作るなら、`Containerfile` の `chromium-launcher` の段階で作るファイルを、その場所に置きます |
| `Chromium を、サンドボックス有効・別の uid で起動できませんでした: …` | seccomp（Docker は `deploy/seccomp-sora.json`）・AppArmor（`unconfined` にしない）・Chromium の場所を確かめます。`strict` は `auto` に戻せません |
| `stdio は使えません` | HTTP で起動します |

## 3. 前回の異常終了が残したプロファイルの掃除

Chromium のプロファイル（Cookie・セッションを含みます）は、`/tmp/sora-chromium-XXXXXX`（その uid だけが読める 0700）に置かれ、正常に閉じたときに消えます。Sora が異常終了（OOM・`docker kill`）すると、残ります。`strict` は、利用者ごとに uid を割り当てるので、次の起動で同じ uid をもらった別の利用者に、前の利用者の残りを読まれうるため、起動のときに消します。

- 対象は、一時ディレクトリ（`TMPDIR`。未設定なら `/tmp`）の直下の `sora-chromium-` + 英数字 6 文字の**ディレクトリ**だけです。ファイル・シンボリックリンク・名前が合わないものには触りません。
- 動いているプロセスの引数に、そのパスがあるものは、使用中として消しません（迷えば残す側です）。残したものは、警告に出します（前の Chromium が残っているか、同じ一時ディレクトリを使う別の Sora があります）。
- 消すには、root と `DAC_OVERRIDE` が要ります（`strict` の起動の条件と同じです）。**消せなかったものがあれば、起動しません**（残したまま起動すると、同じ uid をもらった別の利用者に、読まれうるためです）。動いているプロセスの一覧（`/proc`）を読めない環境では、動いているか分からないので、何も消さずに、警告して続けます。
- 前提: **同じ `/tmp` を使う Sora は 1 つ**です。同じ `/tmp` を共有する別の Sora が、起動の直前に作ったプロファイルを、使用中と分からずに消すことがあります。
- `standard` では、何も消しません。

## 4. `/health?detailed=true` は管理者の鍵だけ

`strict` では、`GET /health?detailed=true`（外部依存先の疎通と、稼働の内訳）に、管理者の鍵（鍵ファイルの `"admin": true`）が要ります。鍵なし・知らない鍵は 401、管理者でない鍵は 403 です。

コンテナの死活確認に使う `GET /health`（`detailed` なし）は、`strict` でも鍵なしで開きます。`/metrics` は、これまでどおり鍵なしで開き、全利用者の合計の数字が見えます。

## 5. ネットワークを絞る（コンテナの外側で）

Sora の中の出口のゲートウェイは、Sora が通信の道筋を決める仕組みです。環境変数に従わない子プロセスや、破られたプロセスが、直接つなぐのを、カーネルのレベルでは止めません。互いに信頼できない利用者に公開するときは、コンテナの外側でも、外向きの通信を絞ってください。

- コンテナが、内部のネットワーク（プライベートな IP・クラウドのメタデータ・ほかのサービス）に出られないようにします。Sora が外へ出る先は、公開のウェブ・API です。
- 書き方は実行環境ごとに違います（Docker のネットワークとホストのファイアウォール、Kubernetes の NetworkPolicy など）。ここでは方針だけを書き、具体的な設定は、確かめていません。

## 6. `strict` でも、まだ足りないもの

- Yahoo・YouTube・歌詞・TikTok の字幕・X・楽曲認識・画像の検査など、Sora 自身の上流への取得は、共有の（`legacy` の）セッションと、その保存済みの Cookie を使います。サイトが出した Cookie が、利用者をまたいで共有されます。
- `/metrics` と、`detailed` なしの `/health`（`cachedEntries`・`activeMcpSessions`）は鍵なしで開き、全利用者の合計の数字が見えます。
- 音声のデコーダーが破られたときは、同じ利用者のブラウザセッションの Cookie には届きえます（ほかの利用者のプロセスには、uid が違うので届きません）。
- PDF の解析が動く 1 つのスレッドは、全員で共有です。

これらが済むまでは、公開する範囲を、運用者が把握できる利用者に限ってください。
