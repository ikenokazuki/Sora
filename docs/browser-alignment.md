# ブラウザと静的取得の TLS の整合

## 仕組み

Sora の取得は、静的取得（wreq-js のプロファイル）とブラウザ（同梱の Chromium）の 2 経路で、Cookie を共有する。同じセッションなので、2 つが同じ Chrome の姿（UA・ヘッダ・TLS）を送らないと、別のブラウザに見える。

- **名乗る版**: 実際の Chromium の版と、上限 `SORA_FETCH_MAX_CHROME_PROFILE` の小さい方（`src/http_fetcher.ts` の `profileMajorFor`）。静的取得はその版の wreq-js のプロファイル（`chrome_<版>`）を使い、ブラウザも同じ版を名乗る（`getAlignedChromeMajorVersion`）。上限の既定は 149（npm の wreq-js の native が持つ最新）。公開イメージは、自前でビルドした native（下の「wreq-js の native」）が持つ最新の版（Containerfile の `WREQ_MAX_CHROME_PROFILE`）にしている。
- **TLS**: ブラウザの起動引数 `--disable-features=…` で、wreq のプロファイルに無い項目を止める。止める項目は、名乗る版で決まる（`browser_engine.ts` の `WREQ_ALIGN_FEATURES` と `wreqAlignDisabledFeatures`）。プロファイルが送る項目は、止めずに、ブラウザが自然に送るままにする。
  - 拡張 51764（Trust Anchor IDs）と署名アルゴリズムの GREASE: プロファイルが 152 未満なら止める。152 以上は、プロファイルも送る。
  - Accept の `image/jxl`（Chromium 156 以降）: wreq のプロファイル（154 まで確かめた）には無いので、止める。新しいプロファイルが送るようになったら、`emulatedFrom` にその版を入れて、止めないようにする。
  - 署名アルゴリズムの ML-DSA（Chromium 150 以降）: 止める機能名が無い。プロファイルが 150 以上なら同じになり、150 未満（上限が 149 のとき）は既知の差として残る。
- **ヘッダ**: `sec-ch-ua` のブランドは、Chromium の規則で作り直す（Debian の Chromium は "Google Chrome" のブランドを持たない）。規則は、wreq-js の chrome_136〜154 が送るものと一致する（`stealth_native.test.ts`）。

## 確かめ方

```bash
bun scripts/tls-fingerprint/run.ts          # 差を表示。差が無ければ終了コード 0
bun scripts/tls-fingerprint/run.ts --json   # 取った ClientHello も JSON で出す
```

ブラウザ（Sora が起動する Chromium）と、静的取得（wreq-js）の ClientHello を、手元の TCP サーバーで取って比べる（外部の通信は無い）。比べる項目は、暗号スイート・拡張の種類・曲線・署名アルゴリズム・ALPN・TLS の版・key_share の群・証明書の圧縮・ALPS・ECH。GREASE（署名アルゴリズムのものを含む）は同じ扱い、拡張の並びは集合として比べる（Chrome は実行ごとに入れ替える）。`CHROME_PATH` で Chromium を選ぶ。

`scripts/tls-fingerprint/alignment.test.ts` が、同じことを CI で確かめる。全項目が同じことを求める。ただし、プロファイルが 150 未満で Chromium が 150 以上のときだけ、既知の差（ML-DSA）を許す。

**公開イメージの中で**（自前の native と、イメージの Chromium で測る）。`.github/workflows/containerfile-check.yml` が、Containerfile などを変える PR で、同じことをする:

```bash
podman run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/tls-fingerprint/run.ts
```

`src` と `scripts` を `/app` に置くのは、bare の import を `/app/node_modules`（イメージの本番依存と、自前の native）から解決させるため。

### 測った結果

| 日 | ブラウザ | wreq のプロファイル | 差 |
|---|---|---|---|
| 2026-11-11 | nix の Chromium 148 | `chrome_148`（npm の native） | なし |
| 2026-11-11 | イメージの Debian の Chromium 156（4.2.0） | `chrome_149`（npm の native。最大） | 署名アルゴリズムの先頭に ML-DSA（0x0904〜0x0906）の 3 つが付く。ほかは全項目が同じ |
| 2026-11-12 | Debian の Chromium 156（起動引数なし） | 上流 main の `chrome_152`〜`chrome_154`（自前の native） | なし（署名アルゴリズムの GREASE の値は接続ごとの乱数） |
| 2026-11-12 | Debian の Chromium 156（旧来の起動引数） | 上流 main の `chrome_150`・`chrome_151` | なし |

**HTTP/2 の姿**（2026-11-12、手で確かめた。Node の `http2` の使い捨てサーバーに、wreq の各プロファイルと、イメージの Chromium 156 を繋いだ）: SETTINGS（HEADER_TABLE_SIZE=65536・ENABLE_PUSH=0・INITIAL_WINDOW_SIZE=6291456・MAX_HEADER_LIST_SIZE=262144）、接続の窓（15728640。WINDOW_UPDATE の増分は 15663105）、疑似ヘッダの並び（`:method,:authority,:scheme,:path`）は、`chrome_149`・`chrome_152`・`chrome_154` と Chromium 156 で同じ。ヘッダ名の並びも、`chrome_149`・`chrome_154` と Chromium は同じ（`chrome_152` だけ `accept-language` が前にあるが、Sora はセッションの `origHeaders`（`CHROME_HEADER_ORDER`）で並びを決めるので影響しない）。SETTINGS の ID の並びと有無は、この方法では見えない。

ML-DSA は、npm の wreq-js の native（wreq-util 0.2.1）が持つ BoringSSL が知らない（`probe_sigalgs_override.ts`。`sigalgsList` の上書きは効くが、ML-DSA は `INVALID_SIGNATURE_ALGORITHM` で拒否される）。上流の wreq-util の main は、Chrome 150 以降のプロファイルで ML-DSA を送る。

## Debian が Chromium を更新したとき

イメージの Chromium は、ビルドの時点の Debian（bookworm-security）の版になる。新しい版にしたら:

1. `run.ts` を、新しい Chromium で（イメージの中で）回す。
2. 新しい差があれば、中身を見る。拡張が増えたなら、止められる機能名を調べて（Chromium の `base::Feature`）`WREQ_ALIGN_FEATURES` に足す（`emulatedFrom` は、wreq のプロファイルがその項目を送り始める版。まだ無ければ `null`）。
3. 止められない差は、wreq-js の `emulation.tlsOptions` で寄せられるか試す。ただし、wreq-js の BoringSSL が知らない機能は、上書きでも足せない。
4. どちらもできなければ、既知の差として `alignment.test.ts` に書き、実サイトの A/B で影響を確かめる。

## wreq-js の native

静的取得の TLS・HTTP の実装（wreq-js の native）は、npm のビルド済みのものではなく、Containerfile の Stage 1b で、wreq-js のソースからビルドしたものを使う。

- 材料: wreq-js のタグ（`WREQ_JS_VERSION`・`WREQ_JS_REV`。package.json の wreq-js と同じ版）と、`vendor/wreq-js/` の固定（`Cargo.toml.patch`・`Cargo.lock`・`pins.json`）。依存は、上流の wreq-util の main（新しい Chrome プロファイル）と、wreq-util が自分の `[patch.crates-io]` で使っている wreq・btls の rev に向ける。公開された wreq-util 0.2.1 は Chrome 149 まで。
- 作り直し: `bun scripts/wreq-native/update.ts`（`--wreq-util <rev か ブランチ>` で、wreq-util の rev を選ぶ。既定は main。`--max-chrome-profile <版>` で、`WREQ_MAX_CHROME_PROFILE` も書き換える）。podman か docker が要る（`CONTAINER_RUNTIME` で選べる）。出力の差分を見て、`bun test src/containerfile_pins.test.ts scripts/wreq-native` を通す。
- 上限: `ARG WREQ_MAX_CHROME_PROFILE`（Containerfile の先頭）が、native が持つ最新の Chrome の版。ビルドの時点で、native がこのプロファイルを持つことを確かめ、`SORA_FETCH_MAX_CHROME_PROFILE` として渡す。
- **挙動を戻す**: 実行時に `SORA_FETCH_MAX_CHROME_PROFILE=149` を渡せば、UA・TLS・ヘッダが `chrome_149` のものに戻る（ブラウザの起動引数も、149 用に戻る）。イメージの作り直しは要らない。
- 版を上げるとき: wreq-js を上げたら、`WREQ_JS_VERSION`・`WREQ_JS_REV`（そのタグのコミット）をそろえて、`update.ts` を回す。そろっていなければ `src/containerfile_pins.test.ts` が落ちる。

上流が止まったとき: プロファイルはデータなので、最小のパッチ（例えば、新しい Chrome の版を、一つ前のプロファイルの設定で足す）を `vendor/wreq-js/Cargo.toml.patch` の隣に持てる。合っているかは、`run.ts` が測る。

## 上流の新しい rev の自動確認

週 1 回（火曜 21:41 UTC）、`.github/workflows/wreq-native-update.yml` が、上流の wreq-util（main）に、いまの上限（`WREQ_MAX_CHROME_PROFILE`）より新しい Chrome のプロファイルがあるかを見る。

1. 判定（`update.ts --check`）: 上流の `src/emulate.rs` の Chrome の最大の版を読み、上限と比べる。新しくなければ、ここで終わる（ビルドしない）。
2. 試しビルド（`scripts/wreq-native/trial.sh`）: その rev で固定を作り直し、上限を上げて、固定のテストを通し、イメージをビルドし、`scripts/verify-image.sh`（native の置き換えと、イメージの Chromium との ClientHello の比較）を通す。どれかが落ちれば、実行が失敗になる（PR は作らない）。
3. PR（`scripts/wreq-native/open-pr.sh`）: 通れば、`vendor/wreq-js` と上限を更新する PR を作る。文面に、変わる rev（比較のリンク）・確認の出力・自動では確かめていないこと・戻し方を書く。**マージは人が決める**（名乗る版が変わるため）。すでに開いている PR は更新しない。閉じても、上流に新しいプロファイルがある限り、次の週にまた作る（止めるなら、ワークフローを無効にする）。

- 上流のコードをビルド・実行する 2 の側（`trial` ジョブ）には、書き込みの権限を渡さない。PR を作る 3 の側（`pr` ジョブ）は、patch（`vendor/wreq-js` と Containerfile だけを触るものに限る）と文面だけを扱う。
- PR を作るには、リポジトリの Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」を有効にする（既定は無効。無効だと、`pr` ジョブが PR を作れずに失敗する。枝は push 済みなので、そこから手で PR にできる）。
- Actions が作った PR には、PR の CI は動かない。試しビルドが、同じ確認（イメージのビルドと `verify-image.sh`）を済ませている。マージすると、main への push で、通常どおり Test と公開のパイプラインが動く。
- 手動: Actions の「wreq-native update」を実行する。`wreq_util` で rev を選べる。`force` を付けると、新しいプロファイルが無くても最後まで回し、固定に差があれば PR も作る（上流の rev だけを更新したいとき）。
- 手元: `bun install` のあと `bash scripts/wreq-native/trial.sh`（作業ツリーの `vendor/wreq-js` と Containerfile を書き換えるので、捨てられる場所で）。
- 自動では確かめないこと: Accept の `image/jxl`（`WREQ_ALIGN_FEATURES`）と、HTTP/2 の SETTINGS・接続の窓・疑似ヘッダの並び。PR の本文に、マージの前に見る項目として書く。

## 上流を調べるとき

- 上流の wreq-util の main は、公開（crates.io）より先に進む（2026-11-12 時点で、Chrome 154 まで）。Chrome の安定版（157）には、まだ追いついていない。
- wreq-js 自身は、master で更新が続いている（依存の更新など）が、npm への公開は 2026-08-23 の 3.2.0 が最後。
- 上流の新しい rev の確認は、上の「上流の新しい rev の自動確認」。週 1 回の確認（`.github/workflows/runtime-update-check.yml`）は、イメージの Chromium・Bun・土台の更新を見る。
