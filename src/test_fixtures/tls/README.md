# TLS のテスト用の証明書

- `ca.pem`・`leaf.pem`・`leaf.key`: テスト用の CA と、localhost・127.0.0.1 用のサーバー証明書（ECDSA P-256、2051 年まで）。
  `src/tls_trust.test.ts` が、ローカルの HTTPS サーバーを立てて、wreq-js の信頼する root の切り替えを確かめるのに使う。
  本物のサイトとは無関係で、秘密鍵（`leaf.key`）も、このテストのためだけのもの。
- `emsign_ecc_root_ca_g3.pem`: emSign ECC Root CA - G3 の公開の証明書（Mozilla の root 一覧にあったもの）。
  `src/tls_trust.ts` の DISTRUSTED_ROOTS の指紋が、この証明書と一致することを確かめる。
- `trust_probe_child.ts`: 子プロセスで走らせ、環境変数（起動時から効く）を変えた上で、Sora のセッションが上の localhost に繋がるかを出す。
