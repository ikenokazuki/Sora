# 米国 CPSC の証明書と eFiling を判定する

米国の CPSC（消費者製品安全委員会）が管轄する製品には、適合証明書が要ることがあります。大人・一般向けは一般適合証明書（GCC）、12 歳以下の子供向けは子供用製品証明書（CPC。Sora の応答では `certificateType: "CCC"`）です。Sora は、2026 年 7 月 8 日から、この証明書のデータを CBP（米国税関）の通関システム ACE へ電子申告する eFiling が完全義務化されたものとして判定します。

`check_cpsc_certificate` は、HTS コードと製品の情報から、(a) 証明書が要るか・どの種類か、(b) eFiling が要るか、(c) 証明書が要らないときに ACE へ送る免責（Disclaim A・B という免責の区分です。送るときは Intended Use Code という用途の番号を添えます）の案内を決めます。HTS コードの一覧を見るだけでは、年齢や衣料の生地で答えが変わることが分かりません。逆に、情報が足りないのに推測で埋めると、証明書が要る品を「不要」と答えてしまいます。そこで Sora は、公式の一覧と条文の条件に当たるかを自分で判定し、足りない情報は質問にします。

## 使うツール

- MCP: `check_cpsc_certificate`（モジュール `trade` の遅延ツールです。`search_tools` で有効化します）。
- REST: `POST /trade/cpsc-check`。
- 内部では、`predict_hts_code`（[hts-prediction.md](hts-prediction.md)）、`check_product_compliance`（[product-compliance.md](product-compliance.md)）、`generate_gcc_certificate`（[gcc-certificate.md](gcc-certificate.md)）が同じ判定を使います。

## 手元のデータと外への問い合わせ

外への問い合わせはありません。判定は、コードに入れた次のデータだけで行います。

- CPSC の公式資料「CPSC Guidance and HTS List for the Electronic Filing (eFiling) of Certificates of Compliance」（2026 年 1 月版）から抜き出した HTS コードの一覧です。23 区分、延べ 591 コードです（Clothing・Shoes・Toys・Bicycle Helmets・Button Cell & Coin Batteries・Infant Sleep Products・Mattresses など。Clothing が 406 コードで最多です。3 コードは Clothing に 2 回載るので、重複を除くと 588 です）。
- 資料から抜き出したのは 2026-08-26 です。PDF の行の折り返しで抜けていた 5 コードを、2026-11-08 に足しました。更新は手作業で、自動では更新しません。資料自身が「網羅ではない」と注記しています。
- 規則の条文の写しです。16 CFR 1610.1(c)(1)〜(3)（帽子・手袋・履物）、1610.1(d)(1)・(2)（試験の免除）、81 FR 12587（2016 年 3 月 10 日掲載、3 月 25 日から。大人の衣料に GCC を求めない執行裁量の方針）。
- 区分ごとの規則の参考は、確かめた 3 区分だけです。Clothing（16 CFR 1610）、Infant Sleep Products（16 CFR 1236・1218・1241）、Toys（ASTM F963・16 CFR 1501）です。ほかの区分は「個別規格要確認」と返します。このほか、ボタン電池の 16 CFR 1263 と、子供向け製品全般の規則（15 U.S.C. 1278a・16 CFR 1303・1107）の 2 項目を持ちます。

## 決め方

上から順に見て、最初に当たったもので答えます。

1. 入力を確かめます。`hasBattery: false` と `batteryType: "button_coin"` は矛盾なので、400 `INVALID_INPUT` です。
2. 一覧を引きます。点を除いた 10 桁が一覧のコードと完全に一致すれば、その区分です。完全に一致するコードが無いときだけ、先頭 6 桁が同じコードが一覧にあるかを見ます（「近いコード」）。近いコードは、証明書が要るという根拠にはならず、確認の案内に使います。
3. HTS の見出し 6111・6209（USITC の表で乳児の衣類）で `targetAge` が `adult` なら、大人の免除を判定せず、年齢か HTS コードを確かめる質問を返します。
4. ボタン電池・コイン電池（`batteryType: "button_coin"`）なら、16 CFR 1263 を当てます。証明書は要り、eFiling も要ります。種類は年齢で決まり、`unknown` なら種類も `unknown` です。一覧の Toys で `targetAge: child` の品は、1263 の対象から外します（コードの注に、16 CFR 1250 の電池の要件に合う子供向けの玩具は 16 CFR 1263.1(c) で対象外とあります）。
5. 衣料なら、16 CFR 1610 で決めます。衣料とは、一覧の区分が Clothing か Shoes のコード、または一覧になく HTS の第 61・62 類か 1610.1(c) の見出しのコードです。
   - 年齢が `unknown` なら、年齢を聞きます。1610.1(c) の見出し以外では、生地の質問も合わせて聞きます。
   - 12 歳以下なら、CPC と eFiling が要ります。2016 年の執行裁量は子供服に当たらないためです。
   - 大人の帽子・手袋・履物の見出し（6504〜6506、6116・6216、6401〜6405）は、1610.1(c) の条件に当たるかで決まります。条件に当たるかは HTS コードから分からないので、`unknown` と条件の文を返し、条件に当たらないときの 1610.1(d) の答えを添えます。
   - 大人の衣料で、1610.1(d)(2)（`material` の繊維の組成を `"100% polyester"` の形で読み、acrylic・modacrylic・nylon・olefin・polyester・wool だけ）か、1610.1(d)(1)（`fabricSurface: plain` で `fabricWeightOzPerSqYd` が 2.6 以上）に当たれば、証明書も eFiling も要りません。`disclaimerCodeHint` は `B (Intended Use Code 130.006)` です。
   - (d)(2) にも (d)(1) にも当たらないと確定すれば、GCC と eFiling が要ります。
   - 確定しないときは `unknown` にして、足りない事実だけを聞きます（繊維の組成、生地の表面、重さ）。
6. 一覧にあるその他の区分なら、年齢が分かれば証明書が要ります（大人は GCC、12 歳以下は CCC）。eFiling も要ります。年齢が `unknown` なら `unknown` で、年齢を聞きます。大人の Toys には、規則が当たると書かず、年齢で確かめる注記を付けます（ASTM F963 は 14 歳未満、16 CFR 1501 は 3 歳未満の規則のため）。
7. 一覧になく、近いコードがあり、12 歳以下でなければ、`unknown` です。近い区分と近いコードを示し、確認を案内します。
8. 一覧になく、12 歳以下なら、CCC と eFiling です。子供向け製品全般の規則を根拠にします。
9. どれでもなければ `unknown` です。「一覧に無いことは証明書が不要という意味ではない」と返し、CPSC に確認するよう案内します。規則が当たらないと確かめた場合だけ、Disclaim A（Intended Use Code も要る）を送れると添えます。

## 決められないとき

`certificateRequired` は `true`・`false`・`"unknown"` の 3 値です。足りない入力は、判定が実際に必要としたものだけを、`missingInputs`・`clarifyingQuestions`・`impactExplanation` で返します。素材（`material`）は、大人の衣料以外では質問を出すか消すかだけで、答えを変えません。

```json
{ "htsCode": "6109.90.10.07", "targetAge": "adult", "material": "100% polyester" }
```

この入力は、`certificateRequired: false`、`certificateType: "none"`、`eFilingRequired: false`、`disclaimerCodeHint: "B (Intended Use Code 130.006)"` を返します（一覧に無い第 61 類のコードです）。繊維が綿混（`"60% cotton 40% polyester"`）で `fabricSurface: "plain"` だけ渡すと、`certificateRequired: "unknown"` で、`missingInputs: ["fabricWeightOzPerSqYd"]` と、生地の重さ（oz/sq yd）を聞く質問が返ります。

応答には、法的助言ではない旨の `disclaimer` が付きます。

## 限界

- 一覧は、CPSC 自身が「網羅ではない」とする資料の写しで、日付が固定です。CPSC が資料を改訂しても、手作業で更新するまで古いままです。一覧にないコードは、「不要」ではなく「確認が必要」と返します。
- 一覧にあるコードは、CPSC が「規則の対象を含みそうな品目」とした印です。Sora は、一覧にあって年齢が分かれば「証明書が要る」と答えますが、その品が実際にどの規則の対象かは見ていません。
- 一覧に載るのは 10 桁の完全一致だけです。一覧とは別の細分で書かれたコードは、近いコードか一覧外の扱いになります。
- 区分ごとの規則の参考は 3 区分だけです。ほかの区分では、どの安全規格が当たるかまでは言いません。
- 繊維は、`"N% fiber"` の形でだけ読みます。名前は 6 つの名前と同じでなければ当たりません（polyamide は nylon、polypropylene は olefin と書き直す必要があります）。繊維が 1 つなら 100% ちょうど、2 つ以上なら合計が 100 から 0.5 以内でなければ読みません。
- 1610.1(c)(4)（芯地）は、HTS の見出しで分からないので扱いません。
- ボタン電池のある大人の衣料は、電池の判定が先に返るので、1610.1(d) の免除は自動では付きません。
- 施行日の例外（外国貿易地域など）は見ません。
- 大人と 12 歳以下の 2 つに分けるだけです。年齢は、呼び出し側が渡した値をそのまま使います。
- これは参考情報です。Sora は ACE にも CPSC にも何も送らず、適合も保証しません。証明書の要否の最終判断と、証明書の中身への責任は、証明者にあります。CPSC の公式情報か専門家に確認してください。

## 実装とテスト

- `src/services/trade.ts`（`checkCpscCertificate`、`findCpscListCategory`、`section1610cExclusionFor`、`parseFiberContent`）
- `src/services/cpsc_hts_data.ts`（一覧）
- `src/mcp/tools_trade.ts`、`src/routes/trade.ts`、`src/types.ts`（入力のスキーマ）
- テスト: `src/services/trade.test.ts`（一覧の区分・電池・1610 の判定）、`src/trade_tracking_watch_params.test.ts`（引数名）

[判断エンジンの一覧に戻る](README.md)
