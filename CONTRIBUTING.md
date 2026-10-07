# Contributing

## ブランチ命名規則

形式は `<type>/<topic>` です。

- `type`: `feat` `fix` `docs` `refactor` `perf` `test` `ci` `chore` `research`
  - `research` は実験用です。結論が出たら main に取り込むか破棄します。
- `topic`: 英小文字・数字・ハイフンのみ。対象モジュールから書き始めます（例: `fix/mcp-session-isolation`、`feat/geo-nominatim`）。
- 全体で 50 文字以内です。
- リリース版（`-v2230` など）、日付、個人名は入れません。設計世代（`-v2`）は可とします。
- `dev/` は使いません。`release/` は保守ブランチ用に予約しています。

正規表現:

```
^(feat|fix|docs|refactor|perf|test|ci|chore|research)/[a-z0-9]+(-[a-z0-9]+)*$
```

リポジトリに直接 push する場合は、クローン後に一度だけ次を実行してください。push 時にブランチ名が検査されます。

```sh
git config core.hooksPath .githooks
```

fork からの Pull Request では、ブランチ名は問いません。

## 流れ

1. main から短命ブランチを切り、マージ後は削除します。
2. 外部からの変更は fork + Pull Request で受け付けます。CI（`test.yml`）が通ることがマージの条件です。
3. リリースは main 上で `package.json` の version を更新し、`release: vX.Y.Z` コミットと `vX.Y.Z` タグを push します。
