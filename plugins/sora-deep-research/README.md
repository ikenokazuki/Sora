# Sora Deep Research プラグイン（0.1.0）

Sora MCPと組む深層調査スキルと接続設定の配布物。呼出元LLMが調査を進め、Soraは取得の道具として使う。

## 内容

- `skills/sora-deep-research/SKILL.md`: 調査手順（確認事項・証拠・不足の記録、取得失敗と0件の区別）。
- `mcp.example.json`: Sora MCPサーバへの接続例。
- `.codex-plugin/plugin.json`: プラグイン定義。

## 使い方

## 配布と導入

配布はgitで行う。このディレクトリが配布単位で、依存の追加は不要。

### A. マーケットプレイス経由（推奨）

1. このリポジトリを公開し、利用側のCodex設定へマーケットプレイスを登録する。
2. プラグイン `sora-deep-research` を有効化する。スキルと接続設定が読み込まれる。

### B. 手動配置

1. `skills/sora-deep-research` を利用側のスキル置き場（例: `~/.agents/skills/`）へ複写する。
2. Soraリポジトリで依存を導入し、`bun run src/stdio.ts` が起動することを確認する。
3. `mcp.example.json` を参照し、利用側のMCP設定へSoraサーバを登録する。

### 使い方

SKILL.mdの手順に従い、確認事項ID・証拠・取得状態を記録しながら調査する。Soraサーバは取得の道具で、判断は呼出元LLMが行う。

## 状態と制限

- 試行段階。品質ゲート未達。全SNSの取得や炎上予測は保証しない。
- 取得失敗と0件の区別、公式ドメイン優先、予算と停止規則は手順に含む。
- ライセンスはBUSL-1.1（本体に準じる）。
