# v4.0.0: 本文の取り出しとハイライトの直し・引数の整理の設計

日付: 2026-11-04

## 目的

v3.0.0 の scrape・search_deep で見つかった不具合を直し、効いていない・使われていない引数を消して、MCP のツールの説明を軽くする。直すのと消すのを、一つのメジャーリリース（v4.0.0）にまとめる。

ユーザーの判断（2026-11-04）:

- 直すのと消すのを v4.0.0 でまとめる。PR は「直す」と「消す」の 2 つに分け、リリースは 1 回にする。
- rs-trafilatura の経路の画像は、目印を入れて戻す。2 回目の rs-trafilatura は、記事以外の種類で画像のあるページだけ、1 回目のページの種類を渡して順に走らせる（全ページで 2 回を並べる案は採らない）。
- rs-trafilatura の経路では、隠し要素を消さない（測ると精度が下がるため）。
- CSS セレクタを取る引数（removeSelectors・selectors・clipSelector）は MCP から外し、REST に残す。
- includeMedia を scrape・scrape_batch・crawl_site にも足す。
- 競合より優れた点を作る機能（ハイライトの、ページの中の位置へのリンクなど）は、この直しの後に別の設計にする。

## 直す不具合（v3.0.0 で確かめたもの）

本文の取り出し（rs-trafilatura の経路だけ）:

- 本文の画像が全部消える。
- removeSelectors が効かない。rs-trafilatura が返す本文の HTML に class・id が残らないため、Sora が後から当てても `.related` のような指定が当たらない。

どちらの経路でも:

- 本文のリンクが相対パスのまま（画像は絶対 URL に直すのに、a の href は直さない）。
- formats の `html` が `rawHtml` と同じ（ページの HTML そのまま）。

ハイライト:

- maxChars（既定 30,000 字）で切った後の本文から選ぶので、それより後ろにある答えを選べない。
- 節の中にある、リンクだけの段落（Wikipedia の言語の一覧など）が、見出しの加点と書き出し（350 字）によって選ばれる。
- description がハイライトの 1 件目で置き換わり、同じ文が 2 回返る（`chooseBestDescription`）。
- annotateTemporal がハイライトに効かない（`extractQueryHighlightDetails` に渡していない）。search_deep の evidence では、本文を省くので注記が消える。

効いていない引数（直さずに消す）: minimizeTables（表は常に縮める）、includeDiagnostics、includeDiscrepancies、diversityWeight、scrape の reorderUFlat、evidenceMode の contextual_highlights（highlights と同じ）。

## 調べたこと（2026-11-04）

測り方: rs-trafilatura は本番と同じビルドのコマンド（rev 2a4f56e、`--hybrid --markdown`）を使った。データは WCXB（dev 1,497 ページ・test 511 ページ）と、`docs/evaluations/main-content/results.md` の日本語の 72 ページ。下の F1 は、rs-trafilatura の本文の文字だけを WCXB の正解と比べたもの（Sora の振り分けの前）。

### rs-trafilatura の本文の HTML

- `content_html` は、`push_filtered_html_children`（extract.rs）が決まったタグ（p・div・a・見出し・リスト・表など）だけを書き出して作る。img はこの一覧に無いので、`include_images` の設定に関係なく必ず落ちる。拡張子で画像を見分ける `is_image_file` は、Sora が使っていない別の経路のもの。
- `include_images` が false のとき、文書の掃除で img を外し、画像を含む figure を説明文（figcaption）ごと消す。表や引用を包む figure は、div として残る。
- rs-trafilatura が本文に選んだ範囲の画像のうち、URL に拡張子が無いもの: WCXB は 21,347 枚中 2,222 枚（10.4%）、日本語は 2,091 枚中 134 枚（6.4%）。Next.js の `/_next/image?url=…`、googleusercontent.com、画像を変換して配る URL など。

### 画像の目印

- 私用領域の 1 字を、画像を包む一番外の a・figure・picture の後ろ（無ければ画像の後ろ）に置いて rs-trafilatura に渡すと、本文の文字かページの種類が変わるページは、WCXB で 2,008 ページ中 23、日本語で 72 ページ中 1 だった。
- F1 の平均は dev −0.0014・test +0.0009 とほぼ同じだが、商品のページの本文が 5,203 字から 0 字になるような悪化があった。そのため、1 回目と本文が同じときだけ使う歯止めを入れる。
- 目印をリンクの中（画像のすぐ後ろ）に置くと、リンクの文字が増えてリンクの多さの判定が変わり、変わるページが増える。空白の文字（U+2000 番台）の目印は、空白だけの塊とともに半分ほど消える。

### 隠し要素を先に消す

Readability の経路と同じ隠し要素（hidden・aria-hidden・display:none・visibility:hidden・opacity:0・font-size:0）と広告・Cookie の枠を、rs-trafilatura に渡す前に消すと、F1 は dev 0.823 → 0.810、test 0.860 → 0.856 に下がった。hidden・display:none・visibility:hidden だけに絞っても、0.817・0.857 に下がる。日本語の 72 ページでは 16 ページの本文が変わり、1 ページ（ニュースの一覧）は本文が空になった。タブや折りたたみの中身も、正解の本文に入っているためとみられる。

### 費用（2,080 ページ）

- 今: rs-trafilatura 1 回は中央値 54 ms。Sora の中の処理（rs-trafilatura と変換）は中央値 110 ms、99% 点 724 ms。CPU はページあたり平均 139 ms。
- 2 回目の対象（記事以外の種類で画像のあるページ）は 37%（2,080 中 775）。2 回目に `--page-type` を渡すと、2 回目は中央値 82 ms から 62 ms に縮み、1 回目と本文が同じになるページは 775 中 762 から 764 に増える。
- 増える時間は、対象のページで中央値 80 ms・90% 点 214 ms・99% 点 504 ms・最大 963 ms。全ページでは中央値 0 ms・99% 点 420 ms。CPU は平均 40 ms（+29%）増える。
- メモリ: rs-trafilatura 自身の最大は、中央値 11 MB・99% 点 26 MB・最大およそ 50 MB。順に走らせるので、同時に動くのは 1 つのまま。目印を入れる cheerio の処理は、一時的に中央値 18 MB・99% 点 64 MB（最大は 5 MB の HTML で 188 MB）。
  - Bun の `resourceUsage().maxRSS` には起動元のプロセスの最大メモリが入るので、`/proc/<pid>/status` の VmHWM で測った。
- 全ページで 2 回を並べる案は、増える時間が中央値 19 ms と短いが、CPU が平均 95 ms（+68%）増え、rs-trafilatura のメモリが 2 倍になるので採らない。
- イメージの容量は変わらない（足すライブラリもコマンドも無い）。

## 設計

### 1. 全体の形

- 直す PR（ブランチ `fix/v4-extraction-and-params`）と、消す PR に分ける。直す PR を先にマージする。
- 両方をマージした後に v4.0.0 を出す。マージ・リリース・本番反映は、その都度確かめてから行う。

### 2. 本文の取り出し（rs-trafilatura の経路）

`src/extractor/rs_trafilatura.ts` の `extractMainContentWithRs` にまとめる。引数に `removeSelectors` と `includeMedia` を足し、scraper.ts の 2 か所（通常の取得とブラウザでの取得）から渡す。返す形（`pageType`・`contentHtml`）は変えない。`contentHtml` に `<img>` が入るようになる。

手順:

1. removeSelectors が指定されたときだけ、cheerio で読んで要素を消し、その HTML を以降で使う。指定が無ければ、今と同じ HTML を使う。
2. 1 回目は、今と同じ呼び出し（`--url <URL> --hybrid --markdown`）。
3. 次のすべてを満たすときだけ、2 回目を走らせる。
   - includeMedia が false でない
   - 1 回目の種類が article 以外で、1 回目の本文が空でない
   - HTML に img がある
4. 2 回目に渡す HTML は、cheerio で次のように作る。
   - 本文の文字にもとからある私用領域の文字（U+E000〜U+F8FF。アイコンのフォントなど）を消す。
   - img を文書の順に見て（6,400 枚まで）、各画像の後ろに目印 U+E000 + 番号を置く。置く場所は、画像を包む一番外の a・figure・picture の後ろ（無ければ画像の後ろ）。
   - 画像ごとに、URL（`resolveImageUrl` で src・data-src・srcset・data-srcset から決め、ページの URL を基準に絶対 URL にする。決まらなければ src そのもの。空なら目印を置かない）、alt、title、包む figure の figcaption の文を覚えておく。
5. 2 回目は `--page-type <1 回目の種類>` を付けて呼ぶ。
6. 1 回目と 2 回目の本文を、タグと私用領域の文字を除き、空白をまとめて比べる。同じなら、2 回目の本文の目印を `<img src alt [title]>`（属性は HTML の文字参照にする）に置き換えて返す。違えば 1 回目の結果を返す。
   - 私用領域の文字を両方から除くのは、2 回目の HTML からだけ、もとからある私用領域の文字を消しているため。画像を戻した本文には、もとの私用領域の文字（表示できない記号）は入らない。
   - figcaption の文が 1 回目の本文に無いとき（rs-trafilatura が figure ごと消したとき）は、alt が空なら説明文を alt に、alt があれば title に入れる。本文の段落は足さない。
7. 2 回目が失敗したとき・時間切れ（1 回ごとに今と同じ 5 秒）のとき・目印を入れる処理で例外が出たときは、1 回目の結果を返す。

変えないもの:

- 隠し要素は、rs-trafilatura の経路では今と同じく消さない。
- 振り分け（記事は Readability、Readability の本文が 200 字未満なら rs-trafilatura、ほかの種類は rs-trafilatura）は今と同じ。記事と判定されて Readability が 200 字未満のページでは、2 回目を走らせないので、今と同じく画像が入らない。
- rs-trafilatura の本文に noiseSelectors を当てる今の処理は残す。

### 3. 変換と出力

- 本文の URL: どちらの経路でも、Turndown に渡す前に、本文の `a[href]` と `img[src]` を、ページの URL を基準に絶対 URL にする（基準は links の一覧と同じ。日本語などの字はエンコードせずに書き、links の一覧はエンコードした形のまま。下の「実装中に足したこと」）。`#` だけのリンクと `javascript:` のリンクは、リンクを外して文字だけにする。`mailto:` と `tel:` はそのまま。
- formats の `html`: 本文の HTML（Markdown の元にしたもので、URL を絶対にし、画像を戻したもの）を返す。onlyMainContent が false のときは body の HTML。`rawHtml` は今と同じく、取得したそのままの HTML。
- includeMedia（scrape・scrape_batch・crawl_site。既定 true）: false のとき、search_deep と同じく、本文の画像を「[画像: alt]」に置き換え（alt が無ければ消し）、ogImage と media を省く。formats で求めた images の一覧と highlights は触らない。rs-trafilatura の 2 回目も走らせない。search_deep の `stripMedia` の画像の置き換えを共通の関数にして、両方から使う。

### 4. ハイライト

- 全文から選ぶ: HTML（`convertHtmlToMarkdown`）と PDF（`parsePdfToMarkdown`）は、maxChars で切る前の全文（上限 200,000 字）も返す。`finalizeScrapeResult` は、この全文からハイライトを選ぶ。
  - 返す content は、今と同じく maxChars で切ったもの。品質の点・ページの種類・ブラウザに切り替える判断も、今と同じく切った本文で行う。
  - 全文は内部の項目にして、応答とキャッシュには入れない（使った後に消す）。
  - maskPii が有効なときは、全文にも同じ置き換えをしてからハイライトを選ぶ。
  - 上限の 200,000 字は、ハイライトを選ぶ時間を測って決める。200,000 字のページで 200 ms を超えるなら下げる。
- リンクだけの段落: `parseMarkdownSections` が、節の中の段落（空行で区切った塊）のうち、短いラベルのリンクだけでできたものを外す。判定は `isNavBlock`（今は integrated_search_host_response.ts にある）を `extractor/markdown_sections.ts` に移して共通にする。見出しの無い先頭の塊を外す今の規則は残す。
- description: `chooseBestDescription` での置き換えをやめ、meta の説明文（og:description・meta description・JSON-LD）だけにする。meta の説明文が無いページでは description を返さない。
- annotateTemporal: `finalizeScrapeResult` から `extractQueryHighlightDetails` に渡して、ハイライトにも注記を付ける。search_deep の evidence でも、ハイライトに注記が残る。
- ハイライトは、search_deep の並べ替え（`rerankByDeepEvidence`）と contextSufficiency にも使われるので、検索の評価でも確かめる（7 の節）。

### 5. 引数の整理（消す PR）

全部のツールから消す（MCP と REST の両方）:

| 引数 | 理由・消した後の動き |
|---|---|
| includeDiagnostics・includeDiscrepancies・diversityWeight・minimizeTables・reorderUFlat | 効いていない。表は今と同じく縮める |
| evidenceMode の contextual_highlights | highlights と同じ |
| extractSummary・extractCitations・chunkMarkdown・chunkSize・validateLinks・formatAsPrompt・highlightMatches・filterLinkDensity | 加工を呼び出し側で行える。使われていない |
| safeNormalize | 本文の数と単位を書き換える（「2.4 km」が「2400 m」に、「500 ms」が「0.5 s」に）ので、引用元と文字が合わなくなる |
| search_deep の dedup・enablePrf | 今の既定（false）のまま固定する。enablePrf は検索を 1 回増やす |
| scrape の webhookUrl | 結果をその場で返すので要らない（一括取得・巡回・監視の webhookUrl は残す） |
| retries・retryDelayMs | 今の既定どおり、再試行しない |

まとめる:

- onlyHighlights・evidenceMode・extractHighlights を、`responseMode`（`full` か `evidence`）にまとめる。scrape・scrape_batch・crawl_site に足し、既定は `full`（今と同じ）。search_deep の既定は今と同じ `evidence`。
- scrape 系の `evidence` は、ハイライトがあるときに content をハイライトに置き換える（今の onlyHighlights と同じ）。search_deep の `evidence` は今のまま。ハイライトは、今と同じく query があれば必ず作る。

MCP からだけ外す（REST には残す）:

- renderJs・fastOnly（mode の `browser`・`fast` と同じ）
- removeSelectors・selectors・clipSelector（LLM は、ページの HTML を見ずに呼ぶので、正しいセレクタをほとんど書けない）

足す: includeMedia（scrape・scrape_batch・crawl_site。3 の節）

MCP の引数の数: scrape 38 → 16、scrape_batch 35 → 16、crawl_site 14 → 11、search_deep 32 → 26。

互換: REST も MCP も、知らない項目は黙って捨てる（zod の object の既定）。消した項目を送ってもエラーにはならず、無視される。動きが変わるのは、消した項目を明示していた呼び出し（onlyHighlights: true など）だけで、リリースノートに書く。

### 6. 失敗時の扱い

- rs-trafilatura: 1 回目の失敗は今と同じく Readability の経路に戻る。2 回目の失敗・時間切れ・本文のずれ・目印の処理の例外は、1 回目の結果（画像なし）を使う。
- 全文が 200,000 字を超えるときは、先頭の 200,000 字からハイライトを選ぶ。
- removeSelectors に正しくないセレクタが来たときは、今と同じくエラーにする。

### 7. 確かめ方

- 単体テスト:
  - 目印の置き方（a・figure・picture の外側）・戻し方・本文がずれたときに 1 回目を使うこと・もとからある私用領域の文字を消すこと・2 回目を走らせる条件
  - URL の絶対化、`#` と `javascript:` のリンク、formats の html の中身
  - リンクだけの段落を外すこと、description、ハイライトの注記
  - includeMedia、消した引数が無視されること（REST と MCP）
- 本文: `scripts/eval-wcxb.ts`（WCXB は dev で確かめ、test は判断に 1 回だけ使う。Bevendorff らの評価集も）と日本語の 72 ページで、今の main と比べる。
  - 画像の行を外した本文が今と同じであること、戻った画像の数を確かめる。
  - 時間とメモリを、調べたときと同じ測り方で確かめる。
- ハイライト:
  - `scripts/eval-jqara.ts --select`（dev で確かめ、test は判断に 1 回）で、選んだ段落の精度が下がらないこと。
  - 30,000 字を超えるページ（Wikipedia の長い記事など）10 件ほどで、後ろのほうにある答えを問う検索語を作り、答えのある節が選ばれるかを見る。
- 検索: `docs/evaluations/response-compression/results.md` の 40 問の測り方で、実際の search_deep を 1 回だけ走らせ（Yahoo の上限を守り、10 秒あける）、evidence に答えが残る問いとページの数が下がらないことを確かめる。
- 評価は CI と同じ Bun 1.4.2 で行う（Bun の版で Intl.Segmenter の語の切り方が違う）。

### 8. リリース

- 直す PR、消す PR の順にマージし、v4.0.0 を出す。
- リリースノートに、破壊的な変更（消した引数、responseMode へのまとめ、formats の html の意味、description がハイライトで置き換わらなくなること、MCP から外した引数、本文のリンクと画像の URL が絶対になること（日本語などの字はエンコードしない））を書く。
- scrape のキャッシュのキーの版を上げる（`scrape:v8` → `scrape:v9`）。includeMedia をキーに入れる。
- MCP の説明文（`src/mcp/instructions.ts` と各ツールの説明）と、引数を挙げている docs を直す。

## 実装中に足したこと（2026-11-04〜05）

評価とレビューで見つかった不具合を、同じ PR で直した。
- 画像の記法の掃除: `cleanMarkdownTokens` は、空の画像を空のリンクより先に消す。前は `![](url)` の `[](url)` だけが消えて `!` が残り、後ろのリンクが画像の記法になっていた（base にもあり、画像を戻すと多く出た）。画像とリンクの飛び先の正規表現は、URL の中の 1 段の括弧（`format(webp)` など）と alt の逃がした字（`\]`）を読む。100 万字を超える data URI でも止まらない書き方にした。`replaceMarkdownImages` も同じ。
- `#`・`javascript:` のリンクを外すときは、隣が要素なら空白を挟む（並んだリンクの文字がくっつかないように）。
- 本文の URL: 絶対 URL のうち、非 ASCII の字（日本語のパスなど）のパーセントエンコードは字に戻す。エンコードのままだと、リンクの多い日本語のページで、同じ maxChars に入る本文が半分ほどに減った。空白・制御文字・書式文字になる並びと、UTF-8 として読めない並びはエンコードのまま。links の一覧はエンコードした形のまま。
- 節の分け方（`extractor/markdown_sections.ts`）の 3 つの処理を、細工した入力で止まらない形にした。リンク行の判定（長さの二乗）と前置きのパンくずの判定（指数）は、同じ判定になる形に替えた。パンくずの行から最後の節を取る処理（指数）は、行ごとに読む形にした（前の正規表現は、行が区切りで終わると改行をまたいで次の行の字を取ったが、それはしない）。
- 採点: `scripts/eval-wcxb.ts` の `toText` は、画像を alt ごと（`[画像: alt]` も）外し切る。base も同じ採点で測り直した。

## 入れないもの

- 競合より優れた点を作る機能（別の設計）。
- rs-trafilatura の経路の隠し要素の扱い（今のまま）。
- Readability の経路の隠し要素・figcaption の扱い（今のまま）。
- 記事と判定されて Readability が 200 字未満のページでの画像（今のまま、画像なし）。
