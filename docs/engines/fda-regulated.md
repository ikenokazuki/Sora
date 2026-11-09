# HTS コードから FDA の規制を判定する

米国へ輸入する品は、食品・医薬品・化粧品・医療機器・タバコ・食品に触れる器具などだと、FDA（米国食品医薬品局）の規制がかかります。通関の実務では、CBP（米国税関）の通関システム ACE で、FDA への申告の要否を PGA（Partner Government Agency。FDA など他省庁向けの申告項目）フラグ（FDA 向けは FD1〜FD4）で分けます。HTS コード（米国の関税率表の番号）を見ても、どのフラグになるかは書かれていません。

`check_fda_regulated` は、HTS コードから、FDA の規制対象の可能性・FD フラグ・関係する FDA のプログラム・事前通知（Prior Notice）の要否を決めます。食器のように、用途で答えが変わる品は、推測せず質問にします。

FD フラグは、FD1 が用途により該当（食品に触れる物質）、FD2 が食品以外で必須（医薬品・化粧品・医療機器・タバコ）、FD3 が用途により食品、FD4 が食品で必須（事前通知が要る）です。

## 使うツール

- MCP: `check_fda_regulated`（モジュール `trade` の遅延ツールです。`search_tools` で有効化します）。
- REST: `POST /trade/fda-check`。
- 内部では、`predict_hts_code`（[hts-prediction.md](hts-prediction.md)）、`check_product_compliance`（[product-compliance.md](product-compliance.md)）、`generate_gcc_certificate` の FDA の注記（[gcc-certificate.md](gcc-certificate.md)）が同じ判定を使います。

## 手元のデータと外への問い合わせ

外への問い合わせはありません。判定は、コードに書いた 2 つの表だけで行います。どちらも、商品名の辞書ではなく、HTS の桁と FDA の対応です。公式の「HTS コードごとの FDA 対応表」を取り込んだものではなく、Sora のコードに書いた対応です。

- 見出し（HTS の先頭 4 桁）の表（6 件）です。
  - 医薬品（`DRU`、FD2）: 3001〜3006。
  - 化粧品（`COS`、FD2）: 3303・3304・3305・3307。
  - 医療機器（`DEV`、FD2）: 9018・9019・9020・9021・9022・9025。
  - タバコ（`TOB`、FD2）: 2401〜2404。
  - 食品に触れる物質（`FCS`、FD1）: 3924・4419・6911・6912・7013・7323。
  - 食品用途の原料（`FOO`、FD3）: 3301・3302。
- 章（先頭 2 桁）の表（11 件）です。第 3〜23 類は食品（`FOO`、FD4。第 23 類は動物用医薬品の `VME` も）、第 24 類はタバコ、第 30 類は医薬品、第 33 類は化粧品、第 90 類は医療機器（いずれも FD2）です。
- 第 2 類（食肉）は、USDA（米国農務省）の管轄として、FDA の対象外にします。

更新は、コードを直すときだけです。

## 決め方

1. HTS コードから点を除き、章（先頭 2 桁）と見出し（先頭 4 桁）を取ります。
2. 第 2 類なら、FDA の対象外（`fdaRegulatedLikely: false`、`fdFlag: "none"`）です。USDA の要件を確かめるよう案内します。
3. 見出しが見出しの表にあれば、`confidence: "hts-flag-match"` で答えます。
   - `FCS` で、`foodContact` が `false` なら、FDA の対象外（`fdaRegulatedLikely: false`）です。`fdFlag` は FD1 のままで、ACE の免責（Disclaimer）の申告を案内します。
   - `FCS` で、`foodContact` が未指定なら、対象としたうえで、飲食用途かどうかを質問します（`foodContact`）。`true` なら、Prior Notice は要らず、食品接触の安全基準への適合の確認が要る、という案内です。
   - `FOO`（3301・3302）で、`foodContact` が未指定なら、食品用途かどうかを質問します（`foodUsage`）。`foodContact` を渡すと質問は消えますが、答えは変わりません。
   - `DRU`・`COS`・`DEV`・`TOB` は、質問なしで答えます。
4. 見出しの表になければ、章の表で答えます。`confidence: "chapter-level-estimate"` です。FD4 の章は、`priorNoticeRequired: true` です。第 16 類（USDA との重なり）・第 22 類（アルコール飲料は TTB との重なり）・第 23 類（動物飼料は FDA の動物用医薬品センター）・第 90 類（FDA の対象外の品が混ざる）には、注記を付けます。
5. どちらの表にもなければ、`fdFlag: "none"`、`fdaRegulatedLikely: false` です。

## 決められないとき

`foodContact` と `foodUsage` が、質問になります。`inputCompleteness: "partial"`、`missingInputs`、`clarifyingQuestions`、`impactExplanation` で返します。`foodContact` が効くのは、見出しが食品に触れる物質の表（3924・4419・6911・6912・7013・7323）にあるときだけです。

```json
{ "htsCode": "6912.00.4100" }
```

この入力は、`fdFlag: "FD1"`、`possiblePrograms: ["FCS"]`、`confidence: "hts-flag-match"` で、飲食物に直接接触する用途か、装飾・観賞用などの非食品用途かを尋ねる質問を返します。`foodContact: false` を足すと、FDA の対象外になり、免責の申告を案内します。

もう 1 つの例です。`0902.10.1015`（第 9 類）は、章の表で `FD4`、`FOO`、`confidence: "chapter-level-estimate"`、`priorNoticeRequired: true` になります。

## 限界

- 表は、Sora のコードに書いた対応です。実際に ACE が付けるフラグは、品目と商品によるので、これは通関の実務の目安です。
- 表にないものは、「対象外」という答えになります。たとえば、食品に触れる器具でも、見出しが表にない 8215（食卓用のスプーン・フォーク類）は、`fdFlag: "none"` です。表にないだけで、対象でないと確かめたわけではありません。
- 章の表は、章の全体を同じに扱います。第 3〜23 類は、その章の中の食品でない品も、食品（FD4・事前通知）の案内になります。第 33 類のうち表にない 3306（歯磨き）は、章の推定で化粧品になります。第 90 類は、光学機器など対象外の品も混ざるので、個別の確認が要ります。
- 施設登録・事前通知・個別の承認など、FDA の要件の中身は、案内の 1 行です。詳細は FDA の公式で確かめてください。
- 食品に触れる物質の案内文にある CPG の番号（Sec. 545.400・545.450）と 21 CFR 175〜177 は、公式の最新の条文と突き合わせていません。Prior Notice の免除の条文（21 CFR 1.276(b)(5)(i)(A)）は、公式の条文で確かめてあります。
- HTS コードが実在するかは確かめません。実在の確認は `verify_hts_code` です。
- 参考情報で、法的助言ではありません（応答の `disclaimer`）。

## 実装とテスト

- `src/services/trade.ts`（`checkFdaRegulated`、表の `FDA_SUBHEADING_RULES`・`FDA_CHAPTER_MAP`）
- `src/mcp/tools_trade.ts`、`src/routes/trade.ts`、`src/types.ts`（入力のスキーマ）
- テスト: `src/services/trade.test.ts`（食品に触れる物質・Prior Notice・免責の判定を含む）

[判断エンジンの一覧に戻る](README.md)
