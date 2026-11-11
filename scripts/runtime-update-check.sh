#!/usr/bin/env bash
# 最新のリリースのイメージの Chromium・Bun を、新しい版と比べ、遅れていれば issue で知らせる。
#   - Chromium: Debian（bookworm）が出している chromium のほうが新しいか
#   - Bun: GitHub の最新の安定版のほうが新しいか（イメージのビルドは oven/bun:1 の浮動タグなので、ビルドした時点の最新になる）
#   - CI の Bun（.github/workflows/test.yml）が、最新の安定版より古くないか
# イメージの作成・配布はしない（リリースは人が決める）。読むのは、公開イメージ・Debian・Google・GitHub の公開の情報だけ。
#
# 使い方: scripts/runtime-update-check.sh           （issue を作る・更新する・閉じる）
#         DRY_RUN=1 scripts/runtime-update-check.sh （書き込みはせず、本文を表示する）
# 要るもの: docker（podman でも可）、gh（GH_TOKEN か、ログイン済み）、curl、python3
# 環境変数: IMAGE（既定 ghcr.io/ikenokazuki/sora）、REPO（既定 カレントの gh のリポジトリ）
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/ikenokazuki/sora}"
ISSUE_TITLE='[runtime-update] Chromium・Bun の更新が出ています'
DRY_RUN="${DRY_RUN:-0}"
repo_args=()
[ -n "${REPO:-}" ] && repo_args=(--repo "$REPO")

version_re='^[0-9]+(\.[0-9]+){2,3}$'
check_version() { [[ "$2" =~ $version_re ]] || { echo "unexpected $1 version: '$2'" >&2; exit 1; }; }
# $1 が $2 より新しければ 0
newer_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

tag="$(gh release view "${repo_args[@]}" --json tagName --jq .tagName)"
image="$IMAGE:${tag#v}"
docker pull -q "$image" >/dev/null

# Chromium
chromium_in_image="$(docker run --rm --entrypoint /usr/lib/chromium/chromium "$image" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
candidate="$(docker run --rm docker.io/library/debian:bookworm-slim bash -c 'apt-get update -qq >/dev/null 2>&1; apt-cache policy chromium | sed -n "s/^  Candidate: //p"')"
chromium_debian="${candidate%%-*}"
google="$(curl -fsS 'https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?orderBy=version%20desc&pageSize=1' | python3 -c 'import sys, json; print(json.load(sys.stdin)["versions"][0]["version"])')"
wreq_max="$(grep -A2 'SUPPORTED_CHROME_PROFILE_VERSIONS = \[' src/http_fetcher.ts | grep -oE '[0-9]{3}' | sort -n | tail -1)"

# Bun
bun_in_image="$(docker run --rm --entrypoint /usr/local/bin/bun "$image" --version)"
bun_latest="$(gh api repos/oven-sh/bun/releases/latest --jq .tag_name)"
bun_latest="${bun_latest#bun-v}"
bun_ci="$(grep -hE '^\s+bun-version:' .github/workflows/test.yml | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# 外から取った値は、形を確かめてから使う
check_version 'chromium (image)' "$chromium_in_image"
check_version 'chromium (debian)' "$chromium_debian"
check_version 'chrome (google)' "$google"
check_version 'bun (image)' "$bun_in_image"
check_version 'bun (latest)' "$bun_latest"
check_version 'bun (ci)' "$bun_ci"
[[ "$wreq_max" =~ ^[0-9]{3}$ ]] || { echo "unexpected wreq max profile: '$wreq_max'" >&2; exit 1; }

# dpkg の版の比較は、Debian の規則に従う（~ や epoch を含む）
if docker run --rm docker.io/library/debian:bookworm-slim dpkg --compare-versions "$chromium_debian" gt "$chromium_in_image"; then chromium_newer=yes; else chromium_newer=no; fi
if newer_than "$bun_latest" "$bun_in_image"; then bun_newer=yes; else bun_newer=no; fi
if newer_than "$bun_latest" "$bun_ci"; then bun_ci_old=yes; else bun_ci_old=no; fi
gap=$(( ${google%%.*} - wreq_max ))
mark() { [ "$1" = yes ] && echo ' ⚠' || true; }

summary="$(cat <<TABLE
| | 版 |
|---|---|
| 最新のリリース（${tag}）のイメージの Chromium | ${chromium_in_image} |
| Debian bookworm の chromium（apt の候補） | ${candidate}$(mark "$chromium_newer") |
| Google の最新の安定版（Linux） | ${google} |
| wreq-js の最大のプロファイル | chrome_${wreq_max}（Google の安定版の主版との差 ${gap}） |
| 最新のリリース（${tag}）のイメージの Bun | ${bun_in_image} |
| Bun の最新の安定版 | ${bun_latest}$(mark "$bun_newer") |
| CI の Bun（test.yml の bun-version） | ${bun_ci}$(mark "$bun_ci_old") |
TABLE
)"
echo "$summary"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$summary" >> "$GITHUB_STEP_SUMMARY"

reasons=()
[ "$chromium_newer" = yes ] && reasons+=("Debian の chromium（${chromium_debian}）が、リリースのイメージ（${chromium_in_image}）より新しい")
[ "$bun_newer" = yes ] && reasons+=("Bun の最新の安定版（${bun_latest}）が、リリースのイメージ（${bun_in_image}）より新しい")
[ "$bun_ci_old" = yes ] && reasons+=("CI の Bun（${bun_ci}）が、最新の安定版（${bun_latest}）より古い")

existing="$(gh issue list "${repo_args[@]}" --state open --limit 100 --json number,title --jq "[.[] | select(.title == \"$ISSUE_TITLE\")][0].number // empty")"

if [ "${#reasons[@]}" -gt 0 ]; then
  list="$(printf -- '- %s\n' "${reasons[@]}")"
  body="$(cat <<BODY
${list}

${summary}

次にすること:

1. 修正の内容と、悪用の有無を確かめる: [Chrome Releases](https://chromereleases.googleblog.com/)、[Debian Security Tracker](https://security-tracker.debian.org/tracker/source-package/chromium)、[Bun のセキュリティ勧告](https://github.com/oven-sh/bun/security/advisories)
2. Chromium が新しいとき: 新しい Chromium で、ブラウザと静的取得の TLS のずれを確かめる: \`bun scripts/tls-fingerprint/run.ts\`（手順は docs/browser-alignment.md）
3. CI の Bun が古いとき: 手元でその版の Bun で全テストを通してから、test.yml・live-tools.yml の \`bun-version\` を上げる
4. イメージの Chromium・Bun が古いとき: パッチリリースを出す（タグの公開パイプラインが、その時点の Debian の chromium と \`oven/bun:1\` でイメージを作る）

この issue は、週 1 回の確認（.github/workflows/runtime-update-check.yml）が作ります。すべて解消すると、自動で閉じます。
BODY
)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "--- DRY_RUN: issue を $([ -n "$existing" ] && echo "更新（#$existing）" || echo 作成)する本文 ---"; echo "$body"
  elif [ -n "$existing" ]; then
    gh issue edit "$existing" "${repo_args[@]}" --body "$body" >/dev/null
  else
    gh issue create "${repo_args[@]}" --title "$ISSUE_TITLE" --body "$body" >/dev/null
  fi
  echo "結果: 更新あり（${#reasons[@]} 件）"
  printf -- '  - %s\n' "${reasons[@]}"
else
  if [ -n "$existing" ]; then
    if [ "$DRY_RUN" = 1 ]; then echo "--- DRY_RUN: issue #$existing を閉じる ---"
    else gh issue close "$existing" "${repo_args[@]}" --comment "Chromium・Bun とも、リリースのイメージと CI が最新になりました。" >/dev/null; fi
  fi
  echo "結果: 更新は出ていない"
fi
