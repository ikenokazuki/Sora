import { z } from 'zod';
import {
  checkCpscCertificate,
  checkFdaRegulated,
  checkProductCompliance,
  generateGccCertificate,
  predictHtsCode,
  TradeGccIncompleteError,
  TradeInputError,
  verifyHtsCode,
} from '../scraper.js';
import { CpscCertificateCheckRequestSchema, GenerateGccCertificateRequestSchema, ProductComplianceRequestSchema } from '../types.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';
import { onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🚢 Category: Trade Compliance (モジュール: 'trade') */
export function registerTradeTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool: check_regulations (HTSコードからCPSC・FDAの規制を判定。agencies で選ぶ) - DEFERRED
  // agencies の機関ごとの節。機関を足すときは、ここに 1 項目足す（args はその機関の引数、check は足りない引数の検査）。
  // 節の中身は、統合前のツールの応答のまま（REST の /trade/cpsc-check・/trade/fda-check と同じ）
  type RegulationArgs = Omit<z.infer<typeof CpscCertificateCheckRequestSchema>, 'targetAge'>
    & Partial<Pick<z.infer<typeof CpscCertificateCheckRequestSchema>, 'targetAge'>> & { foodContact?: boolean };
  type RegulationSection = {
    label: string;
    usage: string;
    args: Array<Exclude<keyof RegulationArgs, 'htsCode'>>;
    check?: (args: RegulationArgs) => string | undefined;
    run: (input: RegulationArgs) => unknown;
  };
  const REGULATION_SECTIONS: Record<string, RegulationSection> = {
    cpsc: {
      label: 'CPSC certificate check',
      usage: 'CPSC の証明書と eFiling。targetAge（必須。不明なら "unknown"）・material・hasBattery・batteryType・fabricSurface・fabricWeightOzPerSqYd',
      args: ['targetAge', 'material', 'hasBattery', 'batteryType', 'fabricSurface', 'fabricWeightOzPerSqYd'],
      check: ({ targetAge }) => (targetAge ? undefined : 'agencies に cpsc を含むとき（既定）は targetAge が必要です（不明なら "unknown"）。FDA だけなら agencies: ["fda"]。'),
      run: (input) => checkCpscCertificate({ ...input, targetAge: input.targetAge! }),
    },
    fda: {
      label: 'FDA regulation check',
      usage: 'FDA の規制対象と FD フラグ。foodContact',
      args: ['foodContact'],
      run: (input) => checkFdaRegulated(input),
    },
  };
  const AGENCIES = Object.keys(REGULATION_SECTIONS);
  const AGENCIES_DEFAULT = AGENCIES;
  const REGULATION_USAGE = `使い方: htsCode（必須）を、agencies で選んだ機関で判定する（${AGENCIES.map((agency) => `${agency}: ${REGULATION_SECTIONS[agency].usage}`).join('。')}）。既定は ${JSON.stringify(AGENCIES_DEFAULT)}。`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'check_regulations',
    'trade',
    '【必須・即時推測厳禁】HTSコードから米国の規制を判定する際は、推測せず必ず本ツールを実行してください。agenciesで機関を選ぶ（既定は両方）。cpsc: CPSC適合証明書（GCC/CPC）要否と2026年7月完全義務化されたCBP ACE電子申告（eFiling）義務、非対象時のACE免責申告コード(Disclaimer)と根拠条文（16 CFR）。fda: FDA規制対象（FD1〜FD4フラグ・Prior Notice要否・MoCRA・ACE免責Disclaimer要件）。素材・年齢層・食品接触用途が不明な場合は推測で埋めず、未指定/unknownで呼び出すこと。不足時は確認質問(clarifyingQuestions)と影響説明を返却します。返却: { agencies, cpsc: { certificateRequired, eFilingRequired, applicableRegulations, clarifyingQuestions, impactExplanation }, fda: { fdaRegulatedLikely, fdFlag, possiblePrograms, priorNoticeRequired, clarifyingQuestions, impactExplanation } }',
    {
      htsCode: z.string().min(1).describe('HTSコード（例: "9503.00.0073", "3004.90.0000"）。判定の主軸キー'),
      agencies: z.array(z.string()).optional().describe(`判定する機関 (${AGENCIES.join('・')}。既定 ${JSON.stringify(AGENCIES_DEFAULT)})。cpsc: CPSC適合証明書とeFiling、fda: FDA規制対象とFDフラグ`).meta({ default: AGENCIES_DEFAULT }),
      targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下, adult: 一般/大人, unknown: 未指定/不明）。12歳以下は GCC でなく CPC。agencies に cpsc を含むとき（既定）は必須。【推測値の入力厳禁】不明な場合は"unknown"を指定すること。cpsc のときだけ'),
      material: z.string().optional().describe('主な素材。衣料では繊維の組成（"100% polyester" の形）で 16 CFR 1610.1(d)(2) の免除を決める。ほかでは確認の質問を出すか消すかだけ。【推測値の入力厳禁】不明な場合は省略すること。cpsc のときだけ'),
      hasBattery: CpscCertificateCheckRequestSchema.shape.hasBattery,
      batteryType: CpscCertificateCheckRequestSchema.shape.batteryType,
      fabricSurface: CpscCertificateCheckRequestSchema.shape.fabricSurface,
      fabricWeightOzPerSqYd: CpscCertificateCheckRequestSchema.shape.fabricWeightOzPerSqYd,
      foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true: 接触, false: 非接触）。効くのは、HTSの4桁がFCSの表の品目（3924・4419・6911・6912・7013・7323）のときだけ。【推測値のでっち上げ厳禁】不明な場合は省略すること。fda のときだけ'),
    },
    async (args) => {
      // 空の配列は省略と同じ（args.ts の given と同じ読み方）
      const requested = args.agencies?.length ? args.agencies : AGENCIES_DEFAULT;
      const unknown = requested.filter((agency) => !AGENCIES.includes(agency));
      if (unknown.length > 0) return usageError(`agencies に使えない値があります: ${unknown.join(', ')}。${REGULATION_USAGE}`);
      const agencies = AGENCIES.filter((agency) => requested.includes(agency));
      // 頼んだ機関は足りない引数を、頼まなかった機関はその機関だけの引数を断る（頼んだ機関も使う引数は断らない）
      const accepted = new Set(agencies.flatMap((agency) => REGULATION_SECTIONS[agency].args));
      for (const agency of AGENCIES) {
        const section = REGULATION_SECTIONS[agency];
        if (agencies.includes(agency)) {
          const missing = section.check?.(args);
          if (missing) return usageError(`${missing}${REGULATION_USAGE}`);
        } else {
          const only = section.args.filter((key) => !accepted.has(key));
          const invalid = onlyForMode(`agencies: ${JSON.stringify(agencies)}`, [`agencies に ${agency} を含むとき`], args, only, REGULATION_USAGE);
          if (invalid) return usageError(invalid);
        }
      }
      // サービスには、その機関の旧ツールの引数だけを渡す
      const answer: Record<string, unknown> = { agencies };
      for (const agency of agencies) {
        const section = REGULATION_SECTIONS[agency];
        const input = { htsCode: args.htsCode, ...Object.fromEntries(section.args.filter((key) => args[key] !== undefined).map((key) => [key, args[key]])) };
        try {
          answer[agency] = await section.run(input);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${section.label} error: ${errorMessage(err) || err}` }] };
        }
      }
      return { content: [{ type: 'text', text: toolJson(answer) }] };
    },
    { defaultEnabled: deferredDefault, keywords: ['CPSC', 'GCC', 'CCC', 'eFiling', '適合証明書', 'FDA', '食品医薬品局', 'Prior Notice', '事前通知', 'FD Flag', 'MoCRA', '規制判定', '輸出', '輸入', 'HTS', '貿易', 'コンプライアンス', 'check_cpsc_certificate', 'check_fda_regulated'] },
  );

  // Tool: lookup_hts (HTS/HSコードの照合と推測。htsCode の有無で選ぶ) - DEFERRED
  const HTS_USAGE = '使い方: htsCode（ユーザーが示したコード）があれば照合し、description（商品の説明）が必須。htsCode を省くと推測し、productName（英語の一般名）が必須で、description・material・productCategory・targetAge・foodContact・hasBattery を添えられる。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
  const WITH_HTS = 'htsCode を指定したとき';
  const WITHOUT_HTS = 'htsCode を省いたとき';
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'lookup_hts',
    'trade',
    '【必須・公式照合・推測厳禁】米国のHTS/HSコードを引く。htsCodeがあれば照合: ユーザーから明示提示されたコードを米国USITC公式データ(hts.usitc.gov)と照合し実在検証・正式品目名・一般関税率を取得（HTS Revision 18等の大統領布告・通商法301条Chapter 99特別追加関税リスクも提示。6桁一致時は詳細仕様の確認質問）。htsCodeを省けば推測: 商品の英語の一般名・説明から、USITC公式HTS全件の階層つき全文検索とCBP分類判例を統合し、米国通関用10桁HTSコード候補、一般関税率、CPSC/FDA規制要件を推測します。日本語の商品は英訳して渡すこと（英語が主でないとエラー）。【推測値のでっち上げ厳禁】素材・年齢・食品接触・電池等が不明な場合は勝手に埋めず省略すること。候補が公式の階層で分かれるときは分岐点の質問を返すので、ユーザーの答えをdescriptionに加えて再実行してください。返却: mode（verify / predict）と、verify は { verified, matchLevel, officialDescription, generalRate, clarifyingQuestions }、predict は { detectedSubheading, bestMatch, candidates, decisionPoints, evidence, clarifyingQuestions, impactExplanation }',
    {
      htsCode: z.string().optional().describe('照合するHTSコード（例: "9503.00.0073"）。【推測入力禁止】ユーザーから明示提示されたコードだけを指定すること。コードを推測・特定したいときは省く（商品の説明から推測する）'),
      description: z.string().optional().describe('商品の説明（英語）。htsCode があれば必須で、判定には使わず、根拠の記録として応答の productDescription に返す。省いたときは推測の詳細説明・機能・用途で、事実だけを書く（"not ceramic" のような否定は検索語として扱われないので不要）'),
      productName: z.string().optional().describe('商品の一般名（英語、宣伝文句やブランド名は除く。例: "Ceramic Coffee Mug", "Green Tea"）。日本語の商品は英訳して渡す。htsCode を省いたとき（推測）だけで、必須'),
      material: z.string().optional().describe('主な素材（例: wood, ceramic, cotton, stainless steel, plastic）。【推測値のでっち上げ厳禁】不明な場合は省略すること。htsCode を省いたときだけ'),
      productCategory: z.string().optional().describe('製品カテゴリ（例: Toys, Tableware, Apparel, Cosmetics, Food, Electronics）。推測の検索語には入るが、CPSCの判定は読まない。【推測値の入力厳禁】不明な場合は省略すること。htsCode を省いたときだけ'),
      targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下, adult: 大人/一般, unknown: 不明）。【推測値のでっち上げ厳禁】不明な場合は省略すること。htsCode を省いたときだけ'),
      foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true/false）。効くのは、HTSの4桁がFCSの表の品目（3924・4419・6911・6912・7013・7323）のときだけ。【推測値のでっち上げ厳禁】不明な場合は省略すること。htsCode を省いたときだけ'),
      hasBattery: z.boolean().optional().describe('電池・バッテリーを搭載しているか（true/false）。trueのときだけ推測の検索語にbatteryを足す。falseでは何もしない。【推測値のでっち上げ厳禁】不明な場合は省略すること。htsCode を省いたときだけ'),
    },
    async (args) => {
      const { htsCode, description, productName } = args;
      // 空の htsCode は、指定しなかったのと同じ（推測）
      const mode = htsCode?.trim() ? WITH_HTS : WITHOUT_HTS;
      const invalid = onlyForMode(mode, [WITHOUT_HTS], args, ['productName', 'material', 'productCategory', 'targetAge', 'foodContact', 'hasBattery'], HTS_USAGE)
        ?? (mode === WITH_HTS && !description?.trim() ? `${mode}は description が必要です（商品の説明。根拠の記録として応答に返す）。${HTS_USAGE}` : undefined)
        ?? (mode === WITHOUT_HTS && !productName?.trim() ? `${mode}は productName が必要です（商品の英語の一般名）。${HTS_USAGE}` : undefined);
      if (invalid) return usageError(invalid);
      // 応答とエラーの文は、統合前の 2 ツールのまま（REST の 2 ルートと同じサービス）。mode を足す
      if (mode === WITH_HTS) {
        try {
          return { content: [{ type: 'text', text: toolJson({ mode: 'verify', ...await verifyHtsCode({ htsCode: htsCode!, productDescription: description! }) }) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `HTS code verification error: ${errorMessage(err) || err}` }] };
        }
      }
      // 推測の引数（htsCode を除く全部。REST の /trade/hts-predict と同じ）をそのまま渡す
      const { htsCode: _htsCode, ...options } = args;
      try {
        return { content: [{ type: 'text', text: toolJson({ mode: 'predict', ...await predictHtsCode({ ...options, productName: productName! }) }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `HTS code prediction error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['HTS', 'HSコード', '関税分類', 'USITC', '実在確認', '検証', '関税率', 'HTS推測', 'HS推測', '関税分類推測', 'コード検索', 'CBP分類判例', '輸出', '輸入', '貿易', 'コンプライアンス', 'predict_hts_code', 'verify_hts_code'] },
  );

  // Tool: check_product_compliance (商品統合コンプライアンス一括判定) - CORE (defaultEnabled: true)
  // CORE コンテキスト予算を守るため、GCC の当事者・試験機関明細付き一括発行は generate_gcc_certificate に分離し、ここでは主要商品属性のみ公開
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'check_product_compliance',
    'trade',
    '【必須・即時推測厳禁】商品ページURLや品名・素材から、HTS推測・実在検証・FDA実務判定・CPSC証明書・2026年7月eFiling義務を一括で判定し、通関前アクションプラン付きの総合診断を返す。HTSコードを推定したい場合はhtsCodeを必ず省略（Soraが公式データと判例から特定）。品名・説明は英語の一般名で。未確定ならneeds_more_infoで質問を返す。返却: { product, overallStatus, summary, htsVerification, htsPrediction, fda, cpsc, clarifyingQuestions, impactExplanation, actionPlan }',
    {
      url: z.string().url().optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
      productName: z.string().optional().describe('商品の一般名（英語、宣伝文句やブランド名は除く。例: "Wooden Building Blocks", "Bicycle Helmet"）。日本語の商品は英訳して渡す'),
      description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など（英語）。事実だけを書く（"not ceramic" のような否定は検索語として扱われないので不要）'),
      htsCode: z.string().optional().describe('ユーザーからプロンプト内で明示的に提示された既知のHTSコード（指定時は最優先で検証）。【LLM自身の推測・候補値の入力厳禁！】HTSコードを推測・特定したい場合は必ず省略（未指定）にすること。未指定時にSoraが公式データと判例から特定します'),
      targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      material: z.string().optional().describe('主な素材（例: plastic, wood, metal, cotton）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと。衣料は "100% polyester" の形（16 CFR 1610.1(d)(2)）'),
      productCategory: z.string().optional().describe('製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, helmet）。推測の検索語には入るが、CPSCの判定は読まない'),
      foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲み物や食べ物を入れる/口をつける等の食品接触用途, false: 装飾等の非食品接触用途）。効くのは、HTSの4桁がFCSの表の品目（3924・4419・6911・6912・7013・7323）のときだけ。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か（true: ボタン電池・コイン電池またはリチウムイオン電池等を内蔵/同梱, false: 電池不使用）。trueのときだけ推測の検索語にbatteryを足す。batteryTypeがbutton_coinなら、CPSCの判定に16 CFR 1263を当て、注意書きを1行足す。falseでは何もしない（batteryType が button_coin だとエラー）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      batteryType: z.enum(['button_coin', 'other']).optional().describe('電池の種類（button_coin: ボタン電池・コイン電池, other: リチウムイオン電池・空気亜鉛電池（16 CFR 1263.1(d) で対象外）など）。button_coin は hasBattery を省いても電池あり（false とは矛盾でエラー）。other は true のときだけ。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      fabricSurface: ProductComplianceRequestSchema.shape.fabricSurface,
      fabricWeightOzPerSqYd: ProductComplianceRequestSchema.shape.fabricWeightOzPerSqYd,
    },
    async (opts) => {
      try {
        const result = await checkProductCompliance(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Product compliance check error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['商品判定', 'コンプライアンス', 'FDA', 'CPSC', 'eFiling', 'GCC', 'CCC', 'HTS', '貿易一括判定', '輸出', '輸入'] },
  );

  // Tool: generate_gcc_certificate (米国CPSC の一般適合証明書と通関の保留に出す書類) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'generate_gcc_certificate',
    'trade',
    '【必須・推測や見本の値は禁止】米国CPSCの一般適合証明書（GCC、16 CFR 1110.11）と、通関の保留に出す書類（表紙、品目ごとのGCC、16 CFR 1610.1(d) の免除の説明）を印刷用のHTMLで作る。値は記録から渡す（州・県が無ければ state は N/A）。足りない項目があれば既定でエラー（allowDraft で下書き）。12歳以下の子供用は CPC が要るので作らない。返却: { packageId, overallStatus, counts, items, packageHtml }',
    GenerateGccCertificateRequestSchema.shape,
    async (opts) => {
      try {
        const result = await generateGccCertificate(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        // REST と同じ形（error・code・details）。REST の 422 / 400 に当たるものだけ code を付け、ほかは今までの文
        if (err instanceof TradeGccIncompleteError) {
          return { isError: true, content: [{ type: 'text', text: toolJson({ error: err.message, code: err.code, details: err.details }) }] };
        }
        if (err instanceof TradeInputError) {
          return { isError: true, content: [{ type: 'text', text: toolJson({ error: err.message, code: err.code }) }] };
        }
        return {
          isError: true,
          content: [{ type: 'text', text: `GCC certificate generation error: ${errorMessage(err) || err}` }],
        };
      }
    },
    {
      defaultEnabled: deferredDefault,
      keywords: ['GCC', 'General Certificate of Conformity', '一般適合証明書', '適合証明書', '16 CFR 1110', 'CPSC', 'eFiling', '通関保留', 'Disclaim'],
    },
  );
}
