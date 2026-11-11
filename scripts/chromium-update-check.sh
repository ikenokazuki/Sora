#!/usr/bin/env bash
# 最新のリリースのイメージの Chromium と、Debian（bookworm）が出している chromium を比べ、Debian のほうが新しければ issue で知らせる。
# イメージの作成・配布はしない（リリースは人が決める）。読むのは、公開イメージ・Debian・Google の公開の情報だけ。
#
# 使い方: scripts/chromium-update-check.sh           （issue を作る・更新する・閉じる）
#         DRY_RUN=1 scripts/chromium-update-check.sh （書き込みはせず、本文を表示する）
# 要るもの: docker（podman でも可）、gh（GH_TOKEN か、ログイン済み）、curl、python3
# 環境変数: IMAGE（既定 ghcr.io/ikenokazuki/sora）、REPO（既定 カレントの gh のリポジトリ）
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/ikenokazuki/sora}"
ISSUE_TITLE='[chromium-update] 新しい Chromium が Debian から出ています'
DRY_RUN="${DRY_RUN:-0}"
repo_args=()
[ -n "${REPO:-}" ] && repo_args=(--repo "$REPO")

tag="$(gh release view "${repo_args[@]}" --json tagName --jq .tagName)"
image="$IMAGE:${tag#v}"
docker pull -q "$image" >/dev/null
in_image="$(docker run --rm --entrypoint /usr/lib/chromium/chromium "$image" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

candidate="$(docker run --rm docker.io/library/debian:bookworm-slim bash -c 'apt-get update -qq >/dev/null 2>&1; apt-cache policy chromium | sed -n "s/^  Candidate: //p"')"
upstream="${candidate%%-*}"
google="$(curl -fsS 'https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?orderBy=version%20desc&pageSize=1' | python3 -c 'import sys, json; print(json.load(sys.stdin)["versions"][0]["version"])')"
wreq_max="$(grep -A2 'SUPPORTED_CHROME_PROFILE_VERSIONS = \[' src/http_fetcher.ts | grep -oE '[0-9]{3}' | sort -n | tail -1)"

# 外から取った値は、形を確かめてから使う
for value in "$in_image" "$upstream" "$google"; do
  [[ "$value" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "unexpected version: '$value'" >&2; exit 1; }
done
[[ "$wreq_max" =~ ^[0-9]{3}$ ]] || { echo "unexpected wreq max profile: '$wreq_max'" >&2; exit 1; }

if docker run --rm docker.io/library/debian:bookworm-slim dpkg --compare-versions "$upstream" gt "$in_image"; then newer=yes; else newer=no; fi
gap=$(( ${google%%.*} - wreq_max ))

summary="$(cat <<EOF
| | 版 |
|---|---|
| 最新のリリース（${tag}）のイメージの Chromium | ${in_image} |
| Debian bookworm の chromium（apt の候補） | ${candidate} |
| Google の最新の安定版（Linux） | ${google} |
| wreq-js の最大のプロファイル | chrome_${wreq_max}（Google の安定版の主版との差 ${gap}） |
EOF
)"
echo "$summary"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$summary" >> "$GITHUB_STEP_SUMMARY"

existing="$(gh issue list "${repo_args[@]}" --state open --limit 100 --json number,title --jq "[.[] | select(.title == \"$ISSUE_TITLE\")][0].number // empty")"

if [ "$newer" = yes ]; then
  body="$(cat <<EOF
最新のリリース（${tag}）のイメージより、Debian の chromium のほうが新しくなっています。

${summary}

次にすること:

1. 修正の内容と、悪用の有無を確かめる: [Chrome Releases](https://chromereleases.googleblog.com/)、[Debian Security Tracker](https://security-tracker.debian.org/tracker/source-package/chromium)
2. 新しい Chromium で、ブラウザと静的取得の TLS のずれを確かめる: \`bun scripts/tls-fingerprint/run.ts\`（手順は docs/browser-alignment.md）
3. パッチリリースを出す（タグの公開パイプラインが、その時点の Debian の chromium でイメージを作る）

この issue は、週 1 回の確認（.github/workflows/chromium-update-check.yml）が作ります。最新のリリースが Debian と同じ版になると、自動で閉じます。
EOF
)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "--- DRY_RUN: issue を $([ -n "$existing" ] && echo "更新（#$existing）" || echo 作成)する本文 ---"; echo "$body"
  elif [ -n "$existing" ]; then
    gh issue edit "$existing" "${repo_args[@]}" --body "$body" >/dev/null
  else
    gh issue create "${repo_args[@]}" --title "$ISSUE_TITLE" --body "$body" >/dev/null
  fi
  echo "結果: Debian のほうが新しい（${upstream} > ${in_image}）"
else
  if [ -n "$existing" ]; then
    if [ "$DRY_RUN" = 1 ]; then echo "--- DRY_RUN: issue #$existing を閉じる ---"
    else gh issue close "$existing" "${repo_args[@]}" --comment "最新のリリースのイメージが、Debian の chromium と同じ版（${in_image}）になりました。" >/dev/null; fi
  fi
  echo "結果: 更新は出ていない（Debian ${upstream}、イメージ ${in_image}）"
fi
