# v4.1.0 に GCC（米国 CPSC の一般適合証明書）を作るツールを載せる 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** まだコミットしていない GCC の機能（`generate_gcc_certificate`。v4.0.0 の上で書いたもの）を、まだ出していない v4.1.0 のブランチ `fix/v4-1-param-fixes` に載せ、独立のレビューの指摘（C1〜C8・I1〜I11・M1〜M14）をすべて直して、v4.1.0 で出す。

**Architecture:** Task 0 で作業ツリーの差分を v4.1 の先頭に当てる（実在に見える値は当てる前に架空の値に置き換え、HTS の年齢・性別の変更（C7）は持ち込まない）。次に、CORE の `check_product_compliance` と scrape を v4.1 の形に戻し、CPSC の判定から手書きの表と語の正規表現を外す（公式のデータ・HTS の階層・規則の本文の写し・確認の質問で決める）。そのうえで GCC を「明細（`items`）だけを受け、HTS コードと記録は呼び出し側が渡し、今の 16 CFR 1110.11 の要素で作る」形に作り直し、応答とツールの定義を小さくする。最後の Task で文書・生成するクライアント・両方の版の全件テストをそろえる。

**Tech Stack:** Bun（手元 1.3.3、CI 1.4.2）・TypeScript・zod 4・hono・cheerio・bun:test・`node:crypto`

## Global Constraints

- 公開リポジトリなので、特定の利用者のサービスや持ち主の基盤の名前を、コード・コメント・docs・コミット・PR に書かない。手元のパスも書かない。
- 実在の人・会社の連絡先を、コード・テスト・docs・例に書かない。名前は架空（`Acme Imports LLC`・`Acme Test Lab` など）、メールは RFC 6761 の予約ドメイン `.test`（例 `compliance@acme-imports.test`）、電話は架空の番号 `+1-202-555-0100`〜`+1-202-555-0199`、住所は架空（例 `100 Example Street`, `Anytown`, `CA`, `United States`）で建物の名前を書かない。実在の試験所の名前、本物に見える追跡番号（運送会社の桁の形の数字）も書かない（例 `TEST-AWB-0001`）。レビューが挙げた実在に見える値（作業ツリーのテスト・README にある会社名・番地・ドメイン・電話番号・人名、試験所の名前・住所・電話、店の商品名と SKU、追跡番号）は最初のコミットより前に消し、どのコミットにも入れない（元の値の一覧は公開しない手元のメモにある）。
- 依存を足さない。Containerfile とイメージは変えない。
- 既定の値は変えない（この計画に書いたものを除く）。既にあるルートの REST の応答の形は、項目を足すだけにする（`POST /trade/gcc-generate` は v4.1.0 で新しく、形はこの計画で決める）。
- 引数を消すときは、MCP の inputSchema・ハンドラー・内部の options・REST のスキーマ・ルート・README・instructions・docs から消す。スキーマを `.strict()` にしない（送られても無視されるだけにする）。
- キャッシュの版は上げなくてよい: CPSC・FDA・GCC の結果はキャッシュせず、CROSS の判例のキャッシュの中身は変わらない。GCC の中の scrape は引数が違うので別のキーになり、scrape の出力も変えない（前提 9）。
- 品目にどの規則が当たるかを決める手書きの表・語の辞書・語の正規表現を持たない。使ってよいのは、公式のデータ（同梱の CPSC の eFiling の HTS の一覧、USITC の HTS の章・見出しの番号）と、規則の本文の写し（16 CFR 1610.1(c)・(d) の文、(d)(2) の 6 つの繊維、16 CFR 1110.11(a)(7) の文、CATAIR の Disclaim の決まり）。データで決まらないときは、呼び出し側への確認の質問にする。
- 使わない人に負担をかけない。起動のときに何も始めず、何も取りに行かない。新しい外の API を使わない（GCC の作成は手元のデータだけで答える。外に出るのは、呼び出し側が `url` を渡したときの scrape だけ）。
- 大きさの予算（統合後の木で `bun scripts/measure-context.ts` で測る）: 最初に見える 14 ツールのツール単位の説明の合計は 3,500 字未満（v4.1 は 3,495 字。この機能で増やさない）。`tools/list` は既定 25,000 字以下・全ツール 64,000 字以下（v4.1 は 21,764・58,757）。`instructions` は 9,000 字未満（v4.1 は 8,922）。`generate_gcc_certificate` の `tools/list` の 1 件は 3,600 字以下（作業ツリーでは 5,610）。`generate_gcc_certificate` の応答（MCP に返す JSON の文字数）は、1 品 6,000 字以下・10 品 35,000 字以下・50 品 150,000 字以下（作業ツリーでは 24,410・193,833・947,473）。
- 説明文は今の文体（日本語、短く）にする。
- 振る舞いを変える項目は、先に失敗するテストを書き、直して通す（TDD）。外のサービスはテストでは偽物（`src/test_fixtures/` の型、手元の `Bun.serve`）を使う。外への実際の要求は、どの Task も 0 回。
- コミットのメッセージは英語の Conventional Commits（例 `fix(trade): ...`）。本文に「skip ci」と書かない（否定の文でも CI が止まる）。コミットの前に、手元のメモの元の値で `git diff --cached` を grep して 0 件にする。
- v4.1.0 はまだ出していない。RELEASE_NOTES.md・README.md（数・表・環境変数）・docs/code-execution.md（大きさ）・生成するクライアント（`client/`）は最後の形を書く。最後に、手元の Bun と Bun 1.4.2 の両方で全件のテストを通す。
- 手元の環境の決まり（テストの前にプロキシの変数を外す・Chromium の場所・Bun 1.4.2 の場所・コミットの作者・作業用のファイルの置き場・本番に送らない）は、公開しない手元のメモに従う。

## 前提（Task をまたぐ決まり）

1. GCC を作るのは `generate_gcc_certificate`（遅延のツール）と `POST /trade/gcc-generate` だけ。CORE の `check_product_compliance` には GCC の引数を足さない（Task 1）。
2. `generate_gcc_certificate` は `items`（1〜50 件、1 件 1 製品。16 CFR 1110.13(a) は 1 つの証明書に 1 製品）を受ける。トップレベルは、全品に共通の `certifier`・`recordCustodian`、表紙に載せる `orderNumber`・`awbNumber`・`carrier`・`invoiceNumber`、`allowDraft` だけ。REST と MCP は同じ zod のスキーマを使う。
3. 各品の `htsCode`（数字だけにして 10 桁）と `productName`（英語の一般名）は必須。GCC の作成は HTS を推測せず、判例（CROSS）も HTS の全件のデータも読まない（CPSC の一覧と HTS の桁だけで判断）。
4. 証明書に載せる値は呼び出し側が渡したものだけ。商品ページ（`url`）から読んだ値は候補（`suggestions`）として返すだけ（Task 8）。
5. 証明書の規則（16 CFR 1110.11(a)(2)）は呼び出し側の `citations`（試験報告書にある規則）。`citations: []` は「当てはまる規則が無いことを証明者が確かめた」という答え。Sora が当てはまると判断した規則（ボタン電池・コイン電池の 16 CFR 1263、衣料の 16 CFR 1610）が `citations` に無ければ下書きにする。
6. 当事者（証明者・記録の担当・工場・試験した者）は同じ形 `{ name, street, city, state, country, email, phone }`。証明者と記録の担当は、呼び出し側の値か、サーバーの `SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN`（JSON）の、どちらか 1 つから丸ごと取る。項目ごとに混ぜない。
7. 出力は JSON の要約と、印刷用の HTML（`packageHtml`）だけ。Markdown と、品ごとの判定の全体（`compliance`）は返さない。
8. 生地の重さは `fabricWeightOzPerSqYd`（16 CFR 1610.1(d)(1) の単位）だけにし、`fabricWeightGsm` は作らない。衣料の判定の引数（生地の 2 つ）は `check_cpsc_certificate`・`check_product_compliance`・`generate_gcc_certificate` に置き、`predict_hts_code` には置かない（predict は生地の質問を出さない）。
9. scrape・crawl の出力は v4.1 のまま（`html_parser.ts` は変えない）。商品の JSON-LD は、GCC の中で scrape の `jsonLd` から読む。

## ファイルの分担

| ファイル | 受け持ち |
|---|---|
| `src/services/trade.ts` | CPSC・FDA・HTS の判定（衣料の 16 CFR 1610、CPSC の一覧の区分、ボタン電池）。`TradeInputError` |
| `src/services/cpsc_hts_data.ts` | CPSC の一覧（M13 の 5 件を足す） |
| `src/services/gcc.ts`（新） | GCC の入力の確かめ・各品の判定・完全さ・ID・応答・商品ページの候補 |
| `src/services/gcc_html.ts`（新） | 印刷用の HTML（GCC・Disclaim B の説明・Disclaim A の説明・CPC の注意・表紙） |
| `src/services/gcc.test.ts`（新） | GCC のテスト |
| `src/types.ts` | REST のスキーマと OpenAPI |
| `src/mcp/tools_trade.ts` | MCP の登録 |
| `src/routes/trade.ts` | `POST /trade/gcc-generate` |
| `src/scraper.ts` | `export * from './services/gcc.js';` を 1 行足す |

---

### Task 0: 統合（作業ツリーの差分を v4.1 の先頭に当てる）

**対象:** 作業ツリーの差分の 22 ファイル（`client/` は当てずに作り直す）、`src/context_budget.test.ts`、`src/index.test.ts`、`src/services/trade.test.ts`。

**Interfaces:**
- Consumes: v4.1 の先頭（この Task を始めたときの `HEAD`。以下 `BASE`。計画を書いたときは 8ddda7c。6081c6e と 8ddda7c のどちらに当てても、衝突は下の 5 つのファイルだけだった）。作業ツリーの差分の写し（手元のメモの場所）。
- Produces: 機能を載せた木。`TradeInputError(message: string, code = 'INVALID_INPUT')`（`readonly code: string`）。`generateGccCertificate`・`TradeGccIncompleteError`・`checkCpscCertificate(options: CpscCertificateCheckOptions)` は作業ツリーの形のまま（Task 1〜8 で直す）。`POST /trade/gcc-generate`。MCP の 53 ツール目 `generate_gcc_certificate`。

**衝突の決まり（重なる 12 ファイル）。** v4.1 の、既にある引数の削除（`check_cpsc_certificate` の `productCategory`・`description`、`check_fda_regulated` の `productDescription`）と describe を残す。GCC の振る舞いで正しくなくなる describe だけ、下の表の文に書き直す。MCP の既にある 5 つの貿易のツールのスキーマは v4.1 のまま（作業ツリーの `*.shape` への置き換えは取らない）。

| ファイル | 決まり |
|---|---|
| `src/services/trade.ts` | 衝突 1（`checkCpscCertificate` の頭と、その前の `isWearingApparelChapter`・`toPublicReg`）は作業ツリーの側。衝突 2（`predictHtsCode` の中の CPSC の呼び出し）は v4.1 の側。衝突 3（`checkProductCompliance` の中の CPSC の呼び出し）は作業ツリーの側から `productCategory`・`description` の 2 行を除いたもの。自動で合わさった部分（v4.1 のリストに無いコードの案内、`cpscAsks` を外したこと、`checkFdaRegulated` の `productDescription` を外したこと）はそのまま。C7 の変更は手順 6 で外す。 |
| `src/types.ts` | `CpscCertificateCheckRequestSchema`: v4.1 の行に、作業ツリーの `hasBattery`・`batteryType`・生地の 3 つを足す（`productCategory`・`description` は足さない）。`ProductComplianceRequestSchema`: v4.1 の行に、作業ツリーで足した `sku`・`brand`・`modelOrBatch`・生地の 3 つ・`certifier`・`recordCustodian`・`manufacture`・`testing`・`generateGcc` を足す（`GccOrderItemFieldsShape` を広げて置き換えない）。`PredictHtsCodeRequestSchema`: v4.1 のまま。GCC のスキーマ（`GccOrderItemFieldsShape`・`GenerateGccCertificateRequestSchema` など）と応答のスキーマは作業ツリーのまま。 |
| `src/mcp/tools_trade.ts` | 5 つの衝突はすべて v4.1 の側（インラインのスキーマ）。`import { z } from 'zod';` を戻す。`check_product_compliance` のツール単位の説明は v4.1 の文に戻す（自動で入った「, gcc」を取らない。14 ツールの説明の合計を 3,495 字のままにする）。`generate_gcc_certificate` の登録は作業ツリーのまま。 |
| `src/services/trade.test.ts` | import は両方の和。作業ツリーのテストの `checkFdaRegulated({ htsCode, productDescription, foodContact })` から `productDescription` を除く（v4.1 で消した引数で、型の誤りになる）。 |
| `src/html_parser.ts`・`src/mcp/instructions.ts`・`src/index.test.ts` | 衝突なし。作業ツリーの側（`html_parser.ts` は Task 1、instructions は Task 9 で直す）。 |
| `README.md` | 衝突（貿易のツールの表の行）は、v4.1 の行に作業ツリーの新しい引数の記述を足す。数（52→53 など）は Task 10 でまとめて直す。 |
| `client/catalog.json`・`client/servers/sora/*` | 当てない。手順 8 で `bun run gen:client` で作り直す。 |

describe の書き直し（v4.1 の文の一部を置き換える。REST と MCP の両方）:

| 引数 | v4.1 の文から外す部分 | 代わりに入れる部分 |
|---|---|---|
| `check_cpsc_certificate` の `targetAge` | `証明書の種類を決めるのは、リストの10桁と完全に一致したときだけ。` | `12歳以下は GCC でなく CPC。` |
| `check_cpsc_certificate` の `material`（REST だけ。MCP は Task 2） | `判定は変えず、確認の質問を出すか消すかだけ。` | `衣料では繊維の組成（"100% polyester" の形）で 16 CFR 1610.1(d)(2) の免除を決める。ほかでは確認の質問を出すか消すかだけ。` |
| `check_product_compliance` の `hasBattery` | `trueのときだけ推測の検索語にbatteryを足し、batteryTypeがあれば注意書きを1行足す。falseでは何もしない。` | `trueのときだけ推測の検索語にbatteryを足す。batteryTypeがbutton_coinなら、CPSCの判定に16 CFR 1263を当て、注意書きを1行足す。falseでは何もしない。` |

- [ ] **Step 1: 始める前に確かめる。** v4.1 の作業ツリーで `git status --short` が空であること（ほかの作業の途中なら終わるまで待つ。他人の変更を stash・checkout・clean しない）。`git rev-parse HEAD` を `BASE` として作業用の記録に書く。
- [ ] **Step 2: 差分の写しを作り、実在に見える値を置き換える。** 作業ツリーの差分の写し（手元のメモの場所）を作業用の場所に複製し、手元のメモの置き換え表で置き換える（長い元の値から順に）。置き換えたあと、手元のメモの grep の一覧が写しの中で 0 件であることを確かめる。元の差分のファイルは変えない。
- [ ] **Step 3: 当てる。**

```bash
git apply --3way --exclude='client/*' <作業用の場所>/gcc.patch
git status --short   # 衝突は README.md・src/mcp/tools_trade.ts・src/services/trade.test.ts・src/services/trade.ts・src/types.ts の 5 つ
```

- [ ] **Step 4: 衝突を上の表のとおりに解き、describe を書き直す。** `rg -n '^(<<<<<<<|=======|>>>>>>>)' src README.md` が 0 件。
- [ ] **Step 5: C7 の回帰のテストを先に書く**（`src/services/trade.test.ts` の `age and gender line selection` の describe）。

```ts
it('keeps the adult apparel line when targetAge is adult (the age/gender change is not part of v4.1)', async () => {
  const input = { productName: "Men's Thermal Undershirt", description: 'cotton knit thermal undershirt', material: 'cotton' };
  const adult = await predictHtsCode({ ...input, targetAge: 'adult' });
  const plain = await predictHtsCode(input);
  expect(adult.bestMatch.htsCode).toBe('6109.10.00.11');
  expect(plain.bestMatch.htsCode).toBe('6109.10.00.11');
});
```

Run: `bun test src/services/trade.test.ts -t 'keeps the adult apparel line'`
Expected: FAIL（`adult` が `6109.10.00.12` Men's になる）

- [ ] **Step 6: C7 の変更を外す。** `src/services/trade.ts` の次の部分を `BASE` と同じにする: `ProductAgeGender` の `adult?: boolean`、`detectProductAgeGender` の説明の「unisex … women's / girls' 側に分類する」の行と、本体の `adult` と `unisex` の 5 行、`matchMarkerSet` の `boys`・`girls`・`infants` の 3 つの枝、`predictHtsCode` の `notInfant`・`babyExcluded`（宣言・`add`・`score *= 0.25`）、`fused.set` の形、`textTop` の行、`ageGender` の宣言の位置（「5. 最有力の6桁の中の行」の注釈の下へ戻す）。`git diff BASE -- src/services/trade.ts | rg 'notInfant|babyExcluded|info\.adult|unisex'` が 0 件。Step 5 のテストが通る。レビューの残りの 2 つの入力（第62類のジーンズとコーデュロイのズボン）はテスト用の HTS の抜粋に無いので、手元のメモの HTS の写しと probe で一度だけ確かめ、`BASE` と同じコード（6203.42.45.11・6204.62.80.06）であることを作業の記録に書く。
- [ ] **Step 7: 数・予算・遅いテストを合わせる。**
  - `src/index.test.ts` の題 `MCP server should register all 52 tools` を `all 53 tools` にする（M9）。
  - `src/context_budget.test.ts` の `allToolsListChars` を一時的に `65_000` にする（統合した直後は 64,368 字。Task 4 で 64,000 に戻す。理由はコミットの本文に書く）。
  - 作業ツリーのテスト `does not misclassify Japanese product pages …` に、テストごとの時間の上限 `15_000` を付ける（I9。このテストは Task 1 で振る舞いと一緒に消える）。
- [ ] **Step 8: クライアントを作り直す。** `bun run gen:client`。`client/servers/sora/generate_gcc_certificate.ts` ができ、`src/client_sync.test.ts` が通る。
- [ ] **Step 9: 確かめる。**

```bash
bun test src/services/trade.test.ts src/index.test.ts src/llm_contract_sync.test.ts src/context_budget.test.ts src/client_sync.test.ts src/response_schema_contract.test.ts src/trade_tracking_watch_params.test.ts src/stdio_transport.test.ts src/x_post_contract.test.ts scripts/schema-notation/repository.test.ts
bun run typecheck && bun run lint
bun scripts/measure-context.ts   # 既定 21,764・全ツール 64,368 前後・instructions 9,000 未満
```

全件のテストを手元の Bun で 1 回（手元のメモの命令）。手元のメモの grep の一覧が `git diff --cached` で 0 件。

- [ ] **Step 10: コミット。**

```bash
git add -A src scripts README.md client
git commit -m "feat(trade): add generate_gcc_certificate and the customs clearance package" -m "Brings the uncommitted GCC work onto v4.1 with fictional contact data and without the HTS age/gender change. Raises the all-tools budget to 65,000 for this commit only; the GCC input rework restores 64,000."
```

### Task 1: check_product_compliance と scrape を v4.1 の形に戻す

**対象:** `src/services/trade.ts`（`checkProductCompliance`・`buildIntegratedActionPlan`・GCC の中の SKU の読み方）、`src/types.ts`（`ProductComplianceRequestSchema`・`CheckProductComplianceResultSchema`）、`src/html_parser.ts`、`src/routes/trade.ts`（`/trade/compliance`）、`src/services/trade.test.ts`・`src/html_parser.test.ts`・`src/index.test.ts`・`src/response_schema_contract.test.ts`・`src/trade_tracking_watch_params.test.ts`、README の `check_product_compliance` の行。

GCC は遅延のツールだけで作る（前提 1）。CORE のツールは全員の初期の一覧に載るので、GCC の引数を足さない（使わない人に負担をかけない。I4 の「`gcc.compliance` の二重の入れ子」もこれで消える）。scrape の出力も全員に効くので、作業ツリーの `html_parser.ts` の変更（ProductGroup の種類の SKU・値段・在庫を読む）を戻す（I11 の決定）。

**Interfaces:**
- Consumes: Task 0 の木。
- Produces: `CheckProductComplianceOptions` と `CheckProductComplianceResult` から `sku`・`brand`・`modelOrBatch`・`generateGcc`・`certifier`・`recordCustodian`・`manufacture`・`testing`・`gcc`・`product.sku`・`product.brand` が消える（生地の 3 つは Task 2 で 2 つにする）。`html_parser.ts` は `BASE` と同じ。GCC の中の品の SKU・ブランドは呼び出し側の値だけから取る。

- [ ] **Step 1: 失敗するテストを書く。**

```ts
// src/services/trade.test.ts（checkProductCompliance の describe）
it('ignores GCC arguments: no gcc field and no scraped sku or brand', async () => {
  const res = await checkProductCompliance({
    productName: 'Adult Bicycle Helmet', htsCode: '6506.10.60.45', targetAge: 'adult',
    generateGcc: true, sku: 'HLM-001', certifier: { name: 'Acme Imports LLC' },
  } as never);
  expect(res).not.toHaveProperty('gcc');
  expect(res.product).not.toHaveProperty('sku');
  expect(res.product).not.toHaveProperty('brand');
});

it('reports the predicted category as detectedCategory even when the given code is another heading (as in v4.1)', async () => {
  const res = await checkProductCompliance({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', htsCode: '9503.00.00.73' });
  expect(res.product.detectedCategory).toBe(res.htsPrediction?.category);
  expect(res.product.detectedCategory).toContain('Ceramic');
});
```

```ts
// src/html_parser.test.ts
it('does not take a variant SKU, price or availability from ProductGroup.hasVariant (scrape output stays as in v4.0.0)', () => {
  const ld = {
    '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Logo Tee', brand: { '@type': 'Brand', name: 'Acme' },
    hasVariant: [
      { '@type': 'Product', name: 'Logo Tee - S', sku: 'TEE-S', offers: { '@type': 'Offer', url: 'https://shop.test/p?variant=11', price: '20.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' } },
      { '@type': 'Product', name: 'Logo Tee - M', sku: 'TEE-M', offers: { '@type': 'Offer', url: 'https://shop.test/p?variant=12', price: '22.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
    ],
  };
  const html = `<!doctype html><html><head><title>T</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><main><p>${'Body text for the product page. '.repeat(20)}</p></main></body></html>`;
  for (const url of ['https://shop.test/p', 'https://shop.test/p?variant=11']) {
    const r = convertHtmlToMarkdown(html, url);
    expect(r.brand, url).toBe('Acme');
    expect(r.sku, url).toBeUndefined();
    expect(r.price, url).toBeUndefined();
    expect(r.availability, url).toBeUndefined();
  }
  const offerOnly = { '@context': 'https://schema.org', '@type': 'Product', name: 'Mug', offers: { '@type': 'Offer', sku: ' MUG-1 ', price: '9', priceCurrency: 'USD' } };
  const r = convertHtmlToMarkdown(html.replace(JSON.stringify(ld), JSON.stringify(offerOnly)), 'https://shop.test/m');
  expect(r.sku).toBeUndefined();
});
```

```ts
// src/trade_tracking_watch_params.test.ts
// expectedProps に足す（v4.1 の 10 個。生地の 2 つは Task 2 で足す）
check_product_compliance: ['url', 'productName', 'description', 'htsCode', 'targetAge', 'material', 'productCategory', 'foodContact', 'hasBattery', 'batteryType'],
// REST の describe に足す
test('ProductComplianceRequestSchema drops the GCC fields', () => {
  const parsed = ProductComplianceRequestSchema.parse({ productName: 'x', generateGcc: true, sku: 'S', certifier: { name: 'n' } }) as Record<string, unknown>;
  for (const field of ['generateGcc', 'sku', 'certifier']) expect(parsed[field], field).toBeUndefined();
});
```

`src/index.test.ts` の貿易の REST のテスト（外の API の偽物を入れている所）に、`POST /trade/compliance` に `generateGcc: true` と `sku` を送ると 200 で、応答に `gcc` が無いことを足す。

Run: `bun test src/services/trade.test.ts src/html_parser.test.ts src/trade_tracking_watch_params.test.ts`
Expected: FAIL（`gcc` がある、`detectedCategory` が 9503 の見出し、`sku` が `TEE-M`、REST のスキーマが `generateGcc` を通す）

- [ ] **Step 2: 戻す。**
  - `checkProductCompliance`: 作業ツリーで足した `sku`・`brand` の読み取り（引数と scrape の結果の両方）、`product` の `sku`・`brand`、日本語の題の早めの戻り（`callerProvidedEnglish` の塊）、`generateGcc` の 4 か所の `buildSingleGccItemResult(1, …)`、`resolvedDetectedCategory` を消し、`detectedCategory: detectedCategory || productCategory` に戻す。CPSC の呼び出しに渡す電池・生地の引数は残す。
  - `buildIntegratedActionPlan`: CCC の 2 つの行を v4.1 の文に戻す（「本システムのGCC自動生成は…非対応です」を消す）。Disclaim B の枝（`certificateRequired === false && testingExemption?.enforcementDiscretion`）と FDA の FCS の行は残す（Task 6 で条文の番号を直す）。
  - `src/routes/trade.ts` の `/trade/compliance` に足された `TradeInputError` の行を消す（GCC を作らなくなり、投げる所が無い）。
  - `src/types.ts`: `ProductComplianceRequestSchema` から GCC の 8 つの項目と `generateGcc` を消す。`CheckProductComplianceResultSchema` を v4.1 の形（`product` に `sku`・`brand` が無く、`gcc` が無い）に戻し、GCC の応答のスキーマが使っていた `CheckProductComplianceBaseResultSchema` は `CheckProductComplianceResultSchema` に置き換える（Task 4 で GCC の側から消える）。
  - GCC の中（`buildSingleGccItemResult`）の SKU・ブランドは `input.sku`・`input.brand` だけから取る（scrape の値を証明書に載せない。I3 の一部）。`generateGccCertificate` の `checkProductCompliance` の呼び出しから `sku`・`brand`・`generateGcc` を外す（型から消えるため。この呼び出しは Task 4 で無くなる）。
  - `src/html_parser.ts` を `BASE` の中身にする: `git show BASE:src/html_parser.ts > src/html_parser.ts`。
- [ ] **Step 3: 振る舞いとともに要らなくなったテストを消す。** `src/services/trade.test.ts` の `Schema.org Product JSON-LD variant SKU extraction` の describe（3 件）と `extractMetadataFromJsonLd` の import、`does not misclassify Japanese product pages …`（I9 の遅いテスト）、`integrates generateGcc: true directly into checkProductCompliance …`。`src/index.test.ts` の GCC の REST のテストの「3. POST /trade/compliance (generateGcc: true)」の部分。`src/response_schema_contract.test.ts` の `compliance with generateGcc` の行。README の `check_product_compliance` の行を v4.1 の文に戻す（`generateGcc`・SKU の自動抽出の記述を消す）。
- [ ] **Step 4: 通ることを確かめる。** Step 1 の命令が PASS。`bun test src/index.test.ts src/response_schema_contract.test.ts src/llm_contract_sync.test.ts src/client_sync.test.ts`（クライアントは `bun run gen:client` で作り直してから）。`git diff BASE -- src/services/trade.ts | rg 'callerProvidedEnglish|resolvedDetectedCategory|generateGcc'` が 0 件。`git diff BASE -- src/html_parser.ts` が空。
- [ ] **Step 5: コミット。** `fix(trade): keep GCC generation out of check_product_compliance and leave scrape output unchanged`

### Task 2: CPSC の判定 — 衣料の 16 CFR 1610（語の表と正規表現をやめる）

**対象:** `src/services/trade.ts`（衣料の判定、`checkCpscCertificate` の衣料の枝、`predictHtsCode` の CPSC の呼び出し）、`src/types.ts`、`src/mcp/tools_trade.ts`（`check_cpsc_certificate`・`check_product_compliance`）、`src/services/trade.test.ts`、`src/trade_tracking_watch_params.test.ts`、README（2 つのツールの行と §3.18）。

直す指摘: I1（16 CFR 1610.1(c) を語の正規表現で決めて Disclaim A を誤る）、方針（`MATERIAL_MODIFIER_WORDS` の語の表）、M14（88.2 g/m² への丸め）、M7（一覧に無い衣料のコードに一覧を出典として付ける）。

**Interfaces:**
- Consumes: Task 1 の木。
- Produces（`src/services/trade.ts` から export）:

```ts
export interface CpscCertificateCheckOptions {
  htsCode: string;
  targetAge: 'adult' | 'child' | 'unknown';
  material?: string;
  hasBattery?: boolean;
  batteryType?: 'button_coin' | 'other';
  fabricSurface?: 'plain' | 'raised';
  fabricWeightOzPerSqYd?: number;
  /** 内部用。生地の引数を持たない predict_hts_code は false（衣料の 1610 の質問を出さない） */
  askFabricSpec?: boolean;
}
/** 81 FR 12587 の題・掲載・効力の日（Federal Register の本文から写した） */
export const ADULT_APPAREL_GCC_POLICY = {
  title: 'Statement of Policy on Enforcement Discretion Regarding General Conformity Certificates for Adult Wearing Apparel Exempt From Testing',
  citation: '81 FR 12587 (Mar. 10, 2016)',
  effective: 'March 25, 2016',
} as const;
/** 16 CFR 1610.1(c)(1)〜(3) の本文（eCFR、2026-11-05 時点）。(c)(4) の芯地は HTS の見出しで分からないので扱わない */
export const SECTION_1610_1_C = {
  '16 CFR 1610.1(c)(1)': 'Hats, provided they do not constitute or form part of a covering for the neck, face, or shoulders when worn by individuals',
  '16 CFR 1610.1(c)(2)': 'Gloves, provided they are not more than 14 inches in length and are not affixed to or do not form an integral part of another garment',
  '16 CFR 1610.1(c)(3)': 'Footwear, provided it does not consist of hosiery in whole or part and is not affixed to or does not form an integral part of another garment',
} as const;
/** 16 CFR 1610.1(d)(1)・(2) の本文 */
export const SECTION_1610_1_D = {
  '16 CFR 1610.1(d)(1)': 'Plain surface fabrics, regardless of fiber content, weighing 2.6 ounces per square yard or more',
  '16 CFR 1610.1(d)(2)': 'All fabrics, both plain surface and raised-fiber surface textiles, regardless of weight, made entirely from any of the following fibers or entirely from combination of the following fibers: acrylic, modacrylic, nylon, olefin, polyester, wool',
} as const;
export function section1610cExclusionFor(htsCode: string): { citation: keyof typeof SECTION_1610_1_C; text: string } | undefined;
export function parseFiberContent(material?: string): Array<{ percent: number; fiber: string }> | undefined;
```

- [ ] **Step 1: 失敗するテストを書く**（`src/services/trade.test.ts` に describe を足す。作業ツリーの `excludes standalone adult hats, gloves, and footwear …` は消し、ここの (c) のテストに置き換える。ほかの衣料のテストは `fabricWeightGsm` を oz/sq yd に直して残す: 180 g/m² → `fabricWeightOzPerSqYd: 5.3`、320 → `9.4`、310 → `9.1`、190 → `5.6`）。

```ts
// import に足す: parseFiberContent, section1610cExclusionFor（'./trade.js'）
describe('16 CFR 1610 for apparel (official text and HTS headings, no word lists)', () => {
  it('reads fiber content only in the "N% fiber" form', () => {
    expect(parseFiberContent('100% polyester')).toEqual([{ percent: 100, fiber: 'polyester' }]);
    expect(parseFiberContent('60% Wool, 40% Nylon')).toEqual([{ percent: 60, fiber: 'wool' }, { percent: 40, fiber: 'nylon' }]);
    expect(parseFiberContent('80% cotton 20% polyester')).toHaveLength(2);
    expect(parseFiberContent('60% wool / 40% nylon')).toHaveLength(2);
    for (const s of ['100% recycled polyester', 'polyester', 'ポリエステル100%', '50% cotton 40% polyester', '100% polyester (lining 100% cotton)', '']) {
      expect(parseFiberContent(s), s).toBeUndefined();
    }
  });

  it('does not exclude a cap sleeve blouse (review probe for I1): 1610.1(c) comes from the HTS heading, not from words', async () => {
    const blouse = await checkCpscCertificate({ htsCode: '6106.10.00.10', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain', fabricWeightOzPerSqYd: 2.0 });
    expect(blouse.certificateRequired).toBe(true);
    expect(blouse.certificateType).toBe('GCC');
    const withWords = await checkCpscCertificate({ htsCode: '6106.10.00.10', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain', fabricWeightOzPerSqYd: 2.0, description: "Women's cap sleeve knit blouse", productCategory: 'gloves' } as never);
    expect(withWords).toEqual(blouse);
  });

  it('explains the 16 CFR 1610.1(c) condition for hat, glove and footwear headings instead of deciding', async () => {
    for (const [htsCode, citation] of [['6505.00.80.90', '16 CFR 1610.1(c)(1)'], ['6116.10.17.40', '16 CFR 1610.1(c)(2)'], ['6402.99.31.65', '16 CFR 1610.1(c)(3)']] as const) {
      const res = await checkCpscCertificate({ htsCode, targetAge: 'adult' });
      expect(res.certificateRequired, htsCode).toBe('unknown');
      expect(res.missingInfo.join(''), htsCode).toContain(citation);
      expect(res.disclaimerCodeHint, htsCode).toBeUndefined();
    }
    expect(section1610cExclusionFor('6406.10.05.00')).toBeUndefined(); // 履物の部分品・ゲートル
    expect(section1610cExclusionFor('6506.10.60.45')?.citation).toBe('16 CFR 1610.1(c)(1)');
  });

  it('keeps bicycle helmets (CPSC list: Bicycle Helmets) on the GCC path although 6506 is a hat heading', async () => {
    const res = await checkCpscCertificate({ htsCode: '6506.10.60.45', targetAge: 'adult' });
    expect(res.certificateRequired).toBe(true);
    expect(res.certificateType).toBe('GCC');
  });

  it('exempts adult apparel under 16 CFR 1610.1(d)(2) and (d)(1) at exactly 2.6 oz/sq yd and points to Disclaim B / IUC 130.006', async () => {
    const poly = await checkCpscCertificate({ htsCode: '6109.90.10.07', targetAge: 'adult', material: '100% polyester' });
    expect(poly.certificateRequired).toBe(false);
    expect(poly.testingExemption).toMatchObject({ exempt: true, citation: '16 CFR 1610.1(d)(2)', enforcementDiscretion: true });
    expect(poly.disclaimerCodeHint).toContain('130.006');
    expect(poly.nextActions.join('')).toContain('81 FR 12587');
    const plain = await checkCpscCertificate({ htsCode: '6109.10.00.12', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain', fabricWeightOzPerSqYd: 2.6 });
    expect(plain.testingExemption).toMatchObject({ exempt: true, citation: '16 CFR 1610.1(d)(1)' });
    const light = await checkCpscCertificate({ htsCode: '6109.10.00.12', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain', fabricWeightOzPerSqYd: 2.59 });
    expect(light.certificateRequired).toBe(true);
  });

  it('requires a GCC for raised or light fabrics that are not made only of the six fibers', async () => {
    const fleece = await checkCpscCertificate({ htsCode: '6110.20.20.41', targetAge: 'adult', material: '80% cotton 20% polyester', fabricSurface: 'raised' });
    expect(fleece.certificateRequired).toBe(true);
    expect(fleece.testingExemption?.exempt).toBe(false);
    const stretch = await checkCpscCertificate({ htsCode: '6109.10.00.12', targetAge: 'adult', material: '95% polyester 5% spandex', fabricSurface: 'plain', fabricWeightOzPerSqYd: 2.1 });
    expect(stretch.certificateRequired).toBe(true);
  });

  it('asks for the fiber content in the "N% fiber" form when it cannot read it', async () => {
    const res = await checkCpscCertificate({ htsCode: '6109.90.10.07', targetAge: 'adult', material: '100% recycled polyester', fabricSurface: 'raised' });
    expect(res.certificateRequired).toBe('unknown');
    expect(res.missingInputs).toEqual(['material']);
    expect(res.clarifyingQuestions?.[0]).toContain('100% polyester');
  });

  it('cites the CPSC list only for codes on it (M7)', async () => {
    const unlisted = await checkCpscCertificate({ htsCode: '6106.10.00.10', targetAge: 'adult', material: '100% cotton', fabricSurface: 'raised' });
    expect(unlisted.applicableRegulations.map((r) => r.cfr).join('|')).not.toContain('CPSC HTS Guidance List');
    const listed = await checkCpscCertificate({ htsCode: '6109.90.10.09', targetAge: 'child', material: '100% polyester' });
    expect(listed.applicableRegulations[0].cfr).toContain('CPSC HTS Guidance List');
  });

  it('does not ask fabric questions from predict_hts_code, which has no fabric arguments', async () => {
    const res = await predictHtsCode({ productName: "Men's Thermal Undershirt", description: 'cotton knit thermal undershirt', material: 'cotton', targetAge: 'adult' });
    for (const k of ['fabricSurface', 'fabricWeightOzPerSqYd', 'material']) expect(res.missingInputs ?? [], k).not.toContain(k);
  });

  it('asks check_product_compliance callers for the fabric facts it now takes', async () => {
    const base = { productName: "Men's Cotton T-Shirt", description: 'Short sleeve knitted crew neck tee', htsCode: '6109.10.00.12', targetAge: 'adult' as const, material: '100% cotton' };
    const asked = await checkProductCompliance(base);
    expect(asked.missingInputs).toContain('fabricSurface');
    const done = await checkProductCompliance({ ...base, fabricSurface: 'plain', fabricWeightOzPerSqYd: 5.3 });
    expect(done.cpsc?.certificateRequired).toBe(false);
    expect(done.actionPlan.join('')).toContain('130.006');
  });
});
```

`src/trade_tracking_watch_params.test.ts` の `expectedProps` を、`check_cpsc_certificate: ['htsCode', 'targetAge', 'material', 'fabricSurface', 'fabricWeightOzPerSqYd']`、`check_product_compliance` に `'fabricSurface', 'fabricWeightOzPerSqYd'` を足した 12 個にする。

Run: `bun test src/services/trade.test.ts src/trade_tracking_watch_params.test.ts`
Expected: FAIL（`parseFiberContent`・`section1610cExclusionFor` が無い、cap sleeve が除外される、MCP に生地の引数が無い など）

- [ ] **Step 2: 直す。**
  1. `APPAREL_1610_C_EXCLUSION_RE`・`APPAREL_1610_C_DISQUALIFIER_RE`・`MATERIAL_MODIFIER_WORDS`・`isSolely1610d2ExemptFiber`・`MIN_EXEMPT_GSM`・`OZ_PER_SQ_YD_TO_GSM`・`fabricWeightGsm`（関数・型・REST のスキーマ・`TradeFabricFieldsShape`）を消す。`CpscCertificateCheckOptions` から `productCategory`・`description` を消す。`EXEMPT_1610_D2_FIBERS`（(d)(2) の写し）は残す。GCC の中（作業ツリーの Disclaim B の説明の生地の行と `GccOrderItemInput`）も `fabricWeightOzPerSqYd` だけにする（g/m² の換算の表示を消す）。
  2. `parseFiberContent`: 小文字にして前後の空白を除き、先頭から `(\d{1,3}(?:\.\d+)?)\s*%\s*([a-z]+)` を、区切り（前後に空白があってよい `,`・`/`・`+`・`&`、前後に空白のある `and`、空白）をはさんで最後まで読み切れたときだけ返す。読み切れない・空のとき、繊維が 1 つで 100 ちょうどでないとき（「made entirely」。`99.6% polyester` は読めない扱い）、2 つ以上で合計が 100 から 0.5 より離れるとき（丸め）は `undefined`。語の表は持たない（6 つの繊維の写しは判定にだけ使う）。
  3. `section1610cExclusionFor`: HTS の数字の先頭 4 桁が `6504`・`6505`・`6506`（第65類の帽子）なら (c)(1)、`6116`・`6216`（手袋）なら (c)(2)、`6401`〜`6405`（第64類の履物。`6406` は部分品・ゲートルなので除く）なら (c)(3)。
  4. 衣料の枝に入る条件: 一覧の完全一致の区分が `Clothing` か `Shoes`、または一覧に無く（完全一致が無く）、第61・62類か `section1610cExclusionFor` に当たるとき。ほかの区分（例 6506.10 の `Bicycle Helmets`）は区分の枝のまま。
  5. 衣料の枝（ボタン電池の枝の後、`targetAge` ごと）:
     - `child`: CPC（作業ツリーのとおり）。`applicableRegulations` は、一覧にあるときだけ一覧の項目、次に `Clothing` の項目、`CPSIA_CHILDREN_GENERAL_REGULATION`（M7）。16 CFR 1610.1(c) は年齢によらないので、(c) の見出しでは `Clothing`（16 CFR 1610）の項目を載せず、(c) の条件を `missingInfo`・`nextActions` に書く（条件に当たれば CPC に 16 CFR 1610 は要らない。当たらなければ 16 CFR 1610 も要る）。
     - `unknown`: `targetAge` を聞く（作業ツリーのとおり）。一覧にあるコードは一覧の項目を載せる。生地の質問は `askFabricSpec !== false` のときだけ足す。(c) の見出しでは、質問と `impactExplanation` に (c) の条件を挙げる（大人なら (c) の条件で決まる。(d)・Disclaim B の文にしない）。
     - `adult` で (c) の見出し: `certificateRequired: 'unknown'`・`certificateType: 'unknown'`・`eFilingRequired: false`・`inputCompleteness: 'complete'`（この道具の引数では答えが変わらない）。`missingInfo: ['${citation} の条件（${text}）に当たるかで決まります。']`、`nextActions: ['条件に当たれば 16 CFR 1610 の対象外です。ほかに当てはまる規則が無ければ GCC は要りません（CPSC の一覧のコードなら ACE で Disclaim A を送れます。Intended Use Code も要ります）。当たらなければ 16 CFR 1610 の対象です。']`。条件に当たらないときの答えとして、下の (d) の判定（免除・免除に当たらない・不明と足りないものの質問）も `nextActions` に足す。近いコードの区分の案内（例 6506.10 の `Bicycle Helmets` と 16 CFR 1203）は残す。`disclaimerCodeHint` は付けない。
     - `adult` でほか: (d) の判定。`d2` は `parseFiberContent` が読めて全部 6 つの繊維なら yes、読めて 1 つでも違えば no、読めなければ不明。`d1` は `fabricSurface === 'plain'` で重さがあり 2.6 以上なら yes、2.6 未満か `raised` なら no、ほかは不明（重さは oz/sq yd のまま比べ、丸めない。M14）。`d2` か `d1` が yes なら免除、両方 no なら免除に当たらない、ほかは不明。
     - 免除（大人）: `certificateRequired: false`・`certificateType: 'none'`・`eFilingRequired: false`・`disclaimerCodeHint: 'B (Intended Use Code 130.006)'`・`testingExemption: { exempt: true, citation: '16 CFR 1610.1(d)(1)' か '(d)(2)', reason, enforcementDiscretion: true }`・`nextActions: ['16 CFR 1610.1(d) の試験の免除に当たる大人の衣料なので、81 FR 12587（2016年3月25日から）の執行裁量で GCC と eFiling は要りません。ACE では Disclaim B と Intended Use Code 130.006 を送ります。燃焼性の基準（16 CFR 1610）には引き続き合っている必要があります。']`。`reason` は「繊維の組成（{material}）が 16 CFR 1610.1(d)(2) の 6 つの繊維だけなので」または「平らな生地で {oz} oz/sq yd（2.6 以上）なので 16 CFR 1610.1(d)(1) により」に「燃焼性の試験は要りません。」を続ける。
     - 免除に当たらない（大人）: GCC・eFiling（作業ツリーのとおり）。`applicableRegulations` は、一覧にあるときだけ一覧の項目、次に `Clothing` の項目（M7）。6 つの名前と違う繊維で `d2` が no のときは、`nextActions` に「16 CFR 1610.1(d)(2) の 6 つの繊維の名前（acrylic・modacrylic・nylon・olefin・polyester・wool）と同じ名前のときだけ免除と判定しています。別の名前（例: polyamide は nylon、polypropylene は olefin）なら、その名前に書き直して確かめてください。」を足す（語の表は持たない）。足りない生地の事実の案内は、足りないものだけを挙げる。
     - 不明（大人）: `askFabricSpec !== false` のとき、足りないものだけを順に `missingInputs`・`clarifyingQuestions` に入れる。`material`（`d2` が不明で `d1` が yes でないとき）: `衣料の繊維の組成を「100% polyester」「60% wool 40% nylon」の形で material に入れてください（16 CFR 1610.1(d)(2) の 6 つの繊維 acrylic・modacrylic・nylon・olefin・polyester・wool だけなら試験は要りません。繊維は一般名で書きます。例: polyamide は nylon、polypropylene は olefin）。`、`fabricSurface`（未指定のとき）: `生地の表面は平ら（plain）ですか、起毛（raised: フリース・パイル・裏起毛など）ですか？`、`fabricWeightOzPerSqYd`（`raised` でなく重さが無いとき）: `生地の重さは何 oz/sq yd ですか（g/m² なら 33.906 で割ります。平らな生地で 2.6 以上なら 16 CFR 1610.1(d)(1) により試験は要りません）？`。`askFabricSpec === false` のときは何も聞かず、`impactExplanation` に「16 CFR 1610.1(d) の免除に当たるかで、GCC が要るか（Disclaim B か）が変わります。check_cpsc_certificate に繊維の組成・生地の表面・重さを渡すと決まります。」と書く。
  6. `Clothing` の区分の項目の `summary` を「衣料品の可燃性基準（16 CFR 1610）。大人の衣料で 16 CFR 1610.1(d) の試験の免除に当たるものは、81 FR 12587（2016年3月25日から）の執行裁量で GCC・eFiling が要らない（ACE Disclaim B / Intended Use Code 130.006）。子供用寝間着は 16 CFR 1615/1616 も当たる。」にする。
  7. `predictHtsCode` の CPSC の呼び出しに `askFabricSpec: false` を足す（ほかは v4.1 のまま）。`checkProductCompliance` は `fabricSurface`・`fabricWeightOzPerSqYd` を渡す。
  8. スキーマと describe（REST と MCP。MCP は types.ts の `.shape.<名前>` を使い、REST と同じ型・範囲にする）:
     - `fabricSurface: z.enum(['plain', 'raised']).optional().describe('衣料の生地の表面（plain: 平ら, raised: 起毛・フリース・パイル）。16 CFR 1610.1(d)(1) の判定に使う。不明なら省略')`
     - `fabricWeightOzPerSqYd: z.number().min(0.1).max(100).optional().describe('衣料の生地の重さ（oz/sq yd。g/m² なら 33.906 で割る）。平らな生地で 2.6 以上なら 16 CFR 1610.1(d)(1) の免除。不明なら省略')`（`exclusiveMinimum` を出さないよう `.positive()` は使わない）
     - `check_cpsc_certificate` に 2 つ、`check_product_compliance` に 2 つ足す。MCP の `check_cpsc_certificate` の `material` も Task 0 の表の文にする。`check_product_compliance` の `material` の describe の末尾に「衣料は "100% polyester" の形（16 CFR 1610.1(d)(2)）」を足す。
  9. README: 2 つのツールの行に 2 つの引数を書き、§3.18 に「衣料（第61・62類と CPSC の一覧の Clothing・Shoes）は 16 CFR 1610.1(d) の試験の免除で決まり（大人で免除なら Disclaim B / 130.006）、帽子・手袋・履物の見出しは 16 CFR 1610.1(c) の条件の説明を返す」を 2 文で足す。
- [ ] **Step 3: 通ることを確かめる。** Step 1 の命令が PASS。`bun test src/services/trade.test.ts src/index.test.ts src/response_schema_contract.test.ts src/llm_contract_sync.test.ts`。`rg -n 'fabricWeightGsm|MATERIAL_MODIFIER_WORDS|APPAREL_1610_C_' src` が 0 件。`bun run gen:client`。
- [ ] **Step 4: コミット。** `fix(trade): decide the 16 CFR 1610 apparel rules from the HTS headings and the regulation text`

### Task 3: CPSC の判定 — 一覧の区分とボタン電池（年齢の表をやめる）

**対象:** `src/services/trade.ts`（`CPSC_CATEGORY_REGULATIONS`・区分の枝・近いコードの枝・ボタン電池の枝）、`src/services/cpsc_hts_data.ts`、`src/types.ts`・`src/mcp/tools_trade.ts`（`check_cpsc_certificate` の電池の 2 つ、`batteryType` の describe）、`src/services/trade.test.ts`、`src/trade_tracking_watch_params.test.ts`、README。

直す指摘: C3（`regulatedScope: 'children_only'` で大人のたんす・13 歳向けの玩具を Disclaim A にする）、C4（ドライウォールを 16 CFR 1460 とする）、I7（子供の家具の規則の不足）、M5（玩具の除外は § 1263.1(c) で 14 歳未満。(d) は空気亜鉛電池）、M13（近いコードの「B」の案内と、一覧の 5 件の抜け）。

**Interfaces:**
- Consumes: Task 2 の `CpscCertificateCheckOptions`。
- Produces: `export function findCpscListCategory(htsCode: string): string | undefined`（数字だけにして一覧の完全一致を引く）。`CPSC_CATEGORY_REGULATIONS: Record<string, CpscApplicableRegulation>` は 3 件（`Clothing`・`Infant Sleep Products`・`Toys`）。

- [ ] **Step 1: 失敗するテストを書く**（作業ツリーの `returns ACE Disclaim A (certificateRequired: false) for adult items in children-only CPSC categories …` は消し、次に置き換える。`applies cross-cutting 16 CFR Part 1263 …` の注釈の「16 CFR 1263.1(d) toy exemption」を「16 CFR 1263.1(c)」に直す。作業ツリーの GCC のテスト `generates a multi-SKU post-shipment …` からは大人のフィギュア（9503.00.00.90）の品を外し、`counts` をそれに合わせる（この品は GCC が要る側になり、試験の記録が無いので下書きになる。このテストは Task 4 で作り直す）。

```ts
// import に足す: findCpscListCategory（'./trade.js'）、CPSC_HTS_LIST（'./cpsc_hts_data.js'）
describe('CPSC list categories and button cells (no age table)', () => {
  it('requires a GCC for adult items on children’s and mattress codes instead of Disclaim A (review probes for C3 and M13)', async () => {
    for (const [htsCode, material] of [['9403.50.90.80', 'wood'], ['9503.00.00.90', 'plastic'], ['9404.29.90.95', 'polyurethane foam']] as const) {
      const res = await checkCpscCertificate({ htsCode, targetAge: 'adult', material });
      expect(res.certificateRequired, htsCode).toBe(true);
      expect(res.certificateType, htsCode).toBe('GCC');
      expect(res.disclaimerCodeHint, htsCode).toBeUndefined();
    }
  });

  it('does not cite 16 CFR 1460 for drywall or a partial list for children’s furniture (C4, I7)', async () => {
    const drywall = await checkCpscCertificate({ htsCode: '6809.11.00.10', targetAge: 'adult', material: 'gypsum' });
    expect(JSON.stringify(drywall)).not.toContain('1460');
    expect(drywall.applicableRegulations.map((r) => r.cfr)).toContain('個別規格要確認');
    const crib = await checkCpscCertificate({ htsCode: '9403.50.90.41', targetAge: 'child', material: 'wood' });
    expect(crib.applicableRegulations.map((r) => r.cfr)).toContain('個別規格要確認');
  });

  it('cites infant sleep products as 16 CFR 1236 / 1218 / 1241', async () => {
    const res = await checkCpscCertificate({ htsCode: '9404.90.96.22', targetAge: 'child', material: 'polyester' });
    expect(res.applicableRegulations.map((r) => r.cfr)).toContain('16 CFR 1236 / 1218 / 1241');
  });

  it('carries the five codes the January 2026 list wraps onto a second line (M13)', () => {
    expect(findCpscListCategory('6402.91.40.63')).toBe('Shoes');
    expect(findCpscListCategory('8506.80.00.10')).toBe('Button Cell & Coin Batteries');
    expect(findCpscListCategory('9401.80.20.01')).toBe('Child Chairs');
    expect(findCpscListCategory('9404.29.90.95')).toBe('Mattresses');
    expect(findCpscListCategory('9503.00.00.11')).toBe('Toys');
    expect(CPSC_HTS_LIST.reduce((n, c) => n + c.htsCodes.length, 0)).toBe(591);
  });

  it('does not offer Disclaim B for a near match (B is only for enforcement discretion)', async () => {
    const res = await checkCpscCertificate({ htsCode: '9403.60.80.40', targetAge: 'adult', material: 'wood' });
    expect(res.disclaimerCodeHint ?? '').not.toContain('B');
    expect(res.nextActions.join('')).not.toContain('A または B');
  });

  it('applies 16 CFR 1263 to button cells, notes the § 1263.1(c) toy exemption for children under 14, and leaves other batteries out (M5)', async () => {
    const penlight = await checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'adult', hasBattery: true, batteryType: 'button_coin' });
    expect(penlight.certificateRequired).toBe(true);
    expect(penlight.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(true);
    const teenToy = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge: 'adult', material: 'plastic', hasBattery: true, batteryType: 'button_coin' });
    expect(teenToy.nextActions.join('')).toContain('16 CFR 1263.1(c)');
    expect(teenToy.nextActions.join('')).toContain('14 歳未満');
    const childToy = await checkCpscCertificate({ htsCode: '9503.00.00.73', targetAge: 'child', material: 'plastic', hasBattery: true, batteryType: 'button_coin' });
    expect(childToy.certificateType).toBe('CCC');
    expect(childToy.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(false);
    const zincAir = await checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'adult', hasBattery: true, batteryType: 'other' });
    expect(zincAir.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(false);
  });
});
```

`expectedProps.check_cpsc_certificate` を `['htsCode', 'targetAge', 'material', 'hasBattery', 'batteryType', 'fabricSurface', 'fabricWeightOzPerSqYd']` にする。

Run: `bun test src/services/trade.test.ts src/trade_tracking_watch_params.test.ts`
Expected: FAIL（たんすが Disclaim A、1460 が出る、`findCpscListCategory` が無い、5 件が無い など）

- [ ] **Step 2: 直す。**
  1. `regulatedScope`・`CpscCategoryRegulationEntry`・`toPublicReg`、`children_only` の枝（作業ツリーの「3. 子供専用規制カテゴリ … GCC不要・ACE Disclaim A」）、区分の枝の `catReg?.regulatedScope === 'children_only'` の文を消す。大人の一覧のコードは v4.1 のとおり GCC・eFiling（一覧は「規則の対象になりうる品目」の一覧で、大人用に当てはまる規則が無いかどうかはデータで決まらない。GCC の作成では証明者が `citations: []` で答える。Task 4）。
  2. `CPSC_CATEGORY_REGULATIONS` は v4.1 の 3 件だけにする（作業ツリーで足した 19 件を消す。手書きの対応表を増やさない）。`Clothing` は Task 2 の文、`Toys` は v4.1 の文、`Infant Sleep Products` は作業ツリーで直した `cfr: '16 CFR 1236 / 1218 / 1241'`（v4.1 の 1632/1633 はマットレスの規則で誤り）。消えた区分（`Drywall`・`Other Children’s Furniture` など）は v4.1 の「個別規格要確認」になる（C4・I7）。
  3. `findExactMatch` を包んだ `findCpscListCategory` を export する。
  4. 近いコードの枝: `disclaimerCodeHint` を付けない。`nextActions` の「（Disclaimerコード A または B）」を「（Disclaim A。Disclaimer には Intended Use Code も要ります）」にする（M13。B は執行裁量の品だけ）。
  5. ボタン電池の枝: 注釈の「16 CFR § 1263.1(d)」を「16 CFR § 1263.1(c)」にする。12 歳以下の玩具（一覧の `Toys` に完全一致、`targetAge: 'child'`）は今のとおり除く。`Toys` と同じ 6 桁なだけのコードは玩具と決まらないので除かない（CPC と 16 CFR 1263、下の 1263.1(c) の案内を付ける）。大人で区分が `Toys` のときは、`nextActions` の終わりに「14 歳未満の子供の遊び道具で 16 CFR 1250 の電池の要件に合うものは、16 CFR 1263.1(c) により part 1263 の対象外です（その場合は 16 CFR 1250 を当てます）。」を足す（`Toys` と同じ 6 桁のコードで part 1263 を当てるときも同じ）。区分の規則を足す条件から `regulatedScope` を外す（`CPSC_CATEGORY_REGULATIONS[exactCategory]` があれば足す）。第61・62類で (c) の見出しでないコードは、一覧に無くても `Clothing` の項目を足す（一覧に載っているかどうかで 16 CFR 1610 の要求が変わらないように）。
  5a. 大人（`targetAge: 'adult'`）の `Toys` の完全一致: `applicableRegulations` の区分の行は「個別規格要確認」にし（ASTM F963 は 14 歳未満、16 CFR 1501 は 3 歳未満の規則なので、大人に「当たる」と書かない）、`nextActions` に「CPSC の一覧の玩具のコードです。ASTM F963（16 CFR 1250）は 14 歳未満の遊び道具、16 CFR 1501 は 3 歳未満向けの品の規則です。対象の年齢に合わせて、当たる規則を確かめてください。」を足す。GCC・eFiling の答えは変えない。
  5b. 一覧に無いコード（大人・不明）の `disclaimerCodeHint` を `A (only if confirmed that no CPSC rule applies; Intended Use Code required)` にする（「Not Regulated」と言い切らない）。
  5c. 子供（`targetAge: 'child'`）で一覧の近いコード（同じ 6 桁）: 一覧に無いコードの子供の答え（CPC）と同じにし、近いコードの案内は残す（`unknown` と Disclaim A の案内にしない）。
  6. `src/services/cpsc_hts_data.ts`: 2026 年 1 月の PDF で行の折り返しのため抜けた 5 件を、それぞれの区分の終わりに足す（`Button Cell & Coin Batteries` に `8506800010`、`Child Chairs` に `9401802001`、`Mattresses` に `9404299095`、`Shoes` に `6402914063`、`Toys` に `9503000011`）。先頭の注釈に「2026-11-08: PDF の行の折り返しで抜けていた 5 件を足した（計 591 件）」を足す。
  7. スキーマ: `check_cpsc_certificate` の MCP に `hasBattery`・`batteryType` を足す（REST は Task 0 で入っている）。describe は `hasBattery`: `電池を使う製品か。true で batteryType が button_coin なら 16 CFR 1263 を当てる。不明なら省略`、`batteryType`（3 つのツールの REST・MCP）: v4.1 の文の「other: リチウムイオン電池等その他の電池）」を「other: リチウムイオン電池・空気亜鉛電池（16 CFR 1263.1(d) で対象外）など）」にする。
  8. README: `check_cpsc_certificate` の行に 2 つの引数、`disclaimerCodeHint` の説明を「A（規則の対象外と確かめた品）、B（16 CFR 1610.1(d) の免除の大人の衣料。Intended Use Code 130.006）」にする。
- [ ] **Step 3: 通ることを確かめる。** Step 1 の命令が PASS。`bun test src/services/trade.test.ts src/index.test.ts src/llm_contract_sync.test.ts`。`rg -n 'regulatedScope|children_only|1460' src` が 0 件。`bun run gen:client`。`bun scripts/measure-context.ts` で全ツールの `tools/list` が 65,000 字以下（Task 2 の後は 64,977 字）。超えるなら `generate_gcc_certificate` のツール単位の説明（Task 4 で書き直す）を短くして収める。上限は上げない。
- [ ] **Step 4: コミット。** `fix(trade): drop the CPSC age table, fix the drywall and toy citations, and add the five wrapped list codes`

### Task 4: GCC の作り直し — 入力・判定・完全さ・ID・応答

**対象:** `src/services/gcc.ts`（新）・`src/services/gcc_html.ts`（新）・`src/services/gcc.test.ts`（新）、`src/services/trade.ts`（GCC の部分を移して消す）、`src/scraper.ts`、`src/types.ts`、`src/routes/trade.ts`、`src/mcp/tools_trade.ts`、`src/index.test.ts`、`src/response_schema_contract.test.ts`、`src/context_budget.test.ts`。

直す指摘: C1（今の 16 CFR 1110.11(a) の要素の完全さ）、C2（リストに無い大人の品を Disclaim A にする）、C3（GCC の側）、I2（証明者を項目ごとに混ぜる）、I3（名前・番号は明示の値だけ）、I4（応答の形）、I5（品ごとの判例・scrape をやめ、`htsCode` を必須に）、I6（Markdown を出さない）、I8（1 つの形、`items` だけ）、M1（ID）、M2 の一部（サーバーの値に確かめを当てない）、I10 の一部（古い規則を固めるテスト、当事者、50 件の上限）。

まず GCC の部分を、振る舞いを変えずに 2 つの新しいファイルへ移してコミットし（`refactor(trade): move GCC generation into its own module`）、そのあとで作り直す。

**Interfaces:**
- Consumes: `checkCpscCertificate(options: CpscCertificateCheckOptions)`・`findCpscListCategory`・`section1610cExclusionFor`・`checkFdaRegulated`・`TradeInputError`（`src/services/trade.ts`）。
- Produces（`src/services/gcc.ts`）:

```ts
export type GccIdentifierType = 'sku' | 'model' | 'gtin' | 'upc' | 'serial' | 'registered' | 'other';
export interface GccParty { name?: string; street?: string; city?: string; state?: string; country?: string; email?: string; phone?: string }
export interface GccItemInput {
  htsCode: string;
  productName: string;
  identifier?: string;
  identifierType?: GccIdentifierType;
  brand?: string;
  description?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  material?: string;
  fabricSurface?: 'plain' | 'raised';
  fabricWeightOzPerSqYd?: number;
  hasBattery?: boolean;
  batteryType?: 'button_coin' | 'other';
  foodContact?: boolean;
  citations?: string[];
  manufacture?: GccParty & { date?: string };
  testing?: { date?: string; reportNumber?: string; parties?: GccParty[] };
}
export interface GenerateGccCertificateOptions {
  items: GccItemInput[];
  certifier?: GccParty;
  recordCustodian?: GccParty;
  orderNumber?: string;
  awbNumber?: string;
  carrier?: string;
  invoiceNumber?: string;
  allowDraft?: boolean;
}
export type GccItemStatus = 'generated' | 'draft_needs_info' | 'exempt_disclaim_b' | 'exempt_no_gcc_needed' | 'cpc_required_instead';
export interface GccItemSummary {
  line: number;                      // 1 始まり
  status: GccItemStatus;
  htsCode: string;
  productName: string;
  identifier?: string;
  certificateId?: string;            // status が generated のときだけ
  cpscListCategory?: string;         // CPSC の一覧の完全一致の区分
  citations?: string[];              // GCC のとき
  testingExclusions?: string[];      // 例 ['16 CFR 1610.1(d)(2)']
  disclaimCode?: 'A' | 'B';
  intendedUseCode?: string;          // B のとき '130.006'
  filingNote: string;
  fdaNote?: string;                  // Task 6
  missingFields?: string[];
  clarifyingQuestions?: string[];
  warnings?: string[];
}
export interface GenerateGccCertificateResult {
  packageId: string;
  generatedAt: string;               // ISO 8601（UTC）
  mode: 'single_product' | 'order_package';
  overallStatus: 'ready' | 'exempt' | 'partial_or_draft' | 'cpc_required';
  counts: { totalItems: number; gccGenerated: number; draftNeedsInfo: number; disclaimBExempt: number; noGccNeeded: number; cpcRequired: number };
  missingFields?: string[];          // certifier.* と recordCustodian.*（GCC の品があるときだけ）
  items: GccItemSummary[];
  packageHtml: string;
  disclaimer: string;
}
export class TradeGccIncompleteError extends Error {
  readonly code = 'MISSING_REQUIRED_GCC_FIELDS';
  constructor(message: string, readonly details: { missingFields: string[]; items: Array<Pick<GccItemSummary, 'line' | 'htsCode' | 'productName' | 'identifier' | 'missingFields' | 'clarifyingQuestions'>> });
}
export async function generateGccCertificate(options: GenerateGccCertificateOptions): Promise<GenerateGccCertificateResult>;
```

- Produces（`src/services/gcc_html.ts`。中身は Task 5・6 で今の規則の形にする）:

```ts
export interface GccRenderItem {
  summary: GccItemSummary;
  input: GccItemInput;                                   // 前後の空白を除いた呼び出し側の値
  exemption?: { citation: '16 CFR 1610.1(d)(1)' | '16 CFR 1610.1(d)(2)'; basis: string };  // Disclaim B
  exclusion1610c?: { citation: string; text: string };   // Disclaim A の根拠（(c) の見出しのとき）
}
export interface GccRenderInput {
  packageId: string;
  generatedAt: string;
  mode: 'single_product' | 'order_package';
  order: { orderNumber?: string; awbNumber?: string; carrier?: string; invoiceNumber?: string };
  certifier?: GccParty;
  recordCustodian?: GccParty;
  items: GccRenderItem[];
}
export function renderGccPackageHtml(input: GccRenderInput): string;
export function escapeHtml(value: unknown): string;
```

- [ ] **Step 1: 移す（振る舞いを変えない）。** `src/services/trade.ts` の「5. 米国CPSC 一般適合証明書」の節（`GccPartyContact` から `generateGccCertificate` まで、`TradeGccIncompleteError`・`GccIncompleteItemSummary`・`DISCLAIMER_GCC`）を `src/services/gcc.ts` へ、HTML の関数（`escapeHtml`・`renderGccSectionHtml`・`wrapStandalonePrintHtml`・`buildOrderCoverSheet`）を `src/services/gcc_html.ts` へ移す。`src/scraper.ts` に `export * from './services/gcc.js';` を足す。GCC のテストを `src/services/trade.test.ts` から `src/services/gcc.test.ts` へ移す（外の API の偽物の入れ方は trade.test.ts と同じ）。`bun test src/services/gcc.test.ts src/services/trade.test.ts src/index.test.ts` と `bun run typecheck` が通ったらコミット。
- [ ] **Step 2: 失敗するテストを書く**（`src/services/gcc.test.ts`。移したテストは消し、次に置き換える。作業ツリーの `generates a complete 7-element 16 CFR 1110.11 GCC …`（古い規則を固めていた。I10）もここで消える）。

```ts
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { GenerateGccCertificateRequestSchema } from '../types.js';
import { type GccItemInput, TradeGccIncompleteError, generateGccCertificate } from './gcc.js';

// サーバーの既定（SORA_GCC_*）が手元の環境にあっても、テストは呼び出し側の値だけで始める
const savedEnv = { certifier: process.env.SORA_GCC_CERTIFIER, custodian: process.env.SORA_GCC_CUSTODIAN };
beforeEach(() => {
  delete process.env.SORA_GCC_CERTIFIER;
  delete process.env.SORA_GCC_CUSTODIAN;
});
afterAll(() => {
  for (const [key, value] of [['SORA_GCC_CERTIFIER', savedEnv.certifier], ['SORA_GCC_CUSTODIAN', savedEnv.custodian]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CERTIFIER = { name: 'Acme Imports LLC', street: '100 Example Street', city: 'Anytown', state: 'CA', country: 'United States', email: 'compliance@acme-imports.test', phone: '+1-202-555-0101' };
const CUSTODIAN = { ...CERTIFIER, name: 'Compliance Manager', email: 'records@acme-imports.test', phone: '+1-202-555-0102' };
const FACTORY = { date: '2026-06', name: 'Acme Helmet Factory', street: '1 Example Road', city: 'Taichung', state: 'Taichung City', country: 'Taiwan', email: 'factory@acme-factory.test', phone: '+1-202-555-0103' };
const LAB = { name: 'Acme Test Lab', street: '2 Example Road', city: 'Taipei', state: 'Taipei City', country: 'Taiwan', email: 'lab@acme-lab.test', phone: '+1-202-555-0104' };
const HELMET: GccItemInput = { htsCode: '6506.10.60.45', productName: 'Adult Bicycle Helmet', identifier: 'HLM-001', targetAge: 'adult', citations: ['16 CFR 1203'], manufacture: FACTORY, testing: { date: '2026-06-15', reportNumber: 'TR-0001', parties: [LAB] } };
const TEE: GccItemInput = { htsCode: '6109.90.10.07', productName: 'Adult Polyester T-Shirt', identifier: 'TEE-001', targetAge: 'adult', material: '100% polyester' };

describe('generateGccCertificate', () => {
  it('makes a GCC with the elements of the current 16 CFR 1110.11 when every record is given', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(res.overallStatus).toBe('ready');
    expect(res.mode).toBe('single_product');
    expect(res.items[0]).toMatchObject({ line: 1, status: 'generated', htsCode: '6506.10.60.45', identifier: 'HLM-001', citations: ['16 CFR 1203'] });
    expect(res.items[0].missingFields).toBeUndefined();
    expect(res.items[0].certificateId).toMatch(/^GCC-[0-9A-F]{12}$/);
    expect(res.packageId).toMatch(/^PKG-[0-9A-F]{12}$/);
    expect(res.missingFields).toBeUndefined();
  });

  it('keeps a GCC a draft without the unique identifier and the full contact details (review probe for C1)', async () => {
    const item: GccItemInput = { htsCode: '6506.10.60.45', productName: 'Adult Bicycle Helmet', targetAge: 'adult', citations: ['16 CFR 1203'], manufacture: { date: '2026-06', city: 'Taichung', country: 'Taiwan' }, testing: { date: '2026-06-15', parties: [{ name: 'Acme Test Lab' }] } };
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [item], allowDraft: true });
    expect(res.items[0].status).toBe('draft_needs_info');
    expect(res.items[0].missingFields).toEqual([
      'identifier', 'manufacture.name', 'manufacture.street', 'manufacture.state', 'manufacture.email', 'manufacture.phone',
      'testing.parties[0].street', 'testing.parties[0].city', 'testing.parties[0].state', 'testing.parties[0].country', 'testing.parties[0].email', 'testing.parties[0].phone',
    ]);
    expect(res.items[0].certificateId).toBeUndefined();
    await expect(generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [item] })).rejects.toBeInstanceOf(TradeGccIncompleteError);
  });

  it('does not call an unlisted adult item "no GCC needed" until the certifier says no rule applies (review probe for C2)', async () => {
    const gas: GccItemInput = { htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult' };
    const asked = await generateGccCertificate({ items: [gas], allowDraft: true });
    expect(asked.items[0].status).toBe('draft_needs_info');
    expect(asked.items[0].missingFields).toContain('citations');
    const none = await generateGccCertificate({ items: [{ ...gas, citations: [] }] });
    expect(none.items[0].status).toBe('exempt_no_gcc_needed');
    expect(none.items[0].disclaimCode).toBeUndefined();
    expect(none.items[0].filingNote).toContain('CPSC の一覧に無い');
  });

  it('does not give Disclaim A to an adult dresser on a children’s furniture code (review probe for C3)', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult' };
    expect((await generateGccCertificate({ items: [dresser], allowDraft: true })).items[0].status).toBe('draft_needs_info');
    const stated = await generateGccCertificate({ items: [{ ...dresser, citations: [] }] });
    expect(stated.items[0]).toMatchObject({ status: 'exempt_no_gcc_needed', disclaimCode: 'A', cpscListCategory: 'Other Children’s Furniture' });
    expect(stated.items[0].warnings?.[0]).toContain('Other Children’s Furniture');
  });

  it('gives Disclaim B with IUC 130.006 to adult apparel exempt under 16 CFR 1610.1(d) without the certifier', async () => {
    const res = await generateGccCertificate({ items: [TEE] });
    expect(res.items[0]).toMatchObject({ status: 'exempt_disclaim_b', disclaimCode: 'B', intendedUseCode: '130.006' });
    expect(res.overallStatus).toBe('exempt');
    expect(res.missingFields).toBeUndefined();
  });

  it('identifies the 16 CFR 1610.1(d) testing exclusion in a GCC instead of a test record (16 CFR 1110.11(c))', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...TEE, citations: ['16 CFR 1610'], manufacture: FACTORY }] });
    expect(res.items[0]).toMatchObject({ status: 'generated', testingExclusions: ['16 CFR 1610.1(d)(2)'] });
  });

  it('keeps a button-cell product a draft until 16 CFR 1263 is among the citations', async () => {
    const penlight: GccItemInput = { htsCode: '8513.10.20.00', productName: 'LED Penlight', identifier: 'PEN-001', targetAge: 'adult', hasBattery: true, batteryType: 'button_coin', manufacture: FACTORY, testing: { date: '2026-06-15', parties: [LAB] } };
    const wrong = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...penlight, citations: ['16 CFR 1203'] }] });
    expect(wrong.items[0].status).toBe('draft_needs_info');
    expect(wrong.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1263');
    const right = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...penlight, citations: ['16 CFR 1263'] }] });
    expect(right.items[0].status).toBe('generated');
  });

  it('does not make a GCC for children’s products and asks for the age when it is missing', async () => {
    const child = await generateGccCertificate({ items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' }] });
    expect(child.items[0].status).toBe('cpc_required_instead');
    expect(child.overallStatus).toBe('cpc_required');
    const noAge = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1' }] });
    expect(noAge.items[0].missingFields).toContain('targetAge');
  });

  it('takes each party whole from one source and never mixes the caller’s and the server’s values (review probe for I2)', async () => {
    const prev = process.env.SORA_GCC_CERTIFIER;
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, name: 'Server Default LLC', email: 'ops@server-default.test' });
    try {
      const mixed = await generateGccCertificate({ certifier: { name: 'Caller Brand Inc.' }, recordCustodian: CUSTODIAN, items: [HELMET], allowDraft: true });
      expect(mixed.missingFields).toEqual(['certifier.street', 'certifier.city', 'certifier.state', 'certifier.country', 'certifier.email', 'certifier.phone']);
      expect(mixed.packageHtml).not.toContain('ops@server-default.test');
      const fromEnv = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] });
      expect(fromEnv.items[0].status).toBe('generated');
      expect(fromEnv.packageHtml).toContain('ops@server-default.test');
      process.env.SORA_GCC_CERTIFIER = '{not json';
      await expect(generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] })).rejects.toThrow('SORA_GCC_CERTIFIER');
    } finally {
      if (prev === undefined) delete process.env.SORA_GCC_CERTIFIER;
      else process.env.SORA_GCC_CERTIFIER = prev;
    }
  });

  it('rejects an HTS code that is not 10 digits, no items and more than 50 items (I5, I10)', async () => {
    await expect(generateGccCertificate({ items: [{ ...HELMET, htsCode: '6506.10' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(GenerateGccCertificateRequestSchema.safeParse({}).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: Array.from({ length: 51 }, () => HELMET) }).success).toBe(false);
  });

  it('gives stable IDs without a date, different for different products (M1)', async () => {
    const a1 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const a2 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(a2.packageId).toBe(a1.packageId);
    expect(a2.items[0].certificateId).toBe(a1.items[0].certificateId);
    const t1 = await generateGccCertificate({ items: [{ htsCode: '6109.90.10.07', productName: 'Adult Polyester T-Shirt', targetAge: 'adult', material: '100% polyester' }] });
    const t2 = await generateGccCertificate({ items: [{ htsCode: '6201.40.40.21', productName: 'Adult Nylon Jacket', targetAge: 'adult', material: '100% nylon' }] });
    expect(t1.packageId).not.toBe(t2.packageId);
  });

  it('returns a small summary and the HTML only: no Markdown and no per-item compliance result (I4, I6)', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1001', items: [HELMET, TEE] });
    expect(res.mode).toBe('order_package');
    expect(Object.keys(res).sort()).toEqual(['counts', 'disclaimer', 'generatedAt', 'items', 'mode', 'overallStatus', 'packageHtml', 'packageId']);
    for (const item of res.items) for (const k of ['compliance', 'certificateMarkdown', 'certificateHtml', 'statutoryFields', 'aceFilingGuidance']) expect(item).not.toHaveProperty(k);
  });
});
```

`src/index.test.ts` の GCC の REST のテストを次に置き換える: `{}` は 400 `INVALID_INPUT`。`{ items: [{ ...HELMET, identifier: undefined }] }`（証明者なし）は 422 `MISSING_REQUIRED_GCC_FIELDS` で、`details.items[0].missingFields` に `identifier`、`details.missingFields` に `certifier.name`。`{ certifier, recordCustodian, orderNumber: 'ORDER-1001', items: [HELMET, TEE] }` は 200 で `GenerateGccCertificateResultSchema.safeParse` が通る（テストの値は架空のもの）。`src/response_schema_contract.test.ts` の `GCC generate` の本文を `{ items: [TEE の値] }` にする。

Run: `bun test src/services/gcc.test.ts src/index.test.ts -t 'GCC|gcc'`
Expected: FAIL

- [ ] **Step 3: スキーマを書く**（`src/types.ts`。作業ツリーの `TradeFabricFieldsShape` を使う GCC の入力のスキーマ・`Bare*`・`GccPartyContactInputSchema`・`GccManufactureInfoSchema`・`GccTestingRecordSchema`・`GccOrderItemInputSchema`・`GccOrderItemFieldsShape`、応答の `GccStatutoryFieldsSchema`・`GccAceFilingGuidanceSchema`・`GccCertificateItemResultSchema` を消し、次にする。REST と MCP はこの 1 つを使う）。

```ts
const GccPartyShape = {
  name: z.string().optional(), street: z.string().optional(), city: z.string().optional(),
  state: z.string().optional(), country: z.string().optional(), email: z.string().optional(), phone: z.string().optional(),
};
export const GccPartySchema = z.object(GccPartyShape);
export const GccItemInputSchema = z.object({
  htsCode: z.string().min(1).describe('10 桁の HTS コード（インボイス・通関業者の値。推測しない）'),
  productName: z.string().min(1).describe('英語の一般名（16 CFR 1110.11(a)(1)）'),
  identifier: z.string().optional().describe('製品を特定する番号（SKU・型番・GTIN など。16 CFR 1110.11(a)(1)）'),
  identifierType: z.enum(['sku', 'model', 'gtin', 'upc', 'serial', 'registered', 'other']).optional().describe('identifier の種類（デフォルト: "sku"）').meta({ default: 'sku' }),
  brand: z.string().optional(),
  description: z.string().optional().describe('製品の説明（英語）'),
  targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('child: 12 歳以下（GCC でなく CPC が要る）、adult: 13 歳以上・一般'),
  material: z.string().optional().describe('衣料の繊維の組成（"100% polyester" の形。繊維は一般名）'),
  fabricSurface: z.enum(['plain', 'raised']).optional().describe('衣料の生地の表面（raised: 起毛・フリース・パイル）'),
  fabricWeightOzPerSqYd: z.number().min(0.1).max(100).optional().describe('衣料の生地の重さ（oz/sq yd。g/m² なら 33.906 で割る）'),
  hasBattery: z.boolean().optional(),
  batteryType: z.enum(['button_coin', 'other']).optional().describe('button_coin: ボタン・コイン電池（空気亜鉛電池は other）'),
  foodContact: z.boolean().optional().describe('食品・飲料に触れるか（FDA の案内に使う）'),
  citations: z.array(z.string()).optional().describe('試験報告書の規則を 1 つずつ（例: "16 CFR 1203"）。当てはまる規則が無いと確かめたら []'),
  manufacture: z.object({ date: z.string().optional(), ...GccPartyShape }).optional().describe('製造の年月（YYYY-MM）と工場の名前・住所・メール・電話（16 CFR 1110.11(a)(5)）'),
  testing: z.object({ date: z.string().optional(), reportNumber: z.string().optional(), parties: z.array(GccPartySchema).optional() }).optional()
    .describe('最も新しい試験の日（YYYY-MM-DD）と、試験した者ごとの名前・住所・メール・電話（16 CFR 1110.11(a)(6)）'),
});
export const GenerateGccCertificateRequestSchema = z.object({
  items: z.array(GccItemInputSchema).min(1).max(50).describe('1 件 1 製品（最大 50 件）'),
  certifier: GccPartySchema.optional().describe('証明者（輸入品は輸入者。16 CFR 1110.7）。省くとサーバーの SORA_GCC_CERTIFIER'),
  recordCustodian: GccPartySchema.optional().describe('試験の記録を持つ人（役職でよい。16 CFR 1110.11(a)(4)）。省くと SORA_GCC_CUSTODIAN'),
  orderNumber: z.string().optional(),
  awbNumber: z.string().optional(),
  carrier: z.string().optional(),
  invoiceNumber: z.string().optional(),
  allowDraft: z.boolean().optional().describe('足りない項目があっても下書きを返す（デフォルト: false。false では 422）').meta({ default: false }),
});
```

応答の `GenerateGccCertificateResultSchema` を `GenerateGccCertificateResult` と同じ項目で書き直す（`GccItemSummarySchema` を足す。説明は短く）。OpenAPI の `/trade/gcc-generate` の 422 の説明は Task 9 で直す。

- [ ] **Step 4: 判定を書く**（`src/services/gcc.ts`。作業ツリーの `checkProductCompliance` の呼び出し・`mergePartyContacts`・`resolveEnvGccPartyDefaults`・`normalizeParty`・`extractCitationList`・Markdown の組み立てを消す）。各品の判定は次の順（コードはこの形を守る）:

```ts
const PARTY_FIELDS = ['name', 'street', 'city', 'state', 'country', 'email', 'phone'] as const;
const htsDigits = (code: string) => code.replace(/\D/g, '');
const cfrPart = (citation: string) => citation.match(/16\s*CFR\s*(?:Part\s*|§\s*)?(\d{3,4})/i)?.[1];

// 1. htsDigits(item.htsCode).length !== 10 → throw new TradeInputError(`items[${i}].htsCode は 10 桁の HTS コードにしてください`, 'INVALID_INPUT')
// 2. cpsc = await checkCpscCertificate({ htsCode, targetAge: item.targetAge ?? 'unknown', material, hasBattery, batteryType, fabricSurface, fabricWeightOzPerSqYd })
//    category = findCpscListCategory(htsCode); cEx = section1610cExclusionFor(htsCode)
// 3. targetAge === 'child' または cpsc.certificateType === 'CCC' → cpc_required_instead（何も求めない）
// 4. targetAge が無い・'unknown' → draft_needs_info、missingFields ['targetAge']、質問 Q_AGE（ここで止める）
// 5. required: cpsc.applicableRegulations に '16 CFR 1263' で始まる cfr があれば '1263'。'16 CFR 1610' で始まる cfr があり cEx が無ければ '1610'
// 6. citations が undefined:
//      cpsc.certificateRequired === false かつ cpsc.testingExemption?.enforcementDiscretion → exempt_disclaim_b（B・'130.006'）
//      ほか → GCC の道で、missingFields に 'citations' と、cpsc.missingInputs のうち material・fabricSurface・fabricWeightOzPerSqYd。
//             質問は Q_CITATIONS と cpsc.clarifyingQuestions。試験の記録は要るものとして 9 の完全さを続ける
// 7. citations が []:
//      required が空でない → draft_needs_info、missingFields ['citations']、質問 Q_REQUIRED
//      ほか → exempt_no_gcc_needed。category があれば disclaimCode 'A' と warnings [W_LISTED]。cEx があれば exclusion1610c に入れる
// 8. citations が空でない → GCC の道:
//      required のうち、citations の cfrPart に無いもの（区分が Toys のときの '1263' は '1250' でもよい）→ missingFields 'citations'、質問 Q_REQUIRED
//      testingExclusions = cpsc.testingExemption?.exempt かつ citation が '16 CFR 1610.1(d)' で始まり、citations に part 1610 がある → [その citation]
//      試験の記録が要る = citations のうち、part が 1610 で testingExclusions があるもの以外が 1 つでもある
// 9. GCC の道の完全さ（この順で missingFields に入れる）: identifier → manufacture.date → manufacture.<PARTY_FIELDS> →
//      （試験の記録が要るとき）testing.date → testing.parties（0 件のとき）→ testing.parties[j].<PARTY_FIELDS>
//    証明者・記録の担当の <PARTY_FIELDS> の欠けは、品ではなく応答の missingFields（'certifier.name' など）に入れる
// 10. status: GCC の道は、品の missingFields と応答の missingFields がどちらも空なら generated、ほかは draft_needs_info
```

  - 文（日本語。そのまま使う）:
    - `Q_AGE`: `この製品は 12 歳以下の子供向けですか？子供向けなら GCC ではなく CPC（16 CFR 1107）が要ります。`
    - `Q_CITATIONS`: `この製品に当てはまる CPSC の規則を、試験報告書のとおり citations に 1 つずつ入れてください（例: "16 CFR 1203"）。当てはまる規則が無いと確かめたら citations: [] にします（CPSC の一覧のコードなら Disclaim A）。` に、required があれば ` Sora は ${'16 CFR ' + p を「・」でつないだもの} が当てはまると判断しています。`、cpsc の `applicableRegulations` に一覧の項目と「個別規格要確認」以外の cfr があれば ` 参考: ${cfr を「・」でつないだもの}。`、cEx があれば ` ${cEx.citation} の条件（${cEx.text}）に当たるなら 16 CFR 1610 は当てはまりません。` を続ける。
    - `Q_REQUIRED`: `citations に ${足りない規則を「・」でつないだもの} がありません。試験報告書で確かめて citations に足してください（ボタン・コイン電池は 16 CFR 1263、衣料は 16 CFR 1610）。`
    - `W_LISTED`: `HTS ${htsCode} は CPSC の一覧（${category}）にあり、規則の対象になりうる品目です。当てはまる規則が無いことを確かめてから Disclaim A を送ってください。`
    - `filingNote`: generated は `ACE の CPSC の PGA Message Set で GCC のデータを送ります（Full PGA Message Set か Product Registry の参照。16 CFR 1110.13(a)(1)）。郵便（EMS など）で送る品は、着く前に Product Registry に入れます。`、draft は `下書きです。missingFields を記録から埋めるまで ACE に送らないでください。`、exempt_disclaim_b は `ACE で Disclaim B と Intended Use Code 130.006 を送ります（16 CFR 1610.1(d) の免除の大人の衣料。81 FR 12587）。`、exempt_no_gcc_needed で一覧にあるときは `ACE で Disclaim A を送れます（任意）。Disclaimer には Intended Use Code が要ります（CBP の Appendix R から選ぶ。例 130.XXX）。`、一覧に無いときは `CPSC の一覧に無い HTS コードで、証明者は当てはまる規則が無いとしています。CPSC のデータは送りません（規則が当てはまるなら GCC が要ります）。`、cpc_required_instead は `12 歳以下の子供用なので CPC が要ります（このツールは CPC を作りません）。`
  - 当事者（I2）: 証明者は、呼び出し側の `certifier` に空でない項目が 1 つでもあればそれを丸ごと、無ければ `SORA_GCC_CERTIFIER` を `JSON.parse` して `GccPartySchema` で読んだものを丸ごと、どちらも無ければ無し。記録の担当も同じく `recordCustodian` と `SORA_GCC_CUSTODIAN`。環境変数は呼ばれたときに読む（起動のときに読まない）。JSON として読めない・オブジェクトでないときは `new Error('SORA_GCC_CERTIFIER を読めません（JSON のオブジェクトで name・street・city・state・country・email・phone）')`（REST は 500 `TRADE_ERROR`）。証明者・記録の担当の欠けは、GCC の道の品が 1 つでもあるときだけ応答の `missingFields` に入れる。
  - 見本の値の確かめ（作業ツリーの `assertNoPlaceholderGccFields`）は、項目の名前を新しい形にし、呼び出し側の値（`options.items[*]`・`options.certifier`・`options.recordCustodian`）だけに当てる。サーバーの環境変数の値には当てない（M2 の一部。規則は Task 7）。
  - ID（M1）: `createHash('sha256')`（`node:crypto`）の 16 進の先頭 12 桁を大文字にする。`certificateId` は generated の品だけで、`'GCC-' + hash(JSON.stringify([htsDigits, productName, identifierType ?? 'sku', identifier, brand ?? '', description ?? '', citations, testingExclusions, 証明者, 記録の担当, manufacture, testing]))`（値は前後の空白を除いたもの。並びを変えない）。`packageId` は `'PKG-' + hash(JSON.stringify([品ごとに certificateId か `${status}:${htsDigits}:${productName}:${identifier ?? ''}`, orderNumber ?? '', awbNumber ?? '', carrier ?? '', invoiceNumber ?? '']))`。日付は ID に入れない（`generatedAt` は今までどおり UTC の ISO 8601）。
  - `mode` は、品が 2 件以上か注文の情報が 1 つでもあれば `order_package`、ほかは `single_product`。`overallStatus` は、cpcRequired > 0 なら `cpc_required`、draftNeedsInfo > 0 なら `partial_or_draft`、gccGenerated > 0 なら `ready`、ほかは `exempt`。
  - `allowDraft` が true でなく、draft の品が 1 つでもあれば `TradeGccIncompleteError`（`message`: `GCC に必要な記録が足りません（${品と応答の missingFields の和}）。記録の値を渡してください。下書きを見るには allowDraft: true。`、`details`: `{ missingFields: 応答の missingFields, items: draft の品の line・htsCode・productName・identifier・missingFields・clarifyingQuestions }`）。
  - `disclaimer`: `参考の出力で、法的助言ではありません。証明書の中身は証明者（輸入者など）の責任です（16 CFR 1110.15）。偽りの証明書は CPSA 第19条の違反になります。`
  - HTML: `renderGccPackageHtml` に渡す。この Task では、作業ツリーの HTML の関数を新しい入力の形に合わせるだけ（当事者は `name` / `street` / `city, state` / `country` / `Email` / `Phone` の行に分ける。見出しの文は Task 5・6 で直す）。品ごとの `certificateHtml` と、注文のときの品ごとの重複は作らない（`packageHtml` の 1 つだけ）。
- [ ] **Step 5: REST と MCP をつなぐ。** `src/routes/trade.ts` の 422 は `formatError(c, err.message, err.code, 422, false, err.details)`。MCP の `generate_gcc_certificate` は `GenerateGccCertificateRequestSchema.shape` で登録する（ツール単位の説明・エラーの形・キーワードは Task 9。ただし説明の「返却: { … }」は今ここで `{ packageId, overallStatus, counts, items, packageHtml }` にする。`scripts/schema-notation/repository.test.ts` が応答のスキーマと照らす）。README の §3.22b の例も新しい形にする: 要求（curl の本文）は `items` だけ・当事者の形・`citations`、応答（```json）は新しい応答のキーだけ（`packageId`・`generatedAt`・`mode`・`overallStatus`・`counts`・`items`・`packageHtml`・`disclaimer`。値は Task 10 で実際の出力にする。同じテストが README の例のキーを照らす）。`src/context_budget.test.ts` の `allToolsListChars` を `64_000` に戻す（Task 0 で上げた分。新しい形の定義は 3,600 字以下の見込み。超えたら describe を短くして収める）。
- [ ] **Step 6: 通ることを確かめる。**

```bash
bun test src/services/gcc.test.ts src/services/trade.test.ts src/index.test.ts src/response_schema_contract.test.ts src/context_budget.test.ts src/llm_contract_sync.test.ts src/client_sync.test.ts scripts/schema-notation/repository.test.ts   # client は gen:client のあと
bun run typecheck && bun run lint
bun scripts/measure-context.ts   # 全ツール 64,000 以下
```

`rg -n 'Markdown|checkProductCompliance' src/services/gcc.ts src/services/gcc_html.ts` が 0 件。

- [ ] **Step 7: コミット。** `fix(trade): rebuild GCC generation on explicit records and the current 16 CFR 1110.11 elements`

### Task 5: 証明書の中身を今の 16 CFR 1110.11 にする（表示・証明の文・試験の除外）

**対象:** `src/services/gcc_html.ts`、`src/services/gcc.test.ts`。

直す指摘: C1（(a)(1)〜(7) の表示、(a)(7) の証明の文、(c) の試験の除外の表示、見出しの番号）、M6（「foreign direct-to-consumer certifier」は 16 CFR 1110 の語ではない）。

**Interfaces:**
- Consumes: `GccRenderInput`・`GccRenderItem`・`GccItemSummary`（Task 4）。
- Produces: `export const GCC_ATTESTATION: string`（`src/services/gcc_html.ts`）。

- [ ] **Step 1: 失敗するテストを書く。**

```ts
// import に足す: GCC_ATTESTATION（'./gcc_html.js'）。CERTIFIER・CUSTODIAN・FACTORY・HELMET・TEE は Task 4 でこのファイルの先頭に置いた値
describe('GCC document (16 CFR 1110.11)', () => {
  it('prints every element of 16 CFR 1110.11(a) and the attestation word for word', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const html = res.packageHtml;
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(html).toContain(`16 CFR 1110.11(a)(${n})`);
    expect(html).toContain(GCC_ATTESTATION);
    expect(html).toContain('SKU: HLM-001');
    expect(html).toContain('<li>16 CFR 1203</li>');
    for (const v of ['100 Example Street', 'Anytown, CA', 'compliance@acme-imports.test', '+1-202-555-0104', 'Acme Helmet Factory', 'Date of manufacture: 2026-06', 'Most recent test: 2026-06-15', res.items[0].certificateId!]) expect(html).toContain(v);
    expect(html).toContain('the importer for imported products');
    expect(html).not.toContain('direct-to-consumer');
  });

  it('marks a draft as not valid and shows each missing element', async () => {
    const res = await generateGccCertificate({ allowDraft: true, items: [{ ...HELMET, identifier: undefined }] });
    expect(res.packageHtml).toContain('DRAFT');
    expect(res.packageHtml).toContain('[MISSING: identifier]');
    expect(res.packageHtml).toContain('[MISSING: certifier.name]');
    expect(res.packageHtml).not.toContain('GCC READY');
  });

  it('identifies the testing exclusion in place of the test date and place (16 CFR 1110.11(c))', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...TEE, citations: ['16 CFR 1610'], manufacture: FACTORY }] });
    expect(res.packageHtml).toContain('Testing exclusion for 16 CFR 1610: 16 CFR 1610.1(d)(2)');
    expect(res.packageHtml).toContain('in lieu of the test date and place (16 CFR 1110.11(c))');
  });
});
```

Run: `bun test src/services/gcc.test.ts -t 'GCC document'`
Expected: FAIL（古い見出し、証明の文が無い）

- [ ] **Step 2: 直す。** GCC の節（generated と draft）を次の形にする（英語。16 CFR 1110.9(a)）。値はすべて `escapeHtml` を通す。
  - 題: generated は `General Certificate of Conformity`、draft は `DRAFT General Certificate of Conformity — not valid`。その下の行: generated は `Certificate ID: ${certificateId} · Generated: ${generatedAt}`、draft は欄の印で示していないキーだけの `Missing: …`（無ければ `Missing elements are marked below.`）。下書きの (a)(7) は `[Not attested: this is a draft]`。丸ごと無い当事者は `[MISSING: certifier]` のように 1 つの印にする。generated の下の行は `Filing: see 16 CFR 1110.13.`。印は generated が `GCC`、draft が `DRAFT — NOT VALID`。
  - 表の 7 行（見出しの文はこのとおり）:
    1. `Product — 16 CFR 1110.11(a)(1)`: productName、`Brand: ${brand}`（あれば）、`${識別の名前}: ${identifier}`（sku → `SKU`、model → `Model number`、gtin → `GTIN`、upc → `UPC`、serial → `Serial number`、registered → `Registered number`、other → `Identifier`）、`HTS: ${htsCode}`、description（あれば）。
    2. `Rules certified — 16 CFR 1110.11(a)(2)`: `<ul>` の中に citations を 1 つずつ `<li>`。
    3. `Certifier (the importer for imported products, 16 CFR 1110.3 and 1110.7) — 16 CFR 1110.11(a)(3)`: 当事者の行（`name` / `street` / `${city}, ${state}` / `country` / `Email: ${email} · Phone: ${phone}`）。
    4. `Records contact — 16 CFR 1110.11(a)(4)`: 当事者の行。
    5. `Manufacture — 16 CFR 1110.11(a)(5)`: `Date of manufacture: ${date}`（YYYY-MM。製造が何日にもわたるときは最初の月）と、工場の当事者の行。
    6. `Testing — 16 CFR 1110.11(a)(6)`: 試験の記録が要るとき `Most recent test: ${date}`、試験した者ごとの当事者の行、`Report: ${reportNumber}`（あれば）。testingExclusions ごとに `Testing exclusion for 16 CFR ${part}: ${exclusion} (identified in lieu of the test date and place (16 CFR 1110.11(c)))`。
    7. `Attestation — 16 CFR 1110.11(a)(7)`: `GCC_ATTESTATION`。
  - 欠けた値は `[MISSING: ${missingFields のキー}]`。
  - `GCC_ATTESTATION`（eCFR の 16 CFR 1110.11(a)(7)、2026-11-05 時点の文をそのまま）:

```ts
/** 16 CFR 1110.11(a)(7) の文（紙・電子の証明書に入れる。eFile のときは Product Registry と CATAIR にある）。eCFR の本文から写した */
export const GCC_ATTESTATION =
  'I hereby certify that the finished product(s) covered by this certificate comply with the rules, bans, standards, and regulations stated herein, and that the information in this certificate is true and accurate to the best of my knowledge, information, and belief. I understand and acknowledge that it is a United States federal crime to knowingly and willfully make any materially false, fictitious, or fraudulent statement, representation, or omission on this certificate.';
```

  - 「法定7項目」「7 statutory elements」「foreign direct-to-consumer」「GCC READY」の語を、コード・テストから消す（`rg -n` で 0 件）。
- [ ] **Step 3: 通ることを確かめる。** `bun test src/services/gcc.test.ts`。
- [ ] **Step 4: コミット。** `fix(trade): print the GCC elements, attestation and testing exclusions of the current 16 CFR 1110.11`

### Task 6: 免除の説明・表紙・CPC の注意・FDA の注記

**対象:** `src/services/gcc_html.ts`、`src/services/gcc.ts`（`fdaNote`）、`src/services/trade.ts`（FDA の FCS の案内の条文の番号）、`src/services/gcc.test.ts`。

直す指摘: C5（2016 年の方針の題と日付）、C6（試験のデータ無しに FDA への適合を書く）、M4（Disclaim A にも Intended Use Code が要る）。

**Interfaces:**
- Consumes: `ADULT_APPAREL_GCC_POLICY`・`SECTION_1610_1_C`・`SECTION_1610_1_D`（Task 2）、`GccRenderItem`（Task 4）、`checkFdaRegulated`。
- Produces: `GccItemSummary.fdaNote`。

- [ ] **Step 1: 失敗するテストを書く。**

```ts
// import に足す: ADULT_APPAREL_GCC_POLICY, SECTION_1610_1_D（'./trade.js'）
describe('exemption statements, cover sheet and FDA note', () => {
  it('writes the Disclaim B statement with the 2016 policy’s exact title, citation and effective date (C5)', async () => {
    const html = (await generateGccCertificate({ items: [TEE] })).packageHtml;
    expect(html).toContain(ADULT_APPAREL_GCC_POLICY.title);
    expect(html).toContain('81 FR 12587');
    expect(html).toContain('March 25, 2016');
    expect(html).not.toContain('April 25, 2016');
    expect(html).not.toContain('March 24, 2016');
    expect(html).toContain(SECTION_1610_1_D['16 CFR 1610.1(d)(2)']);
    expect(html).toContain('Disclaim B with Intended Use Code 130.006');
  });

  it('tells the filer that Disclaim A also needs an Intended Use Code (M4)', async () => {
    const res = await generateGccCertificate({ items: [{ htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] }] });
    expect(res.items[0].filingNote).toContain('Intended Use Code');
    expect(res.packageHtml).toContain('Intended Use Code');
    expect(res.packageHtml).toContain('Appendix R');
  });

  it('does not claim FDA compliance for a mug without test data (review probe for C6)', async () => {
    const res = await generateGccCertificate({ orderNumber: 'ORDER-1002', items: [{ htsCode: '6912.00.44.00', productName: 'Stoneware Coffee Mug', identifier: 'MUG-1', targetAge: 'adult', foodContact: true, citations: [] }] });
    expect(res.items[0].fdaNote).toContain('21 CFR 1.276(b)(5)(i)(A)');
    expect(res.packageHtml).not.toMatch(/compl(?:y|ies) with FDA/i);
  });

  it('puts the order, AWB and every line on the cover sheet and escapes every caller string (XSS)', async () => {
    const xss = `<script>alert("x")</script><img src=x onerror=alert('1')>&"`;
    const res = await generateGccCertificate({ orderNumber: `ORDER-${xss}`, awbNumber: 'TEST-AWB-0001', carrier: 'Courier', certifier: { ...CERTIFIER, name: `Acme ${xss}` }, recordCustodian: CUSTODIAN, items: [{ ...HELMET, productName: `Helmet ${xss}` }, TEE] });
    expect(res.packageHtml).toContain('TEST-AWB-0001');
    expect(res.packageHtml).not.toContain('<script>');
    expect(res.packageHtml).not.toContain('<img src=x');
    expect(res.packageHtml).toContain('&lt;script&gt;');
  });

  it('prints a CPC notice, not a GCC, for children’s products', async () => {
    const html = (await generateGccCertificate({ items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' }] })).packageHtml;
    expect(html).toContain('Children’s Product Certificate');
    expect(html).not.toContain('General Certificate of Conformity');
  });
});
```

Run: `bun test src/services/gcc.test.ts -t 'exemption statements'`
Expected: FAIL（古い日付、IUC の案内が無い、FDA の適合の文がある）

- [ ] **Step 2: 直す。**
  - Disclaim B の説明（exempt_disclaim_b。題 `Statement of Exemption — Adult Wearing Apparel (16 CFR 1610.1(d))`）の行: `Product`（productName・識別・HTS）、`Exemption`（`${citation}: ${SECTION_1610_1_D[citation]}`）、`Basis`（`Fiber content: ${material}` か `Fabric: plain surface, ${oz} oz/sq yd`）、`CPSC policy`（`${title}, ${citation}, effective ${effective}.`）、`ACE`（`CPSC PGA Message Set: Disclaim B with Intended Use Code 130.006 (CPSC eFiling CATAIR Implementation Guide).`）、`Note`（`The product must still meet the flammability requirements of 16 CFR 1610.`）、証明者があれば `Declared by`（当事者の行）。題・掲載・日付は `ADULT_APPAREL_GCC_POLICY` の 1 か所からだけ取る（作業ツリーの「effective April 25, 2016」「March 24, 2016」の文を消す）。
  - Disclaim A（exempt_no_gcc_needed）: 注文のときは表紙の行だけ、1 品のときは題 `Statement — No CPSC Certificate Required` の節。行: `Product`、`Basis`（exclusion1610c があれば `Not subject to 16 CFR 1610 under ${citation}: ${text}. The certifier states that no other CPSC rule requiring a certificate applies.`、無ければ `The certifier states that no CPSC rule, ban, standard, or regulation requiring a certificate applies to this product.`）、`ACE`（一覧にあれば `Disclaim A may be filed. Every disclaimer needs an Intended Use Code (CATAIR, PG01 Note 1): choose it from CBP Appendix R, e.g. 130.XXX For Consumer Use as a Non-Food Product.`、無ければ `The HTS code is not on CPSC’s eFiling list; no CPSC data is filed.`）。
  - CPC の注意（cpc_required_instead。題 `Children’s Product — CPC Required (no GCC issued)`）: `Children’s products (12 years of age or younger) need a Children’s Product Certificate (CPC) under 16 CFR part 1107, based on testing by a CPSC-accepted third party conformity assessment body. This tool does not issue CPCs.`
  - 表紙（order_package）: 題 `Customs Clearance Summary — CPSC (and FDA) PGA`。`Package ID`・`Generated`・`Order #`・`AWB / Tracking #`・`Carrier`・`Invoice #`・`Certifier`（名前）。表の列 `Line | Product | Identifier | HTS | CPSC | Note`。CPSC の列は generated `GCC attached (${certificateId})`、draft `DRAFT — missing: ${missingFields}`、B `Disclaim B, IUC 130.006 (statement attached)`、A（一覧） `Disclaim A — IUC required`、A（一覧に無い） `No CPSC data (HTS code not on CPSC list)`、CPC `HOLD — CPC required`。Note の列は fdaNote。注文のとき、表紙のあとに GCC・draft・B・CPC の節を改ページで続ける（A の節は付けない）。
  - FDA の注記（C6。`checkFdaRegulated({ htsCode, foodContact })` の結果から。英語、JSON の `fdaNote` と表紙で同じ文）: FCS か FD1 で `fdaRegulatedLikely === true` のとき `FDA FD1 (food contact article): no Prior Notice — food contact substances are not food for Prior Notice (21 CFR 1.276(b)(5)(i)(A)). Give the manufacturer’s name and address for the MID on the invoice.`、FD1 で `fdaRegulatedLikely === false` のとき `FDA FD1: not for food contact — file the FDA disclaimer.`、ほかで `fdaRegulatedLikely === true` のとき `FDA ${fdFlag} (${programs})` に、Prior Notice が要れば ` — Prior Notice is required before arrival.`。適合を言う文（`complies with FDA …`）は書かない。
  - レビューの決定（上の文に優先する）: 文書の `<title>` と見出しの規則は書類の種類で変える（GCC は `GCC —` / `DRAFT GCC —` と `16 CFR Part 1110`、Disclaim B は `16 CFR 1610.1(d)`、Disclaim A は `CPSC eFiling`、CPC は `16 CFR Part 1107`。注文の題は表紙と同じ `Customs Clearance Summary — …`）。FDA の注記は呼び出し側のデータが示す範囲だけ書く（`foodContact` が未指定の FCS/FD1 は「food contact use not stated」の文、章からの推定は推定と書く）。表紙では同じ注記を表の下に 1 回だけ出し、行には印を付ける（食器 50 品でも 150,000 字以下）。Disclaim A の Intended Use Code は `130.XXX … (besides 130.001-005)` と書き、`Disclaimer PG01 Note 1` と明記する。Disclaim A にも `Declared by` の行を置く。
  - `src/services/trade.ts` の FDA の FCS の 2 つの案内（`FDA_SUBHEADING_RULES` の `actionNote` と `buildIntegratedActionPlan` の行）の「21 CFR § 1.276(b)(5)」を「21 CFR § 1.276(b)(5)(i)(A)」にする。
  - CSS を 1,500 字以下にする（本文・節・表・印・`@media print` の改ページだけ。節は `page-break-before: always; break-before: page`）。
- [ ] **Step 3: 通ることを確かめる。** `bun test src/services/gcc.test.ts src/services/trade.test.ts`。`rg -n 'April 25, 2016|March 24, 2016|complies with FDA' src` が 0 件。
- [ ] **Step 4: コミット。** `fix(trade): cite the 2016 apparel policy correctly, add the Disclaim A use code and drop the FDA compliance claim`

### Task 7: 見本・仮置きの値と日付の確かめ

**対象:** `src/services/gcc.ts`、`src/services/gcc.test.ts`。

直す指摘: M2（もっともな値を 400 にし、`+1-555-555-5555`・`test@test.com` を通す。サーバーの値にも当てる）、M3（日付の形と未来の日付）。

**Interfaces:**
- Consumes: `GenerateGccCertificateOptions`（Task 4）。
- Produces: `function assertGccInputs(options: GenerateGccCertificateOptions): void`（`generateGccCertificate` の最初、商品ページを読む前に呼ぶ。export しない）。

- [ ] **Step 1: 失敗するテストを書く。**

```ts
// import に足す: type GenerateGccCertificateOptions（'./gcc.js'）
describe('placeholder and date checks (M2, M3)', () => {
  const base = { certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] };

  it('accepts plausible real values that the old patterns rejected (review probes)', async () => {
    for (const name of ['Mockingbird Apparel Ltd', 'Unknown Pleasures Records Inc.', 'Sample & Co. GmbH']) {
      expect((await generateGccCertificate({ ...base, certifier: { ...CERTIFIER, name } })).items[0].status, name).toBe('generated');
    }
    const res = await generateGccCertificate({ ...base, certifier: { ...CERTIFIER, street: 'Approx. 2nd floor, 100 Example Street' }, items: [{ ...HELMET, testing: { ...HELMET.testing, reportNumber: 'TR-2026-0000-0000' } }] });
    expect(res.items[0].status).toBe('generated');
  });

  it('rejects whole-value placeholders, template slots, documentation domains and fake phone numbers', async () => {
    const cases: Array<[string, GenerateGccCertificateOptions]> = [
      ['certifier.name', { ...base, certifier: { ...CERTIFIER, name: 'TBD' } }],
      ['certifier.street', { ...base, certifier: { ...CERTIFIER, street: 'N/A' } }],
      ['certifier.name', { ...base, certifier: { ...CERTIFIER, name: '[MISSING NAME]' } }],
      ['certifier.name', { ...base, certifier: { ...CERTIFIER, name: '{{company}}' } }],
      ['certifier.email', { ...base, certifier: { ...CERTIFIER, email: 'compliance@example.com' } }],
      ['certifier.email', { ...base, certifier: { ...CERTIFIER, email: 'a@b.invalid' } }],
      ['certifier.email', { ...base, certifier: { ...CERTIFIER, email: 'test@test.com' } }],
      ['certifier.phone', { ...base, certifier: { ...CERTIFIER, phone: '+1-555-555-5555' } }],
      ['certifier.phone', { ...base, certifier: { ...CERTIFIER, phone: '000-0000' } }],
      ['items[0].manufacture.name', { ...base, items: [{ ...HELMET, manufacture: { ...FACTORY, name: '未定' } }] }],
      ['items[0].citations[0]', { ...base, items: [{ ...HELMET, citations: ['TBD'] }] }],
    ];
    for (const [field, options] of cases) {
      await expect(generateGccCertificate(options), field).rejects.toMatchObject({ code: 'UNVERIFIED_PLACEHOLDER_INPUT', message: expect.stringContaining(field) });
    }
  });

  it('does not check the server’s SORA_GCC_* values: an operator typo is not the caller’s 400', async () => {
    const prev = process.env.SORA_GCC_CERTIFIER;
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, email: 'ops@example.com' });
    try {
      expect((await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] })).items[0].status).toBe('generated');
    } finally {
      if (prev === undefined) delete process.env.SORA_GCC_CERTIFIER;
      else process.env.SORA_GCC_CERTIFIER = prev;
    }
  });

  it('requires YYYY-MM or YYYY-MM-DD dates that exist and are not in the future (M3)', async () => {
    for (const date of ['2026-13', '2026-02-30', '2026/06', 'June 2026', '2099-01']) {
      await expect(generateGccCertificate({ ...base, items: [{ ...HELMET, manufacture: { ...FACTORY, date } }] }), date).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    for (const date of ['2026-06', '2026-06-15']) {
      expect((await generateGccCertificate({ ...base, items: [{ ...HELMET, testing: { ...HELMET.testing, date } }] })).items[0].status, date).toBe('generated');
    }
  });
});
```

Run: `bun test src/services/gcc.test.ts -t 'placeholder and date'`
Expected: FAIL

- [ ] **Step 2: 直す。** 作業ツリーの `GCC_PLACEHOLDER_PATTERNS`・`isPlaceholderGccValue`・`assertNoPlaceholderGccFields` を消し、`assertGccInputs` にする。確かめるのは呼び出し側の文字列だけ: 品ごとの `productName`・`identifier`・`brand`・`description`・`material`・`citations[k]`・`manufacture.*`・`testing.date`・`testing.reportNumber`・`testing.parties[j].*`、と `certifier.*`・`recordCustodian.*`（注文の番号と環境変数の値は確かめない）。
  1. 値全体が見本の語（前後の空白を除き、大文字小文字を区別しない）: `/^(?:n\/a|none|null|nil|undefined|unknown|tbd|tba|todo|sample|dummy|placeholder|test|example|x+|-+|\?+|\.{2,}|…+)$/i` と `/^(?:未定|不明|未入力|仮|仮置き|仮入力|ダミー|サンプル|なし|無し)$/`。語が値の一部にあるだけ（「Unknown Pleasures Records Inc.」「Sample & Co. GmbH」）は通す。
  2. 型の差し込み口: `/\[(?:missing|insert|required|tbd|todo|your)\b/i` と `/\{\{[^}]*\}\}/`。
  3. メール（`email` の項目だけ）: `@` の後ろを小文字にして、`example.com`・`example.net`・`example.org`（とその下）、`.example`・`.invalid`・`.localhost` で終わるもの（RFC 2606・6761 の、例と使えない名前）。`@` の前と、後ろの最初の区切りまでが、どちらも `test`・`sample`・`dummy`・`fake`・`example` のどれか（例 `test@test.com`）。`.test` は通す（文書とテストが使う）。
  4. 電話（`phone` の項目だけ）: 数字だけにして 7 桁未満、または同じ数字が 7 つ以上続くもの（`+1-555-555-5555`・`000-0000`・`+81-3-0000-0000`）。`+1-202-555-0100`〜`0199` は通す。報告書の番号などの、電話でない項目には当てない（`TR-2026-0000-0000` を通す）。
  5. 1〜4 に当たる項目を全部集め、1 つでもあれば `new TradeInputError(\`GCC の項目に見本・仮置きに見える値があります（${項目のパスをカンマでつないだもの}）。記録の値だけを渡してください。\`, 'UNVERIFIED_PLACEHOLDER_INPUT')`。パスは `items[0].manufacture.name`・`certifier.email` の形。
  6. 日付（`manufacture.date`・`testing.date`）: `/^(\d{4})-(\d{2})(?:-(\d{2}))?$/` で、月が 1〜12、日があればその月にある日（`Date.UTC` で作って同じ年月日に戻る）、年が 1900 以上、かつ「地球上でいちばん進んだ今日」（`new Date(Date.now() + 14 * 3_600_000).toISOString()` の先頭 10 字。年月だけのときは先頭 7 字）より後でないこと。外れたら項目を集めて `new TradeInputError(\`日付は YYYY-MM か YYYY-MM-DD の、実在する未来でない日にしてください（${パス}）。\`, 'INVALID_INPUT')`。見本の語の確かめ（1〜5）を先に行う。
- [ ] **Step 3: 通ることを確かめる。** `bun test src/services/gcc.test.ts`（Task 4〜6 のテストの値は、架空の `.test` と `555-01xx` なので通る）。
- [ ] **Step 4: コミット。** `fix(trade): reject only clear placeholders in GCC records, skip the server defaults and validate dates`

### Task 8: 商品ページからの候補（url）

**対象:** `src/services/gcc.ts`、`src/types.ts`（`GccItemInputSchema` に `url`、応答に `suggestions`）、`src/services/gcc.test.ts`。

直す指摘: I3（ページの題・最初の在庫の種類の SKU・本文の先頭を証明書に載せる。URL だけで generated になる）、I5（URL の品の数と時間の上限）、I11（JSON-LD は scrape の出力から GCC の中で読む）、M11（`variant=12` が `variant=123` に当たる）、I9（新しいテストは遅い取得の道に入れない）。

**Interfaces:**
- Consumes: `scrapeUrl`（`../scraper.js` を呼ぶときに `await import` して使う。テストで `spyOn` できるように）、`GccItemSummary`（Task 4）。
- Produces:

```ts
export interface GccSuggestions { identifier?: string; identifierType?: GccIdentifierType; pageProductName?: string; brand?: string; variants?: number }
// GccItemInput に url?: string、GccItemSummary に suggestions?: GccSuggestions を足す
```

- [ ] **Step 1: 失敗するテストを書く。**

```ts
// import に足す: afterAll, beforeAll, spyOn（'bun:test'）、* as scraper（'../scraper.js'）
describe('product page suggestions (I3, I5, M11)', () => {
  let server: ReturnType<typeof Bun.serve>;
  let hits = 0;
  let prevAllow: string | undefined;
  const ld = {
    '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Road Helmet', brand: { '@type': 'Brand', name: 'Acme' },
    hasVariant: [
      { '@type': 'Product', '@id': '/p?variant=11#v', name: 'Road Helmet - S', sku: 'HLM-S', offers: { '@type': 'Offer', url: '/p?variant=11' } },
      { '@type': 'Product', '@id': '/p?variant=123#v', name: 'Road Helmet - L', sku: 'HLM-L', offers: { '@type': 'Offer', url: '/p?variant=123' } },
    ],
  };
  beforeAll(() => {
    prevAllow = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() {
        hits++;
        return new Response(`<!doctype html><html><head><title>Road Helmet | Acme Shop</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><main><h1>Road Helmet</h1><p>${'Lightweight road cycling helmet for adults with an impact-absorbing liner. '.repeat(12)}</p></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
  });
  afterAll(() => {
    server.stop();
    if (prevAllow === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = prevAllow;
  });
  const page = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const options = (items: GccItemInput[]) => ({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items });

  it('suggests the exact variant’s SKU and keeps the GCC a draft until the caller passes it', async () => {
    const res = await generateGccCertificate(options([{ ...HELMET, identifier: undefined, url: page('/p?variant=123') }]));
    expect(res.items[0].status).toBe('draft_needs_info');
    expect(res.items[0].missingFields).toEqual(['identifier']);
    expect(res.items[0].suggestions).toMatchObject({ identifier: 'HLM-L', identifierType: 'sku', pageProductName: 'Road Helmet - L', brand: 'Acme', variants: 2 });
    const prefix = await generateGccCertificate(options([{ ...HELMET, identifier: undefined, url: page('/p?variant=12') }]));
    expect(prefix.items[0].suggestions?.identifier).toBeUndefined();
    const plain = await generateGccCertificate(options([{ ...HELMET, identifier: undefined, url: page('/p') }]));
    expect(plain.items[0].suggestions?.identifier).toBeUndefined();
    expect(plain.items[0].clarifyingQuestions?.join('')).toContain('2 種類');
  }, 15_000);

  it('does not read the page when the caller passed the identifier', async () => {
    const before = hits;
    await generateGccCertificate(options([{ ...HELMET, url: page('/p') }]));
    expect(hits).toBe(before);
  });

  it('reads the page with the static fetch only, 10 seconds at most, and at most 5 items with url per call', async () => {
    const spy = spyOn(scraper, 'scrapeUrl');
    try {
      await generateGccCertificate(options([{ ...HELMET, identifier: undefined, url: page('/p?variant=11') }]));
      expect(spy.mock.calls[0][0]).toMatchObject({ fastOnly: true, timeoutMs: 10_000, formats: ['jsonLd'] });
    } finally {
      spy.mockRestore();
    }
    const six = Array.from({ length: 6 }, (_, i) => ({ ...HELMET, identifier: undefined, url: page(`/p?variant=${i}`) }));
    await expect(generateGccCertificate(options(six))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 15_000);
});
```

（`scraper` は `import * as scraper from '../scraper.js'`。）

Run: `bun test src/services/gcc.test.ts -t 'product page suggestions'`
Expected: FAIL

- [ ] **Step 2: 直す。**
  1. スキーマ: `url: z.string().url().optional().describe('商品ページ。番号・名前の候補を返すだけで、証明書には載せない（1 回に 5 件まで）')`。
  2. `url` のある品が 6 件以上なら、ページを読む前に `new TradeInputError('url を付けられる品は 1 回に 5 件までです', 'INVALID_INPUT')`。
  3. 読むのは `url` があり `identifier` が無い品だけ。並べて読む（`Promise.all`）。`scrapeUrl({ url, fastOnly: true, timeoutMs: 10_000, formats: ['jsonLd'], onlyMainContent: true, maxChars: 2_000 })`（ブラウザを使わない。scrape のキャッシュのキーは自動で別になる）。失敗したら品の `warnings` に `商品ページを読めませんでした（${理由}）` を足して進める。
  4. JSON-LD の読み方（GCC の中だけ。`html_parser.ts` は変えない）: `jsonLd` の配列と、その中の `@graph` を 1 段だけ開き、`@type`（文字列か配列）に `ProductGroup` か `Product` を含む最初のオブジェクトを使う。`ProductGroup` の `hasVariant` があるとき、URL の `variant` の値があれば、種類の `@id`・`url`・`offers[].url` を `new URL(値, ページの URL)` で読み、`searchParams.get('variant')` が完全に等しい種類を選ぶ（部分一致にしない。M11）。`variant` が無ければ、種類が 1 つのときだけ選ぶ。`variants` は種類の数。
  5. 候補: 選んだ種類（無ければ商品）の `sku` → `identifierType: 'sku'`、無ければ `gtin13`・`gtin12`・`gtin14`・`gtin8`・`gtin` → `'gtin'`、無ければ `mpn` → `'model'`。商品の `sku` が無く `offers` が 1 つだけのときはその `sku`。`pageProductName` は選んだ種類の `name`（無ければ商品の `name`。ページの `<title>` は使わない）。`brand` は文字列か `brand.name`。
  6. 候補は `suggestions` に入れるだけで、`identifier` などを埋めない（品は draft のまま）。質問: 候補の番号があれば `商品ページの番号 ${identifier}（${identifierType}）を使うなら、出荷する品と同じか確かめてから identifier に入れてください。`、種類が 2 つ以上で選べなければ `商品ページに ${variants} 種類あります。出荷する種類の番号を identifier に入れてください（URL に ?variant= を付けると候補を出せます）。`。
- [ ] **Step 3: 通ることを確かめる。** `bun test src/services/gcc.test.ts src/html_parser.test.ts`。`git diff BASE -- src/html_parser.ts` が空のまま。
- [ ] **Step 4: コミット。** `feat(trade): suggest the identifier from the product page JSON-LD without putting it on the GCC`

### Task 9: MCP の定義・エラーの形・検索・大きさ

**対象:** `src/mcp/tools_trade.ts`、`src/mcp/instructions.ts`、`src/types.ts`（OpenAPI の説明）、`scripts/tool-health/catalog.ts`、`src/services/gcc.test.ts`、`src/context_budget.test.ts`。

直す指摘: I8（定義の大きさ）、M8（REST と MCP のエラーの形）、M12（search_tools の「FedEx」に GCC が出る）、I4（応答の大きさの目標をテストで守る）、I10（MCP のエラーの包み）。

**Interfaces:**
- Consumes: `generateGccCertificate`・`TradeGccIncompleteError`（`details`）・`TradeInputError`（`code`）、`searchCatalog`（`src/mcp/registry.ts`）・`toolCatalogOf`（`src/mcp.ts`）。
- Produces: 最終の MCP の登録。

- [ ] **Step 1: 失敗するテストを書く**（`src/services/gcc.test.ts`。MCP の呼び出しは `InMemoryTransport` と `createMcpServer({ deferTools: false })`。`src/trade_tracking_watch_params.test.ts` の `withClient` と同じ形の関数をこのファイルに置く）。

```ts
// import に足す: Client（'@modelcontextprotocol/sdk/client/index.js'）、InMemoryTransport（'@modelcontextprotocol/sdk/inMemory.js'）、
// createMcpServer, toolCatalogOf（'../mcp.js'）、searchCatalog（'../mcp/registry.js'）
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'gcc-test', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('generate_gcc_certificate over MCP', () => {
  it('keeps the tool definition within 3,600 characters (I8)', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(JSON.stringify(tools.find((t) => t.name === 'generate_gcc_certificate')).length).toBeLessThanOrEqual(3600);
    });
  });

  it('returns the same error shape as REST: isError with code and details (M8, I10)', async () => {
    await withClient(async (client) => {
      const parse = (r: any) => JSON.parse(r.content[0].text);
      const incomplete = await client.callTool({ name: 'generate_gcc_certificate', arguments: { items: [{ ...HELMET, identifier: undefined }] } });
      expect(incomplete.isError).toBe(true);
      expect(parse(incomplete)).toMatchObject({ code: 'MISSING_REQUIRED_GCC_FIELDS', details: { missingFields: expect.arrayContaining(['certifier.name']) } });
      expect(parse(incomplete).details.items[0].missingFields).toContain('identifier');
      const placeholder = await client.callTool({ name: 'generate_gcc_certificate', arguments: { certifier: { ...CERTIFIER, name: 'TBD' }, recordCustodian: CUSTODIAN, items: [HELMET] } });
      expect(parse(placeholder).code).toBe('UNVERIFIED_PLACEHOLDER_INPUT');
      const tooMany = await client.callTool({ name: 'generate_gcc_certificate', arguments: { items: Array.from({ length: 51 }, () => HELMET) } }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect((tooMany as any).isError).toBe(true);
    });
  });

  it('is found by "GCC" and not by a courier name (M12)', () => {
    const catalog = toolCatalogOf(createMcpServer({ deferTools: true }));
    const names = (q: string) => searchCatalog(catalog, q).map((e) => e.name);
    expect(names('GCC')).toContain('generate_gcc_certificate');
    expect(names('FedEx')).toContain('track_package');
    expect(names('FedEx')).not.toContain('generate_gcc_certificate');
  });

  it('keeps the MCP response within 6,000 / 35,000 / 150,000 characters for 1 / 10 / 50 items (I4)', async () => {
    for (const [n, max] of [[1, 6_000], [10, 35_000], [50, 150_000]] as const) {
      const items = Array.from({ length: n }, (_, i) => ({ ...HELMET, identifier: `HLM-${String(i).padStart(3, '0')}`, testing: { ...HELMET.testing, reportNumber: `TR-${i}` } }));
      const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, ...(n > 1 ? { orderNumber: 'ORDER-1001' } : {}), items });
      expect(JSON.stringify(res).length, String(n)).toBeLessThanOrEqual(max);
    }
  });
});
```

`src/llm_contract_sync.test.ts` の instructions の確かめに、`buildSoraMcpInstructions(['trade'])` が `generate_gcc_certificate` を含み、`GCC RULE` を含まないことを足す。

Run: `bun test src/services/gcc.test.ts -t 'over MCP' && bun test src/llm_contract_sync.test.ts`
Expected: FAIL（エラーの形が違う、FedEx で出る、定義が大きい、instructions に GCC RULE がある）

- [ ] **Step 2: 直す。**
  1. ツール単位の説明（遅延のツールで、最初の 14 ツールの合計には入らない）: `【推測・見本の値は禁止】米国CPSCの一般適合証明書（GCC、16 CFR 1110.11）と、通関の保留に出す書類（表紙、品目ごとのGCC、16 CFR 1610.1(d) の免除の説明）を印刷用のHTMLで作る。値は記録から渡す。足りない項目があれば既定で 422（allowDraft で下書き）。12歳以下の子供用は CPC が要るので作らない。返却: { packageId, overallStatus, counts, items, packageHtml }`（返却の名前は応答のスキーマにあるものだけ。`schema:notation` が確かめる）。
  2. エラー（M8）: `TradeGccIncompleteError` は `isError: true` と `toolJson({ error: err.message, code: err.code, details: err.details })`、`TradeInputError` は `toolJson({ error: err.message, code: err.code })`、ほかは今のとおりの文。REST の 422 と同じく `details` の下に `missingFields`・`items` を置く。
  3. キーワード（M12）: `['GCC', 'General Certificate of Conformity', '一般適合証明書', '適合証明書', '16 CFR 1110', 'CPSC', 'eFiling', '通関保留', 'Disclaim']`（運送会社・EC の名前を入れない。説明文にも書かない）。
  4. instructions: 貿易の行を v4.1 の文に戻し、ツールの並びの `verify_hts_code` の後ろに `, generate_gcc_certificate` だけを足す（作業ツリーの「GCC RULE」の行と HTS の規則の言い換えを取らない。GCC の決まりはツールの説明に置く。増えるのは 26 字ほど）。
  5. OpenAPI の `/trade/gcc-generate`: summary `米国CPSCの一般適合証明書（GCC）と、通関の保留に出す書類を作る（16 CFR 1110.11）`。200 `GCC・免除の説明・表紙の HTML と、品ごとの要約`。400 `入力の誤り（スキーマ、10 桁でない HTS コード、日付、url の品が 6 件以上: INVALID_INPUT）、見本・仮置きに見える値（UNVERIFIED_PLACEHOLDER_INPUT）`。422 `GCC にする品に足りない項目がある（MISSING_REQUIRED_GCC_FIELDS。details.missingFields と details.items。allowDraft: true なら下書きを返す）`。
  6. `scripts/tool-health/catalog.ts` の `trade.gcc` を `toolCase('trade.gcc', ['generate_gcc_certificate'], [], false, 30000, …)` にし、入力を `{ items: [{ htsCode: '6109.90.10.07', productName: 'Adult Polyester T-Shirt', identifier: 'TEE-001', targetAge: 'adult', material: '100% polyester' }] }`、確かめる語を `['130.006', 'packageHtml']` にする（外のサービスを使わない）。
  7. 定義が 3,600 字を超えたら、品の項目の describe を短くして収める（引数を消さない）。
- [ ] **Step 3: 通ることを確かめる。**

```bash
bun test src/services/gcc.test.ts src/llm_contract_sync.test.ts src/context_budget.test.ts src/index.test.ts scripts/schema-notation/repository.test.ts
bun scripts/measure-context.ts   # 14 ツールの説明 3,495・既定 25,000 以下・全ツール 64,000 以下・instructions 9,000 未満
bun run schema:notation
```

- [ ] **Step 4: コミット。** `fix(trade): shrink the GCC tool definition, align MCP errors with REST and keep courier searches on track_package`

### Task 10: 仕上げ（文書・クライアント・両方の版の全件テスト）

**対象:** README.md、RELEASE_NOTES.md、docs/code-execution.md、`client/`、`src/mcp.ts` の注釈。

直す指摘: M9（古い数と文書）、C8・M10（実在に見える値が、どのコミットにも無いことの最後の確かめ）。

- [ ] **Step 1: README を直す**（行は 6081c6e のもの。ずれていたら語で探す: `rg -n '38 ?ツール|52 ?ツール|全52|全 52' README.md`）。
  - 数: 61・307 行の「DEFERRED (38ツール)」「残りの 38 ツール」を 39、61・302・304 行の「全 52 ツール」を 53、324 行の「DEFERRED 38 ツール」を 39、363 行の「DEFERRED: 38ツール」を 39、391 行と環境変数の表の `SORA_DEFER_TOOLS` の「全52ツール」を 53。
  - 遅延のツールの一覧（324 行あたり）に `generate_gcc_certificate`（米国CPSCの一般適合証明書と通関の保留の書類）を足す。
  - 貿易のツールの表の `generate_gcc_certificate` の行を、最後の引数（`items`・`certifier`・`recordCustodian`・注文の 4 つ・`allowDraft`）と応答（`packageId`・`overallStatus`・`counts`・`items`・`packageHtml`）にする。
  - §3.22b を書き直す: 入力（明細・当事者の形・`citations` の答え方）、判定（CPC・Disclaim B と 130.006・Disclaim A と Intended Use Code・GCC）、エラー（400・422）、`url` の候補、サーバーの既定（下）。例の要求は架空の値（Global Constraints の決まり）で、例の応答は、その要求をそのまま `generateGccCertificate` に渡した実際の出力から抜き出す（`packageId`・`certificateId` は実際の値。M1）。
  - 環境変数の表に 2 行足す: `SORA_GCC_CERTIFIER`（既定は無し。GCC の証明者の JSON `{"name","street","city","state","country","email","phone"}`。呼び出しに `certifier` が無いときだけ丸ごと使う。共有のサーバーでは設定しない（省いた呼び出しのすべての証明書にこの値が入る））、`SORA_GCC_CUSTODIAN`（同じ形。試験の記録を持つ人）。
  - `check_cpsc_certificate`・`check_product_compliance` の行（Task 2・3 で直したもの）を見直す。「法定7項目」「88.2 g/m²」「fabricWeightGsm」「SORA_GCC_CERTIFIER_NAME」などの古い語が残っていない（`rg` で 0 件）。
- [ ] **Step 2: RELEASE_NOTES.md の v4.1.0 を直す。** 題の末尾に「、米国 CPSC の一般適合証明書（GCC）を作るツールを足した」を足す。「先に気づく変更」に 1 項目: CPSC の判定が変わる品（大人の衣料は 16 CFR 1610.1(d) の免除で決まり、免除なら証明書は要らず Disclaim B / 130.006、繊維の組成は「100% polyester」の形で読む。帽子・手袋・履物の見出しは 16 CFR 1610.1(c) の条件の説明で `unknown`。ボタン・コイン電池は `hasBattery: true` と `batteryType: "button_coin"` で 16 CFR 1263。区分の規則の参考は 3 区分だけ。一覧に 5 件を足した）。「貿易・荷物・監視・国会・音楽」に、`generate_gcc_certificate` と `POST /trade/gcc-generate`（何を作るか、`items` だけを受ける、`htsCode` と記録は呼び出し側、`citations: []` の意味、422 と `allowDraft`、見本の値の 400、`url` は候補だけ、`SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN`、応答は JSON の要約と HTML だけ）、`check_cpsc_certificate` の新しい引数（`hasBattery`・`batteryType`・`fabricSurface`・`fabricWeightOzPerSqYd`）、`check_product_compliance` の新しい引数（`fabricSurface`・`fabricWeightOzPerSqYd`）、`batteryType` の空気亜鉛電池は `other` を書く。大きさの項目（「MCP の定義の大きさ」）の数を測り直し、全 52 → 53 ツールにする（14 ツールの説明の合計 3,495 字は変わらないことを書く）。
- [ ] **Step 3: docs/code-execution.md を測り直す。** `bun scripts/measure-context.ts` の値で、69 行の日付と前の値、表の「既定（14 ツール）」「全ツール（53 ツール）」「`instructions`」、`search_tools` の行を直す。95 行の「全ツール 61,500 文字」を `src/context_budget.test.ts` の値（64,000）に直す。
- [ ] **Step 4: 生成するクライアントを作り直して確かめる。**

```bash
bun run gen:client
bun run typecheck && bun run lint && bun run schema:notation
```

- [ ] **Step 5: 全件のテストを両方の版で通す**（手元のメモの命令。手元の Bun と Bun 1.4.2）。落ちたテストは、この計画の変更が原因なら直し、負荷による時間の揺れなら 1 回だけ流し直して記録に書く。
- [ ] **Step 6: 実在に見える値が、どのコミットにも無いことを確かめる。** 手元のメモの grep の一覧で `git log -p BASE..HEAD` を調べて 0 件。`rg -n 'direct-to-consumer|法定7項目|GCC READY|fabricWeightGsm|regulatedScope' src README.md RELEASE_NOTES.md docs client` が 0 件。
- [ ] **Step 7: コミット。** `docs(release): describe generate_gcc_certificate and the CPSC changes in v4.1.0 and re-measure the MCP sizes`

---

## 指摘と Task の対応表

| 指摘 | 中身（短く） | Task |
|---|---|---|
| C1 | 古い 16 CFR 1110.11 の要素 | 4（要素・完全さ）、5（表示・証明の文・(c)） |
| C2 | リストに無い大人の品を Disclaim A | 4 |
| C3 | `children_only` の表で大人のたんすなどを Disclaim A | 3（CPSC）、4（GCC） |
| C4 | ドライウォールを 16 CFR 1460 | 3 |
| C5 | 2016 年の方針の 2 つの日付 | 2（定数と CPSC の文）、6（免除の説明） |
| C6 | 試験のデータ無しに FDA への適合を書く | 6 |
| C7 | HTS の年齢・性別の変更 | 0 |
| C8 | 実在に見える連絡先 | 0（置き換え）、10（履歴の確かめ） |
| I1 | 1610.1(c) を語の正規表現で | 2 |
| I2 | 証明者を項目ごとに混ぜる | 4 |
| I3 | scrape の値を確かめずに証明書へ | 1（compliance の SKU を外す）、4（明示の値だけ）、8（候補だけ） |
| I4 | 応答が大きすぎる | 1（compliance の入れ子）、4（形）、9（大きさのテスト） |
| I5 | まとめての処理の時間に上限が無い | 4（`htsCode` 必須、判例・推測・品ごとの scrape をしない）、8（url は 5 件・10 秒・静的な取得・並べて） |
| I6 | Markdown を逃がしていない | 4（Markdown を出さない） |
| I7 | 子供の家具の規則が足りない | 3 |
| I8 | ツールの定義の大きさ | 4（1 つの形・`items` だけ・64,000 に戻す）、9（3,600 字のテスト） |
| I9 | 時間の揺れるテスト | 0（時間の上限）、1（振る舞いとともに消す）、8（新しいテストは本文を足し、静的な取得だけ） |
| I10 | テストの抜けと古い規則を固めるテスト | 0（C7）、2（(c) の誤り）、4（古い規則のテスト・当事者・50 件）、7、9（MCP の包み） |
| I11 | html_parser の変更で scrape の出力が変わる | 1（v4.1 に戻す）、8（GCC の中で JSON-LD を読む） |
| M1 | 証明書の ID | 4 |
| M2 | 見本の値の確かめの誤り | 4（サーバーの値に当てない）、7（規則） |
| M3 | 日付を確かめない | 7 |
| M4 | Disclaim A の Intended Use Code | 4（`filingNote`）、6（HTML） |
| M5 | 玩具の除外の段落と年齢 | 3 |
| M6 | 「foreign direct-to-consumer certifier」 | 5 |
| M7 | 一覧に無いコードに一覧を出典に | 2 |
| M8 | REST と MCP のエラーの形 | 9 |
| M9 | 古い数と文書 | 0（テストの題）、10 |
| M10 | スキーマの例・テストの実在の名前 | 0、10 |
| M11 | 種類の部分一致 | 8 |
| M12 | search_tools の「FedEx」 | 9 |
| M13 | 近いコードの「B」と、一覧の 5 件の抜け | 3 |
| M14 | 88.2 g/m² への丸め | 2（oz/sq yd だけにし、丸めない） |

レビューの「Integration」の項目: 説明の合計（Task 0・9）、全ツールの予算（Task 0・4・9）、docs/code-execution.md（Task 10）、types.ts・tools_trade.ts・trade.ts の衝突（Task 0）、生地の質問が predict と compliance に届くこと（Task 2: compliance には引数を足して聞き、predict では聞かない）、instructions（Task 9）、README（Task 10）、クライアント（Task 0・10）。

## 持ち主に聞くこと

1. **`items` の上限を 50 のままにするか、20 に下げるか。** 推奨の既定: 50 のまま（この計画のとおり）。50 品の応答は 150,000 字ほどになる（1 品の GCC の HTML が約 2,000 字で、16 CFR 1110.11(a)(7) の文などは減らせない）。MCP のクライアントには応答を約 2 万 5 千トークンで切るものがあるので、20 品（6 万字ほど）までにしたいなら、Task 4 の `max(50)` と、Task 9 の大きさの目標（50 品 → 20 品 70,000 字）を変えるだけでよい。

## 直さないもの（理由）

- 16 CFR 1610.1(c)(4)（芯地）は、HTS の見出しで分からないので扱わない（呼び出し側が `citations` で答える）。
- ボタン・コイン電池の付いた大人の衣料では、16 CFR 1610.1(d) の試験の除外を自動では付けない（電池の判定が先に返るため。証明書は試験の記録で作れる）。
- CPSC の eFiling の Citation Codes の一覧（CPSC の eFiling Document Library）は同梱しない。規則の名前は呼び出し側の `citations` のまま載せ、Sora が確かめるのは 16 CFR 1263 と 1610 が入っているかだけ。
- FDA の FCS の案内文の CPG Sec. 545.400/545.450・21 CFR 175-177 は、このレビューでは確かめていない（条文の番号の直しは Prior Notice の 21 CFR 1.276(b)(5)(i)(A) だけ）。
- main に前からあるテストの店のブランド名（`src/index.test.ts` の JSON-LD のテスト）は、この機能の差分ではないので変えない。
