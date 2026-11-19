#!/usr/bin/env bash
# 使い方: revoke-key.sh <利用者の名前>   その名前の鍵を、すべて消す(約 1 秒で効く)。最後の 1 件は消せない(Sora が 0 件を断るため)
set -euo pipefail
KEYS_DIR="${KEYS_DIR:-/srv/sora/keys}"
FILE="$KEYS_DIR/keys.json"
name="${1:?利用者の名前を渡してください}"
exec 9>"$KEYS_DIR/.lock"; flock 9
tmp="$(mktemp "$KEYS_DIR/keys.json.XXXXXX")"          # mktemp は、所有者だけが読み書きできる(600)ファイルを作る
trap 'rm -f "$tmp"' EXIT
jq --arg n "$name" '.keys |= map(select(.name != $n))' "$FILE" > "$tmp"
[ "$(jq '.keys | length' "$tmp")" -gt 0 ] || { echo "鍵が 0 件になるので、消しません(Sora は 0 件を断ります)。ほかの鍵を足してから消してください" >&2; exit 1; }
mv "$tmp" "$FILE"; trap - EXIT
