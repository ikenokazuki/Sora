# 公開SNS取得基盤と独立MCPツール 実装記録

> 採択計画（2026-09-26 チャット提示）の実装記録。X統合判断・構成・受入条件を含む。

**目的**: 追加費用なしでWeibo/Threads/Instagram/Facebookの公開投稿を取得し、Soraインテリジェンスと独立MCPツールの両方から利用する。判断は呼び出し元LLMが行い、Soraは本文・日時・出典・取得状態を返す。

## 確定事項

- Xリアルタイム検索は統合しない。`search_realtime`（CORE、X固有DSL）と `yahoo_realtime` プロバイダーを維持し、新基盤と共存させる。理由は互換性維持と対象・検索方式の違い。`platform` に `x` は含めない。
- SNS指定調査の目標上限60秒、内部締め切り55秒。`social_posts` 上限45秒。非SNS調査は29秒維持。
- 有料API・内部LLM・ログイン不要。定期収集なし。ShareXtractのPython常駐なし。
- 単独SNS MCP結果はDB保存しない。インテリジェンス呼び出し時のみ既存保存を利用。SNSセッションはメモリのみ。
- Metaコメント・アカウント巡回・動画本体は対象外として明示する。

## 構成

```text
MCP: search_social_posts / fetch_social_post（webモジュール、defaultEnabled）
                  │
                  ▼
       src/services/social/（types/index/registry相当/discovery/weibo/weibo_session/meta/transport）
                  ▲
Country Intelligence: social_posts プロバイダー
```

- `SocialService.search/fetch` が唯一の取得境界。MCPとproviderは複製しない。
- Weibo: 匿名セッション（ブラウザで m.weibo.cn を通常表示→Cookie群を共通wreqへ引継ぎ、30分再利用、単一初期化、失効時1回再取得、429時再発行なし）。
- Weibo新着検索（最大3ページ・重複排除・期間外除外）、本文＋長文、人気コメント（hotflow標本）。
- Meta: 公開HTMLのOG読取→不足時のみtokenless oEmbed→予算内の匿名ブラウザ。コメント日時を投稿日時にしない。
- Meta検索は通常Web検索で投稿URL発見（searchMode: web_index と明示）。
- 返却状態 ok/partial/empty/unavailable。HTTP 200と本文取得成功を分離。失敗をemptyに変換しない。
- 国地域入力に任意 `social {platforms, queries, urls, lookbackHours}` を追加。`social` 指定＋`includeSocial=false` は入力エラー。
- providerキャッシュキーへ `includeSocial` と `social` 条件を含める（registry側の既定キーにrequest全体が入ることを確認）。TTL 60秒。

## 受入条件

- 自動テストとビルドが通る。SNS未使用時にSNS通信・保存が0件。
- Weibo新着検索とMeta3サービスの公開本文取得を実環境で再現できる。
- 部分取得・取得不能・日時不明が正しく返る。同時実行・中断・復旧で処理が残らない。
- 初回調査が最大60秒予算内で終了する。
- コミット・mainマージ・本番反映は差分と検証結果の提示後の明示指示に従う（無断実施しない）。

## 残課題

- 長時間安定性・ページ送り・セッション失効復旧の継続検証。
- 検索結果の関連性選別（宣伝・ファン投稿の混入）。
- 既存品質ゲートは新取得器の完成だけで合格に変更しない。改修前後の比較評価が別途必要。
