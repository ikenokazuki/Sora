#!/usr/bin/env bash
# 実機の VPS で、strict で動いている Sora のコンテナが、手引（docs/operations/strict.md・vps.md）どおりの状態かを、1 回流して確かめる。
# docker か podman だけが要る（bun は、ホストに要らない。Sora と同じイメージの bun で、scripts/vps-check.ts を動かす）。
#
# 使い方（確かめる用の鍵を、発行して渡す。管理者の鍵 1 つと、一般の鍵 2 つ。終わったら失効する。deploy/issue-key.sh・revoke-key.sh）:
#   VPS_CHECK_ADMIN_KEY=<管理者の鍵> VPS_CHECK_KEY_A=<一般の鍵> VPS_CHECK_KEY_B=<別の一般の鍵> \
#     bash scripts/vps-check.sh <コンテナ名> [--url <公開の URL>] [--offline] [--skip-network]
#   --url           リバースプロキシの外から、/health・/metrics・鍵なしの /scrape も確かめる（vps.md）
#   --offline       公開のページ・PDF・ウォッチ（外の通信が要るもの）を確かめない
#   --skip-network  コンテナの中から、メタデータの IP・ホスト（ゲートウェイ）につなげないかを確かめない
#   RUNTIME=podman  docker でなく podman を使う（省略すると、docker があれば docker、無ければ podman）
# 鍵は、環境変数で渡す（引数に書かない。プロセスの一覧・シェルの履歴に残らない）。鍵は、どこにも表示しない。
#
# 何をするか: コンテナの設定（inspect）・起動のログ・本物の HTTP・コンテナの中のプロセス（/proc）・外向きの接続を、使い捨てのコンテナ
# （Sora のコンテナと、ネットワークと PID の名前空間を共有）で確かめて、1 行ずつ [PASS]・[WARN]・[FAIL]・[SKIP] を出す。
# FAIL が 1 つでもあれば、終了コード 1。Sora のコンテナには、何も書かない（読むだけ。ウォッチを 1 つ作って、消す〔--offline でないとき〕）。
set -uo pipefail

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

name=''
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --url) [ $# -ge 2 ] || { echo '--url に URL を渡してください' >&2; exit 2; }; args+=(--url "$2"); shift 2 ;;
    --offline | --skip-network) args+=("$1"); shift ;;
    -*) echo "知らない引数です: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo 'コンテナ名は 1 つだけ渡してください' >&2; exit 2; }; name="$1"; shift ;;
  esac
done
[ -n "$name" ] || { usage >&2; exit 2; }

runtime="${RUNTIME:-}"
if [ -z "$runtime" ]; then
  if command -v docker >/dev/null 2>&1; then runtime=docker; elif command -v podman >/dev/null 2>&1; then runtime=podman; fi
fi
[ -n "$runtime" ] && command -v "$runtime" >/dev/null 2>&1 || { echo 'docker か podman が要ります（RUNTIME で指定できます）' >&2; exit 2; }

running="$("$runtime" inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" || { echo "コンテナ ${name} が見つかりません（${runtime} inspect ${name} が失敗しました）" >&2; exit 2; }
[ "$running" = true ] || echo "[FAIL] container.running  コンテナ ${name} が動いていない" >&2
image="$("$runtime" inspect -f '{{.Config.Image}}' "$name")"

dir="$(cd "$(dirname "$0")" && pwd)"
logs="$(mktemp)"
trap 'rm -f "$logs"' EXIT
chmod 600 "$logs"
# 起動のときの記録は、ログの先頭にある（長く動かしたコンテナのログの末尾には、無い）
"$runtime" logs "$name" 2>&1 | head -n 400 >"$logs"

envs=()
for var in VPS_CHECK_ADMIN_KEY VPS_CHECK_KEY_A VPS_CHECK_KEY_B; do
  [ -n "${!var:-}" ] && envs+=(-e "$var")
done
[ "${#envs[@]}" -gt 0 ] || echo '注意: 鍵（VPS_CHECK_ADMIN_KEY・VPS_CHECK_KEY_A・VPS_CHECK_KEY_B）が 1 つも無いので、HTTP の確認の多くを省きます' >&2

podman_args=()
[ "$(basename "$runtime")" = podman ] && podman_args=(--http-proxy=false)

"$runtime" inspect "$name" | "$runtime" run --rm -i "${podman_args[@]}" \
  --network="container:${name}" --pid="container:${name}" \
  --cap-drop=ALL --security-opt no-new-privileges --memory=256m --pids-limit=128 \
  "${envs[@]}" \
  -v "${dir}/vps-check.ts:/check.ts:ro" -v "${logs}:/logs.txt:ro" \
  --entrypoint /usr/local/bin/bun "$image" /check.ts --inspect-stdin --logs-file /logs.txt "${args[@]}"
code=$?
[ "$code" -le 1 ] || echo "確認用のコンテナを動かせませんでした（終了コード ${code}）。イメージ ${image} に bun が無い・--pid=container: を使えない環境の可能性があります" >&2
exit "$code"
