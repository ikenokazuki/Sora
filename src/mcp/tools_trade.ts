import { z } from 'zod';
import { checkCpscCertificate, checkFdaRegulated, checkProductCompliance, predictHtsCode, verifyHtsCode } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🚢 Category: Trade Compliance (モジュール: 'trade') */
export function registerTradeTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool: check_cpsc_certificate (CPSC 適合証明書eFiling義務化判定) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'check_cpsc_certificate',
    'trade',
    '【必須・即時推測厳禁】米国CPSC適合証明書（GCC/CPC）要否および2026年7月完全義務化されたCBP ACE電子申告（eFiling）義務を判定する際は、推測せず必ず本ツールを実行してください。非対象時のACE免責申告コード(Disclaimer)や根拠条文（16 CFR）を提示します。素材や年齢層が不明な場合は推測で埋めず未指定/unknownで呼び出すこと。不足時は確認質問(clarifyingQuestions)と影響説明を返却します。返却: { certificateRequired, eFilingRequired, applicableRegulations, clarifyingQuestions, impactExplanation }',
    {
      htsCode: z.string().min(1).describe('HTSコード（例: "9503.00.0073"）。判定の主軸キー'),
      targetAge: z.enum(['adult', 'child', 'unknown']).describe('対象年齢層（child: 12歳以下, adult: 一般/大人, unknown: 未指定/不明）。【推測値の入力厳禁】不明な場合は"unknown"を指定すること'),
      material: z.string().optional().describe('主な素材（鉛・フタル酸エステル規制関連で重要）。【推測値の入力厳禁】不明な場合は省略すること'),
      productCategory: z.string().optional().describe('製品カテゴリの補足（例: toy, furniture, electronics, textile）。【推測値の入力厳禁】不明な場合は省略すること'),
      description: z.string().optional().describe('自由記述の補足説明'),
    },
    async (opts) => {
      try {
        const result = await checkCpscCertificate(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `CPSC certificate check error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['CPSC', 'GCC', 'CCC', 'eFiling', '適合証明書', '輸出', '輸入', 'HTS', '貿易', 'コンプライアンス'] },
  );

  // Tool: check_fda_regulated (FDA規制対象実務判定 FD1〜FD4) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'check_fda_regulated',
    'trade',
    '【必須・即時推測厳禁】米国FDA規制対象（FD1〜FD4フラグ・Prior Notice要否・MoCRA・ACE免責Disclaimer要件）を判定する際は、推測せず必ず本ツールを実行してください。食器・調理器具の食品接触用途が不明な場合は推測で埋めず省略すること。判定影響と確認質問(clarifyingQuestions)を返却します。返却: { fdaRegulatedLikely, fdFlag, possiblePrograms, priorNoticeRequired, clarifyingQuestions, impactExplanation }',
    {
      htsCode: z.string().min(1).describe('HTSコード（例: "3004.90.0000", "2106.90.9998"）'),
      productDescription: z.string().optional().describe('製品の自由記述説明（用途・素材等の補助情報）'),
      foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true: 接触, false: 非接触）。食器・調理器具(Chapter 39/69/70/73等)のFDA適用分岐に使用。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
    },
    async (opts) => {
      try {
        const result = checkFdaRegulated(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `FDA regulation check error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['FDA', '食品医薬品局', 'Prior Notice', '事前通知', 'FD Flag', 'MoCRA', '輸出', '輸入', 'HTS', '貿易', 'コンプライアンス'] },
  );

  // Tool: verify_hts_code (HTS/HSコード実在確認・検証) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'verify_hts_code',
    'trade',
    '【公式照合・推測厳禁】ユーザーから明示提示されたHTSコードを米国USITC公式データ(hts.usitc.gov)と照合し実在検証・正式品目名・一般関税率を取得します。HTS Revision 18等の大統領布告・通商法301条Chapter 99特別追加関税リスクも提示。6桁一致時は詳細仕様の確認質問(clarifyingQuestions)を返却します。返却: { verified, matchLevel, officialDescription, generalRate, clarifyingQuestions }',
    {
      htsCode: z.string().min(1).describe('検証したいHTSコード（例: "9503.00.0073"）。【推測入力禁止】ユーザーから明示提示された検証対象コードを指定すること'),
      productDescription: z.string().min(1).describe('製品の説明（素材・用途・機能・加工度合い等）。推論根拠の明示'),
    },
    async (opts) => {
      try {
        const result = await verifyHtsCode(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `HTS code verification error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['HTS', 'HSコード', '関税分類', 'USITC', '実在確認', '検証', '関税率', '輸出', '輸入', '貿易', 'コンプライアンス'] },
  );

  // Tool: predict_hts_code (商品情報からのHTS/HSコード推測エンジン) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'predict_hts_code',
    'trade',
    '【必須・即時推測厳禁】商品の英語の一般名・説明から、USITC公式HTS全件の階層つき全文検索とCBP分類判例を統合し、米国通関用10桁HTSコード候補、一般関税率、CPSC/FDA規制要件を推測します。日本語の商品は英訳して渡すこと（英語の語が無いとエラー）。【推測値のでっち上げ厳禁】素材・年齢・食品接触・電池等が不明な場合は勝手に埋めず省略すること。候補が公式の階層で分かれるときは分岐点の質問を返すので、ユーザーの答えをdescriptionに加えて再実行してください。返却: { detectedSubheading, bestMatch, candidates, decisionPoints, evidence, clarifyingQuestions, impactExplanation }',
    {
      productName: z.string().min(1).describe('商品の一般名（英語、宣伝文句やブランド名は除く。例: "Ceramic Coffee Mug", "Green Tea"）。日本語の商品は英訳して渡す'),
      description: z.string().optional().describe('商品の詳細説明、機能、用途など（英語）。事実だけを書く（"not ceramic" のような否定は検索語として扱われないので不要）'),
      material: z.string().optional().describe('主な素材（例: wood, ceramic, cotton, stainless steel, plastic）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
      productCategory: z.string().optional().describe('製品カテゴリ（例: Toys, Tableware, Apparel, Cosmetics, Food, Electronics）。【推測値の入力厳禁】不明な場合は省略すること'),
      targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下, adult: 大人/一般, unknown: 不明）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
      foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true/false）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
      hasBattery: z.boolean().optional().describe('電池・バッテリーを搭載しているか（true/false）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
    },
    async (opts) => {
      try {
        const result = await predictHtsCode(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `HTS code prediction error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['HTS推測', 'HS推測', '関税分類推測', 'コード検索', 'USITC', '輸出', '輸入', '貿易', 'コンプライアンス'] },
  );

  // Tool: check_product_compliance (商品統合コンプライアンス一括判定) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'check_product_compliance',
    'trade',
    '【必須・即時推測厳禁】商品ページURLや品名・素材から、HTS推測・実在検証・FDA実務判定・CPSC証明書および2026年7月eFiling義務を一連のパイプラインとして一括実行し、通関前アクションプランを含む総合診断レポートを返します。HTSコードを推定したい場合はhtsCodeを必ず省略（Soraが公式データと判例から特定）。品名・説明は英語の一般名で。未確定ならneeds_more_infoで質問を返す。返却: { product, overallStatus, summary, htsVerification, htsPrediction, fda, cpsc, clarifyingQuestions, impactExplanation, actionPlan }',
    {
      url: z.string().url().optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
      productName: z.string().optional().describe('商品の一般名（英語、宣伝文句やブランド名は除く。例: "Wooden Building Blocks", "Bicycle Helmet"）。日本語の商品は英訳して渡す'),
      description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など（英語）。事実だけを書く（"not ceramic" のような否定は検索語として扱われないので不要）'),
      htsCode: z.string().optional().describe('ユーザーからプロンプト内で明示的に提示された既知のHTSコード（指定時は最優先で検証）。【LLM自身の推測・候補値の入力厳禁！】HTSコードを推測・特定したい場合は必ず省略（未指定）にすること。未指定時にSoraが公式データと判例から特定します'),
      targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      material: z.string().optional().describe('主な素材（例: plastic, wood, metal, cotton）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      productCategory: z.string().optional().describe('製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, helmet）'),
      foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲み物や食べ物を入れる/口をつける等の食品接触用途, false: 装飾等の非食品接触用途）。Kitchenware等のカテゴリでFDA食品接触安全基準の判定要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か（true: ボタン電池・コイン電池またはリチウムイオン電池等を内蔵/同梱, false: 電池不使用）。Electronics等のカテゴリでCPSC規制カテゴリ判定・DOT/PHMSA危険物表示要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      batteryType: z.enum(['button_coin', 'other']).optional().describe('電池の種類（button_coin: ボタン電池・コイン電池, other: リチウムイオン電池等その他の電池）。hasBattery=trueの場合のみ意味を持つ。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
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
}
