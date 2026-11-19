# strict で運用する（互いに信頼できない利用者に公開する）

`SORA_ISOLATION=strict` は、互いに信頼できない利用者に、1 つの Sora を公開するための水準です。1 つのコンテナ・1 つの公開イメージのまま動きます（Sora 本体とブラウザを別のコンテナに分ける構成は、必要としません）。

`strict` は、弱い側に黙って戻りません。必要な設定と実行環境がそろっていなければ、**起動しません**。この手引は、そろえるもの、起動のときに起きること、起動を断られたときの直し方、そして、`strict` でもまだ足りないものを書きます。

**対象とする実行環境は、単一ホストの Docker・Podman（VPS など）です。** Kubernetes・Cloud Run は、未検証です（7 章）。インターネットに出すときの手前の構成（リバースプロキシ・TLS・鍵の発行・日々の運用）は、[`vps.md`](vps.md) にあります。

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

起動の例（鍵ファイルの作り方は README 4.6。鍵ファイルは、**ディレクトリごと**マウントします。鍵を足すときに、ファイルを置き換えても、コンテナの中に見えるようにするためです）:

```bash
docker run -d --name sora -p 3016:8000 \
  --security-opt seccomp=$PWD/seccomp-sora.json \
  -v "$PWD/sora-keys:/run/secrets/sora-keys:ro" \
  -e SORA_ISOLATION=strict \
  -e SORA_AUTH_KEYS_FILE=/run/secrets/sora-keys/keys.json \
  -e SORA_BROWSER_SANDBOX=on \
  -e SORA_EGRESS_GATEWAY=on \
  ghcr.io/ikenokazuki/sora:latest
```

**鍵の追加・削除に、再起動は要りません。** 鍵ファイルを書き換える(同じディレクトリに一時ファイルを書いてから置き換える)と、次の要求から最大約 1 秒で効きます。登録のたびに鍵を足す運用ができます。**注意**: 読み直しに失敗(書き換えが壊れていた)したあいだは、前の鍵を使い続けるので、**消した鍵も、管理者から外した鍵も、有効のままです。** 失敗の理由と、「N 分前から使えていません」を、ログに出します(1 分ごと。認証が要る要求が来たときに出ます。タイマーは持たないので、要求が来ない間は出ません)。ログ(`[Sora/Auth]`)と、`/metrics` の `sora_auth_keys_reload_failed_total`(読み直しの失敗)・`sora_auth_keys_missing_total`(ファイルが消えた回数)を、監視してください。鍵ファイルへの書き込み権は、全利用者と管理者の権限そのものです。詳しくは README 4.6。

メモリは、利用者ごとのプロセスのぶん増えます（空のページ 1 つで、1 プロセスあたり約 120〜160 MB。README 4.5）。同時に持てるプロセスは、既定で 4 つまでです(`SORA_BROWSER_MAX_PROCESSES` で、1〜64 に変えられます)。利用者が多い運用では、メモリに合わせて増やしてください。使われていないプロセスは閉じて回すので、メモリを決めるのは、プロセスの数そのものより、同時に開くページの数です(`SORA_BROWSER_MAX_CONCURRENCY` もあわせて見直します)。

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

## 7. 実行環境（確かめてあるもの・未検証のもの）

`strict` の公式の対象は、**単一ホストの Docker・Podman**（VPS など）です。運用者が、コンテナの起動の設定（root・capability・seccomp・外向きの制限）を決められることが、前提です。

**確かめてあるもの**
- rootless Podman: 公開イメージを、README 4.5 の強化した設定（`deploy/seccomp-sora.json`・`no-new-privileges`・`--cap-drop=ALL` に 5 つの capability を足す）で動かして、`strict` の起動、2 人の利用者のページの描画、利用者ごとに別の uid（65532・65533。Sora 本体は 0）、内部のアドレス 9 種（メタデータ・ループバック・プライベート・16 進と 10 進のループバック）への取得の拒否、`--read-only`（`/tmp` と `/data` は tmpfs）を、確かめました（2026-11-19。1 回ずつの実測です）。
- Docker: Chromium のサンドボックスと、seccomp のプロファイル（段階 1d の CI）。root の Docker で、`strict` の全体を通した確認は、まだありません。足りないものは、起動の検査が教えます。
- `standard`（信頼できる範囲の利用）の動作確認も、Docker・Podman だけです。

**未検証（保留）**
- **Kubernetes**
  - Pod Security Standards の **Restricted は満たせません。** Restricted は、非 root で動かし、capability を全部落とし（足せるのは `NET_BIND_SERVICE` だけ）、特権昇格を禁じます。`strict` は root で起動し、`CHOWN`・`DAC_OVERRIDE`・`KILL`・`SETGID`・`SETUID` が要ります。
  - **Baseline** は、この 5 つの capability を足すことも、seccomp の `RuntimeDefault`・`Localhost` も許します。Baseline の名前空間で、レプリカ 1 つなら、動く可能性があります。試していません。
  - 確かめていないこと: `RuntimeDefault` が、Chromium のサンドボックスに要るユーザー名前空間を止めるか（止めるなら、`strict` は、起動の検査で断ります）。`deploy/seccomp-sora.json`（Docker 形式）が、`Localhost` のプロファイルとして読めるか（README 4.5 も、未確認と書いています）。
- **Cloud Run**
  - capability と seccomp を、利用者が設定する手段がありません。公式は「インスタンスの root の capability は与えない」と書き、どの capability が残るかは書いていません。`strict` の起動の検査が通るかは、未確認です。
  - 既定の外向きの IP は、「地域の、すべてのサーバーレスで共有される動的な IP のプール」です。固定にするには、VPC・Cloud NAT・予約した IP が要ります。
  - ファイルシステムはメモリ上で、インスタンスが止まると消えます。メタデータサーバーが、サービスのアイデンティティの token を出すので、権限の無いサービスアカウントと、外向きの制限が要ります。
- **microVM のランタイム（krun・Kata など）で、Sora のコンテナを丸ごと囲う**
  - 期待: `strict` に残る弱点は、コンテナがホストの kernel を共有することです。microVM のランタイムなら、kernel ごと分けられます。イメージもコードも変えず、OCI ランタイムを替えるだけです。ただし、試した範囲では最後まで動かせず、`strict` の起動の検査（capability・ユーザー名前空間・uid の切り替え）が microVM の中で通るかは、確かめられていません。
  - **ランタイムの名前だけでは、microVM になりません。** krun が microVM を立てるのは、crun が libkrun 付き（`./configure --with-libkrun`。上流は「実験的」と書いています）でビルドされているときだけです。付いていない crun を `krun` の名前で呼んでも、エラーは出ず、普通のコンテナが動きます（nixpkgs の crun 1.24 は付いていませんでした）。確かめ方は 2 つです。`crun --version` に `+LIBKRUN` が出ること。`podman run --rm --runtime krun <イメージ> cat /proc/cmdline` が、ホストの `/proc/cmdline` と違うこと（同じなら microVM ではありません）。
  - **入れ子の仮想化（KVM の上の VPS）では、動きませんでした。** 試した機械は、AMD EPYC の KVM ゲストです（`/dev/kvm` があり、`nested=1`。vCPU に `hlt` 1 命令を走らせることはできました）。同じ機械の QEMU/KVM でも、vCPU が 2 つのゲストは 7 回中 7 回、最後まで動きませんでした（ログを見た 2 回は、起動の途中で止まっていました）。vCPU が 1 つなら、15 回中 14 回は動きました。libkrun 1.15.1 は、vCPU の既定が「ホストの CPU 数」で、起動の途中で固まります。`/.krun_vm.json` の `cpus` で 1 つにしても、外部コマンドを動かす最後までは、18 回中 8 回しか届きませんでした。microVM を使うなら、ベアメタル、または入れ子の仮想化が安定していると確かめた環境で、同じ確認をしてからにしてください。
  - libkrun の README は、「VM の境界は、デバイスで見せたホストの資源を制限しない」ことと、既定のネットワーク（TSI）が VMM のホストへの接続権をそのまま使うことを警告しています。microVM に入れても、外向きの制限（5 章）はホスト側で要ります。
- **複数インスタンス（水平スケール）**: 対象外です。ブラウザセッション・順番・予算はプロセスの中、日次のクォータ・キャッシュ・ウォッチは手元の SQLite にあります。インスタンスが複数だと、利用者ごとの上限が台数ぶんに増え、セッションは、同じインスタンスに届かないと使えません。**1 台で動かす前提**です。

**保留の理由**
1. Sora は、外向きの IP に敏感で（過去の測定で、Yahoo の 429 や、特定のサイトの 403 が、IP に起因していました）、取得の間隔の守りも、プロセスごとです（`SORA_YAHOO_MIN_INTERVAL_MS`・地名の検索の 1.1 秒）。サーバーレスの、共有で動的な IP と、台数による増減は、この作りに合いません。
2. 状態が、プロセスの中と、手元の SQLite にあります。
3. 1 つのコンテナ・1 つのイメージで動くことが、Sora の売りです。

台数を増やすなら、**利用者を決まったインスタンスに振り分ける**（各インスタンスは、独立した Sora）形が、この作りに合います（未検証です）。

公式の資料: [Kubernetes の Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)・[Cloud Run のコンテナの規約](https://docs.cloud.google.com/run/docs/container-contract)・[Cloud Run の外向きの IP](https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip)。
