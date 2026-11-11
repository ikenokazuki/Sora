# ブラウザと静的取得の TLS の整合

## 仕組み

Sora の取得は、静的取得（wreq-js のプロファイル）とブラウザ（同梱の Chromium）の 2 経路で、Cookie を共有する。同じセッションなので、2 つが同じ Chrome の姿（UA・ヘッダ・TLS）を送らないと、別のブラウザに見える。

- **名乗る版**: 静的取得は wreq-js が持つ最大のプロファイル（いま `chrome_149`）。ブラウザも同じ版を名乗る（`getAlignedChromeMajorVersion`）。実際の Chromium が 150 以降でも、名乗りは 149 のまま。
- **TLS**: ブラウザの起動引数 `--disable-features=…`（`browser_engine.ts` の `WREQ_ALIGN_DISABLED_FEATURES`）で、wreq のプロファイルに無い拡張（Trust Anchor IDs・GREASE の署名アルゴリズム）を止める。
- **ヘッダ**: `sec-ch-ua` のブランドは、Chromium の規則で作り直す（Debian の Chromium は "Google Chrome" のブランドを持たない）。

## 確かめ方

```bash
bun scripts/tls-fingerprint/run.ts          # 差を表示。差が無ければ終了コード 0
bun scripts/tls-fingerprint/run.ts --json   # 取った ClientHello も JSON で出す
```

ブラウザ（Sora が起動する Chromium）と、静的取得（wreq-js）の ClientHello を、手元の TCP サーバーで取って比べる（外部の通信は無い）。比べる項目は、暗号スイート・拡張の種類・曲線・署名アルゴリズム・ALPN・TLS の版・key_share の群・証明書の圧縮・ALPS・ECH。GREASE は同じ扱い、拡張の並びは集合として比べる（Chrome は実行ごとに入れ替える）。`CHROME_PATH` で Chromium を選ぶ。

`scripts/tls-fingerprint/alignment.test.ts` が、同じことを CI で確かめる。wreq のプロファイルの範囲内の Chromium は全項目が同じ、範囲より新しい Chromium は既知の差（下の ML-DSA）だけ、を求める。

公開イメージの Chromium で測るとき（`node_modules` の入ったチェックアウトで）:

```bash
podman run --rm --network host -v "$PWD:/work:ro" \
  -e CHROME_PATH=/usr/lib/chromium/chromium -e NODE_ENV=test -e SORA_DB_PATH=:memory: \
  --entrypoint /usr/local/bin/bun <イメージ> /work/scripts/tls-fingerprint/run.ts
```

### 測った結果（2026-11-11）

| ブラウザ | wreq のプロファイル | 差 |
|---|---|---|
| nix の Chromium 148 | `chrome_148` | なし |
| イメージの Debian の Chromium 156（4.2.0） | `chrome_149`（最大） | 署名アルゴリズムの先頭に ML-DSA（0x0904〜0x0906）の 3 つが付く。ほかは全項目が同じ |

ML-DSA は Chromium 150 以降が足す。止める機能名が無く（ソースに固定）、wreq-js に入っている BoringSSL も ML-DSA を知らない（`probe_sigalgs_override.ts`。`sigalgsList` の上書きは効くが、ML-DSA は `INVALID_SIGNATURE_ALGORITHM` で拒否される）。これが、いま残っている TLS の既知の差。

## Debian が Chromium を更新したとき

イメージの Chromium は、ビルドの時点の Debian（bookworm-security）の版になる。新しい版にしたら:

1. `run.ts` を、新しい Chromium で回す。
2. 新しい差があれば、中身を見る。拡張が増えたなら、止められる機能名を調べて（Chromium の `base::Feature`）`WREQ_ALIGN_DISABLED_FEATURES` に足す。
3. 止められない差は、wreq-js の `emulation.tlsOptions` で寄せられるか試す。ただし、wreq-js の BoringSSL が知らない機能は、上書きでも足せない。
4. どちらもできなければ、既知の差として `alignment.test.ts` に書き、実サイトの A/B で影響を確かめる。

## wreq-js が更新されなくなったとき

2026-11-11 の状態: wreq-js の最新は 3.2.0（2026-08-23）で、プロファイルは Chrome 149 まで。止まっているのは npm のパッケージで、上流の Rust の crate（wreq-util）は Chrome 154 まで足していて、更新が続いている。Chrome は 2026-09 から 2 週ごとに主版が上がるので、名乗りの 149 は古くなっていく。

自分でできることを、手を入れる順に:

1. **気づく**: `run.ts` と `alignment.test.ts` で、Chromium を新しくしたときの差を測る。
2. **名乗りの差を埋める**: 起動引数（`WREQ_ALIGN_DISABLED_FEATURES`）と、wreq-js の `emulation` の上書き（`tlsOptions`・`http2Options`・ヘッダ）で、実際の Chromium に寄せる。上書きは、wreq-js の BoringSSL が知っている項目に限る。
3. **ブラウザを優先する**: 静的取得の姿が古くなると、保護されたサイトでは静的取得が弾かれやすくなる。ブラウザは Chromium 自身の TLS なので、最新の姿を送る。弾かれるサイトでは、ブラウザに回す（いまも、静的取得が弾かれたらブラウザに回る）。
4. **ライブラリを替える**: 更新が活発な候補に、curl-impersonate（lexiforest 版）と impit（Apify）がある。切り替えは影響が大きく、TLS・ヘッダ・Cookie の振る舞いを全部測り直すので、最後の手段にする。
5. **上流に頼む**: wreq-js の issue で、wreq-util の新しいプロファイルの取り込みを頼む。
