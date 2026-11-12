#!/usr/bin/env bash
# 上流（wreq-util の main）に、いまの上限（Containerfile の WREQ_MAX_CHROME_PROFILE）より新しい Chrome のプロファイルがあるかを見て、
# あれば、その rev で native を作り直したイメージを試しにビルドし、ブラウザと静的取得の ClientHello を比べる。
# 週 1 回、.github/workflows/wreq-native-update.yml が呼ぶ。手元でも回せる（bun・docker か podman・ネットワークが要る。bun install 済みで）。
# 作業ツリーの vendor/wreq-js と Containerfile を書き換えるので、捨てられる場所で回す。
#
# 結果は $OUT に置く（PR を作る open-pr.sh が読む）:
#   bump.patch（vendor/wreq-js と Containerfile の差分）・max（PR で上げる上限）・commit-message.txt・pr-title.txt・pr-body.md・verify.log
#
# 環境変数:
#   WREQ_UTIL       wreq-util の rev かブランチ（既定 main）
#   FORCE=1         新しいプロファイルが無くても、ビルドと確認を最後まで回し、固定に差があれば PR の材料も作る
#   OUT             結果の置き場（既定 ./wreq-native-update）
#   RUN_URL         PR の本文に書く、この実行の URL（任意）
#   GITHUB_OUTPUT・GITHUB_STEP_SUMMARY  あれば、changed=（PR の材料を作ったか）と、要約を書く
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${OUT:-$PWD/wreq-native-update}"
mkdir -p "$OUT"
(cd "$OUT" && rm -f bump.patch max commit-message.txt pr-title.txt pr-body.md verify.log)

note() { echo "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n\n' "$*" >> "$GITHUB_STEP_SUMMARY"; }
emit() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1" >> "$GITHUB_OUTPUT"; }

# 1. ビルドの前の、安い判定（上流の src/emulate.rs の Chrome の最大の版と、いまの上限を比べる）
check="$(bun scripts/wreq-native/update.ts --check --wreq-util "${WREQ_UTIL:-main}")"
field() { printf '%s\n' "$check" | sed -n "s/^$1=//p"; }
rev="$(field wreq_util_rev)"; upstream_max="$(field upstream_max)"; current_max="$(field current_max)"; newer="$(field newer)"
if ! [[ "$rev" =~ ^[0-9a-f]{40}$ && "$upstream_max" =~ ^[0-9]{3}$ && "$current_max" =~ ^[0-9]{3}$ && "$newer" =~ ^(true|false)$ ]]; then
  echo "update.ts --check の出力が想定と違う: $check" >&2
  exit 1
fi
note "上流の wreq-util（\`${rev:0:8}\`）の最新の Chrome は \`chrome_${upstream_max}\`。いまの上限は ${current_max}。"
if [ "$newer" != true ] && [ "${FORCE:-}" != 1 ]; then
  note "新しい Chrome のプロファイルは無い。何もしない。"
  emit changed=false
  exit 0
fi

# 2. 固定を作り直し（新しいプロファイルがあれば、上限も上げる）、固定のテストを通す
args=(--wreq-util "$rev")
[ "$newer" != true ] || args+=(--max-chrome-profile "$upstream_max")
bun scripts/wreq-native/update.ts "${args[@]}"
NODE_ENV=test SORA_DB_PATH=':memory:' bun test src/containerfile_pins.test.ts scripts/wreq-native

# 3. その固定でイメージをビルドして、イメージの中で確かめる（失敗すれば、ここで止まる）
image=sora-wreq-native-trial
docker build -f Containerfile -t "$image" .
bash scripts/verify-image.sh "$image" 2>&1 | tee "$OUT/verify.log"

# 4. 差分（PR にするもの）と、PR の文面
git diff -- vendor/wreq-js Containerfile > "$OUT/bump.patch"
if [ ! -s "$OUT/bump.patch" ]; then
  note "ビルドと確認は通った。固定（vendor/wreq-js・Containerfile）に差は無いので、PR は作らない。"
  emit changed=false
  exit 0
fi

max="$(sed -n 's/^ARG WREQ_MAX_CHROME_PROFILE=//p' Containerfile)"
echo "$max" > "$OUT/max"
pin() { bun -e 'console.log(JSON.parse(await Bun.stdin.text())[process.argv[1]])' "$1"; }
old_pins="$(git show HEAD:vendor/wreq-js/pins.json)"
changes=""
for pair in wreqUtilRev:wreq-util wreqRev:wreq btlsRev:btls; do
  key="${pair%%:*}"; repo="${pair##*:}"
  before="$(printf '%s' "$old_pins" | pin "$key")"; after="$(pin "$key" < vendor/wreq-js/pins.json)"
  [ "$before" = "$after" ] || changes="${changes}- ${repo}: [\`${before:0:8}\` → \`${after:0:8}\`](https://github.com/0x676e67/${repo}/compare/${before}...${after})
"
done
new_util="$(pin wreqUtilRev < vendor/wreq-js/pins.json)"
vendor_line=""
git diff --quiet -- vendor/wreq-js || vendor_line="- \`vendor/wreq-js/Cargo.toml.patch\`・\`Cargo.lock\`・\`pins.json\`: 上の rev に合わせた固定
"
run_line="${RUN_URL:+試しビルドの実行: $RUN_URL}"

if [ "$newer" = true ]; then
  title="chore(fetch): 上流の Chrome ${max} のプロファイルを、自前の native で使う（自動）"
  purpose="上流の wreq-util（main）に Chrome ${max} のプロファイルが入りました。静的取得とブラウザが名乗る Chrome の版の上限（Containerfile の \`WREQ_MAX_CHROME_PROFILE\`）を ${current_max} から ${max} に上げ、自前でビルドする native（\`vendor/wreq-js\`）の固定を、その rev（\`${new_util:0:8}\`）にそろえます。"
  behavior="- 名乗る Chrome の版の上限: ${current_max} → ${max}（実際の Chromium の版のほうが小さければ、その版。UA・\`sec-ch-ua\`・TLS・ヘッダが、その版のものになります）"
else
  title="chore(fetch): 自前の native の上流の rev を ${new_util:0:8} に更新する（手動）"
  purpose="自前でビルドする native（\`vendor/wreq-js\`）の固定を、上流の wreq-util の rev \`${new_util:0:8}\` に更新します。新しい Chrome のプロファイルは無く、上限は ${current_max} のままです（手動の実行）。"
  behavior=""
fi
echo "$title" > "$OUT/pr-title.txt"
purpose_plain="${purpose//\`/}" # コミットの文では、Markdown のバッククォートを外す

cat > "$OUT/commit-message.txt" <<MESSAGE
${title}

${purpose_plain}
${run_line}

固定した rev は vendor/wreq-js/pins.json。ビルドと、イメージの中の確認（ブラウザと静的取得の ClientHello の比較）は、試しビルドで済ませてある。
MESSAGE

cat > "$OUT/pr-body.md" <<BODY
## 目的

${purpose}

この PR は、週 1 回の試しビルド（\`.github/workflows/wreq-native-update.yml\`）が作りました。${run_line}

## 変わるもの

${behavior}
${changes}${vendor_line}
## 試しビルドで確かめたこと

- この rev で native をビルドし、イメージを作れた（Containerfile のビルドの確認で、native が \`chrome_${max}\` を持つことも確かめた）
- 固定のテスト（\`src/containerfile_pins.test.ts\`・\`scripts/wreq-native\`）が通った
- イメージの中の確認（\`scripts/verify-image.sh\`）の出力:

\`\`\`
$(cat "$OUT/verify.log")
\`\`\`

## 自動では確かめていないこと（マージの前に見る）

- Accept の \`image/jxl\`: ブラウザは \`JXLImageFormat\` を止めている（\`src/browser_engine.ts\` の \`WREQ_ALIGN_FEATURES\`）。新しいプロファイルが \`image/jxl\` を送るなら、止めてはいけない
- HTTP/2 の SETTINGS・接続の窓・疑似ヘッダの並び（\`docs/browser-alignment.md\` の手順で、手で比べる）
- ClientHello を比べたのは、イメージの Chromium と、その版以下で最新のプロファイルだけ（上の出力）。上限を Chromium より新しい版にしても、その新しい版のプロファイルは、Chromium を更新したときに測る

## 戻し方

\`SORA_FETCH_MAX_CHROME_PROFILE=${current_max}\` を渡すと、イメージの作り直しなしに、${current_max} のものに戻ります。

## マージのあと

Actions が作った PR の CI（Test・Containerfile）は、承認待ち（\`action_required\`）で止まります。走らせたいときは、PR の画面の「Approve and run workflows」を押してください（上の確認は、試しビルドの実行が済ませているので、押さなくても構いません）。マージすると、main への push で、通常どおり Test と公開のパイプラインが動きます。
BODY

note "新しい固定でビルドと確認が通った。PR の材料を作った（上限 ${current_max} → ${max}）。"
emit changed=true
