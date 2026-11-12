#!/usr/bin/env bash
# trial.sh が作った結果（引数のディレクトリ）から、vendor/wreq-js と WREQ_MAX_CHROME_PROFILE を更新する PR を作る。
# 上流のコードをビルド・実行する試しビルドの側には、書き込みの権限を渡さない。ここは、trial.sh が作った patch と文面だけを扱う
# （.github/workflows/wreq-native-update.yml の pr ジョブ）。
#
# 使い方: scripts/wreq-native/open-pr.sh <trial.sh の出力のディレクトリ>
#   DRY_RUN=1 なら、枝の push と PR の作成はしない（作業ツリーには commit するので、捨てられる場所で回す）。
# 要るもの: gh（GH_TOKEN）と、push できる git。
#   PR の作成には、リポジトリの Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」が要る。
set -euo pipefail
cd "$(dirname "$0")/../.."
dir="$(cd "${1:?trial.sh の出力のディレクトリを渡す}" && pwd)"

max="$(cat "$dir/max")"
[[ "$max" =~ ^[0-9]{3}$ ]] || { echo "max が 3 桁の版ではない: $max" >&2; exit 1; }
branch="auto/wreq-native-chrome-$max"

# patch が触ってよいのは、この 4 つのファイルだけ
unexpected="$(git apply --numstat "$dir/bump.patch" | cut -f3 | grep -vxE 'Containerfile|vendor/wreq-js/(Cargo\.toml\.patch|Cargo\.lock|pins\.json)' || true)"
[ -z "$unexpected" ] || { echo "想定外のファイルを触る patch: $unexpected" >&2; exit 1; }

# すでに開いている PR は、更新しない（人が、マージするか閉じるかを決める）
open="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$open" ]; then
  echo "枝 $branch の PR #$open がすでにある。マージするか閉じるまで、更新しない。"
  exit 0
fi

git apply --index "$dir/bump.patch"
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -q -F "$dir/commit-message.txt"
if [ "${DRY_RUN:-0}" = 1 ]; then
  git show --stat HEAD
  echo "--- DRY_RUN: 枝 $branch を push して、PR「$(cat "$dir/pr-title.txt")」を作る"
  exit 0
fi

# 枝は、この自動が作るもの（前の PR が閉じられて残った枝は、上書きする）
git push --force origin "HEAD:refs/heads/$branch"
gh pr create --base main --head "$branch" --title "$(cat "$dir/pr-title.txt")" --body-file "$dir/pr-body.md" || {
  echo "PR を作れなかった（枝 $branch は push 済み）。リポジトリの Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」が要る。" >&2
  exit 1
}
