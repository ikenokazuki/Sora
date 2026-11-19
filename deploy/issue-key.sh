#!/usr/bin/env bash
# 使い方: issue-key.sh <利用者の名前> [admin]
# 鍵を 1 つ発行して、鍵ファイルに足す。鍵は標準出力に 1 回だけ出す(ファイルには SHA-256 しか残らない)。
# 鍵ファイルは、同じディレクトリの一時ファイルに書いてから置き換える(Sora は、約 1 秒で読み直す)。
# 同時に呼ばれても、足した行が消えないよう、flock で順番にする。
set -euo pipefail
KEYS_DIR="${KEYS_DIR:-/srv/sora/keys}"
FILE="$KEYS_DIR/keys.json"
name="${1:?利用者の名前を渡してください}"; admin="${2:-}"
[[ "$name" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || { echo "名前は英小文字・数字・-・_ の 1〜64 字(先頭は英小文字か数字)です" >&2; exit 1; }
[ -z "$admin" ] || [ "$admin" = admin ] || { echo "2 つ目の引数は admin だけです" >&2; exit 1; }

key="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"          # 48 字
hash="sha256:$(printf %s "$key" | sha256sum | cut -d' ' -f1)"

exec 9>"$KEYS_DIR/.lock"; flock 9
[ -s "$FILE" ] || printf '{"keys":[]}' > "$FILE"
tmp="$(mktemp "$KEYS_DIR/keys.json.XXXXXX")"          # mktemp は、所有者だけが読み書きできる(600)ファイルを作る
trap 'rm -f "$tmp"' EXIT
jq --arg n "$name" --arg h "$hash" --argjson a "$([ "$admin" = admin ] && echo true || echo false)" \
  '.keys += [{name: $n, keyHash: $h} + (if $a then {admin: true} else {} end)]' "$FILE" > "$tmp"
mv "$tmp" "$FILE"; trap - EXIT
printf '%s\n' "$key"
