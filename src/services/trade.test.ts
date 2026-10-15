import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clearCache } from '../cache.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { resetCrossBreakerForTest } from './cbp_cross.js';
import { resetHtsDataForTest } from './hts_data.js';
import { TradeInputError, checkProductCompliance, predictHtsCode, stripNegations, verifyHtsCode } from './trade.js';

// HTS の分類は、USITC の関税率表（全件）と CBP の分類判例から推測する。
// ここでは実際の関税率表と判例の応答の抜粋（test_fixtures）で、推測の組み立てを確かめる。精度は eval/hts_predict_cases.json と scripts/eval-hts-predict.ts で測る。
describe('HTS prediction and product compliance', () => {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = installExternalApiFixtures();
  });
  afterAll(() => restore?.());
  beforeEach(() => {
    clearCache();
    resetCrossBreakerForTest();
    resetHtsDataForTest();
  });

  describe('predictHtsCode', () => {
    it('classifies a toy from rulings that cite an obsolete subheading (9503.30 was merged into 9503.00) and picks the age line the ruling cited', async () => {
      const res = await predictHtsCode({
        productName: 'Wooden Building Blocks for Toddlers',
        description: 'Educational wooden puzzle block toy for children aged 3+. Non-toxic paint.',
        material: 'wood',
        targetAge: 'child',
      });
      expect(res.detectedSubheading).toBe('9503.00');
      expect(res.bestMatch.htsCode).toBe('9503.00.00.73');
      expect(res.bestMatch.description).toBe('3 to 12 years of age');
      expect(res.bestMatch.confidence).toBe('high');
      // 率はその行に無く、親の 9503.00.00 から継承（見出しの率を既定値にしない）
      expect(res.bestMatch.generalRate).toBe('Free');
      expect(res.bestMatch.rateFrom).toBe('9503.00.00');
      expect(res.bestMatch.cpsc?.certificateType).toBe('CCC');
      expect(res.bestMatch.cpsc?.eFilingRequired).toBe(true);
      expect(res.evidence.crossStatus).toBe('ok');
      expect(res.evidence.crossQuery).toBe('wooden building blocks'); // "for Toddlers" より前の名詞句で判例を引く
      expect(res.evidence.rulings.length).toBeGreaterThan(0);
      expect(res.evidence.rulings[0].url).toStartWith('https://rulings.cbp.gov/ruling/');
      expect(res.evidence.dataFetchedAt).toBeTruthy();
      expect(res.inputCompleteness).toBe('complete');
      expect(res.decisionPoints).toBeUndefined();
    });

    it('classifies tableware with a ruling-confirmed high confidence and flags FDA FD1 food contact', async () => {
      const res = await predictHtsCode({
        productName: 'Ceramic Coffee Mug',
        description: 'Stoneware coffee mug for kitchen use',
        material: 'ceramic',
        targetAge: 'adult',
        foodContact: true,
      });
      expect(res.detectedSubheading).toBe('6912.00');
      expect(res.bestMatch.confidence).toBe('high');
      expect(res.category).toContain('Ceramic tableware');
      expect(res.bestMatch.fda?.fdFlag).toBe('FD1');
      expect(res.bestMatch.fda?.possiblePrograms).toContain('FCS');
      expect(res.candidates[0].sources).toEqual(['hts-text', 'cbp-ruling']);
      expect(res.inputCompleteness).toBe('complete');
      expect(res.impactExplanation).toContain('十分に提供');
    });

    it('asks which official branch the product falls in when the candidates split, and offers the official wording as options', async () => {
      const res = await predictHtsCode({
        productName: 'Aerodynamic Bicycle Helmet',
        description: 'Protective adult cycling helmet with adjustable chin strap.',
        targetAge: 'adult',
      });
      expect(res.detectedSubheading).toBe('6506.10');
      expect(res.bestMatch.confidence).not.toBe('high');
      expect(res.missingInputs).toContain('classificationDetail');
      const dp = res.decisionPoints?.[0];
      expect(dp?.question).toContain('分類の確認');
      expect(dp?.question).toContain('Safety headgear');
      // 自転車用ヘルメットの枝は、"helmet" の語を含まない公式の説明（Athletic, recreational and sporting headgear）
      expect(dp?.options.some((o) => o.text.includes('Athletic, recreational and sporting headgear'))).toBe(true);
      expect(dp?.options.some((o) => o.text.includes('Motorcycle helmets'))).toBe(true);
      expect(dp?.options.every((o) => o.htsCode?.startsWith('6506.10'))).toBe(true);
      expect(res.clarifyingQuestions?.some((q) => q.includes('選択肢'))).toBe(true);
      expect(res.impactExplanation).toContain('classificationDetail');
    });

    it('asks only what the CPSC/FDA checks actually need, not what keywords suggest', async () => {
      // 食器: 食品接触の有無で FDA の扱いが分かれる。電池や年齢は聞かない
      const mug = await predictHtsCode({ productName: 'Travel Coffee Mug', description: 'Insulated mug for hot drinks' });
      expect(mug.missingInputs).toContain('foodContact');
      expect(mug.missingInputs).not.toContain('hasBattery');
      expect(mug.clarifyingQuestions?.some((q) => q.includes('飲食物') && q.includes('接触'))).toBe(true);
      // 家具: CPSC のリストに子供用家具として近いコードがあるので、年齢と素材だけを聞く。食品接触や分類の確認は聞かない
      const table = await predictHtsCode({ productName: 'Solid Oak Dining Table', description: 'Modern minimalist wooden dining table for home furniture.' });
      expect(table.bestMatch.htsCode).toStartWith('9403.60');
      expect(table.missingInputs).toEqual(['targetAge', 'material']);
      // CPSC・FDA のどちらの対象でもない電池では、何も聞かない
      const battery = await predictHtsCode({ productName: 'Rechargeable Power Bank', description: 'Portable lithium-ion battery pack with USB cable.' });
      expect(battery.missingInputs).toBeUndefined();
    });

    it('returns the cosmetic and food classes with their FDA flags', async () => {
      const cream = await predictHtsCode({ productName: 'Moisturizing Face Cream and Serum', description: 'Organic skincare lotion and beauty cosmetic cream.' });
      expect(cream.detectedSubheading).toBe('3304.99');
      expect(cream.bestMatch.fda?.fdFlag).toBe('FD2');
      expect(cream.bestMatch.fda?.possiblePrograms).toContain('COS');
      expect(cream.bestMatch.fda?.requiredActions?.some((a) => a.includes('MoCRA'))).toBe(true);

      const tea = await predictHtsCode({ productName: 'Matcha Green Tea Powder', description: 'Powdered green tea for beverage.' });
      expect(tea.bestMatch.htsCode).toStartWith('0902');
      expect(tea.bestMatch.fda?.fdFlag).toBe('FD4');
      expect(tea.bestMatch.fda?.priorNoticeRequired).toBe(true);
    });

    it('prefers the product over its parts and accessories unless the text mentions them', async () => {
      const battery = await predictHtsCode({ productName: 'Rechargeable Power Bank', description: 'Portable lithium-ion battery pack with USB cable.', hasBattery: true });
      expect(battery.detectedSubheading).toBe('8507.60');
      expect(battery.bestMatch.htsCode).toBe('8507.60.00.10');
    });

    it('tells the caller to translate when there is no English word, because the tariff and the rulings are English', async () => {
      const err = await predictHtsCode({ productName: '陶器のマグカップ', description: '食器' }).catch((e) => e);
      expect(err).toBeInstanceOf(TradeInputError);
      expect(err.message).toContain('英語');
      await expect(predictHtsCode({ productName: '   ' })).rejects.toBeInstanceOf(TradeInputError);
    });

    it('still answers from the tariff text alone when the ruling database is unreachable', async () => {
      const fixtureFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(raw).hostname === 'rulings.cbp.gov') return new Response('down', { status: 503 });
        return fixtureFetch(input as never, init);
      }) as typeof fetch;
      try {
        const res = await predictHtsCode({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', material: 'ceramic' });
        expect(res.evidence.crossStatus).toBe('unavailable');
        expect(res.evidence.crossNote).toContain('503');
        expect(res.evidence.rulings).toEqual([]);
        expect(res.detectedSubheading).toBe('6912.00');
        expect(res.bestMatch.confidence).not.toBe('high'); // 判例の裏付けが無いので high にはしない
        expect(res.candidates[0].sources).toEqual(['hts-text']);
      } finally {
        globalThis.fetch = fixtureFetch;
      }
    });

    it('does not search for words the description rules out ("Not ceramic, not a mug"), which pulled tableware into the candidates', async () => {
      expect(stripNegations('Round coaster. Not textile, not tin foil, not ceramic. Without battery, non-toxic paint.')).not.toMatch(/textile|foil|ceramic|battery|toxic/);
      expect(stripNegations('Round coaster of PU leather, 8.8 cm')).toBe('Round coaster of PU leather, 8.8 cm');
      const base = { productName: 'Wooden Building Blocks for Toddlers', description: 'Educational wooden toy blocks for children aged 3+.' };
      const withNegation = await predictHtsCode({ ...base, description: `${base.description} Not ceramic, not a mug, not a helmet.` });
      const without = await predictHtsCode(base);
      expect(withNegation.candidates.map((c) => c.htsCode.slice(0, 6))).toEqual(without.candidates.map((c) => c.htsCode.slice(0, 6)));
      expect(withNegation.candidates.some((c) => c.htsCode.startsWith('6912') || c.htsCode.startsWith('6506'))).toBe(false);
    });

    it('does not report an answer for nonsense with a confident label', async () => {
      const res = await predictHtsCode({ productName: 'Quantum Widget Model X', description: 'A completely novel gadget with no established classification.' });
      expect(res.bestMatch.confidence).toBe('low');
      expect(res.evidence.crossStatus).toBe('no_rulings');
      expect(res.missingInputs).toContain('classificationDetail');
    });
  });

  describe('verifyHtsCode', () => {
    it('confirms a 10-digit line and returns the inherited duty rate with its official position', async () => {
      const res = await verifyHtsCode({ htsCode: '6912.00.35.10', productDescription: 'Ceramic mug' });
      expect(res.verified).toBe(true);
      expect(res.matchLevel).toBe('exact');
      expect(res.generalRate).toBe('9.8%'); // 親の 6912.00.35 から継承（見出しの率ではない）
      expect(res.officialPath?.[0]).toContain('Ceramic tableware');
      expect(res.inputCompleteness).toBe('complete');
    });

    it('asks for the 10-digit subdivision when an 8-digit line has finer lines', async () => {
      const res = await verifyHtsCode({ htsCode: '6912.00.48', productDescription: 'Ceramic mug' });
      expect(res.verified).toBe(true);
      expect(res.inputCompleteness).toBe('partial');
      expect(res.missingInputs).toContain('hts10DigitSubdivision');
      expect(res.nearbyCandidates.length).toBeGreaterThan(0);
    });

    it('marks a code with only a matching 6-digit prefix as category-level, with nearby declarable lines', async () => {
      const res = await verifyHtsCode({ htsCode: '6912.00.9999', productDescription: 'Ceramic mug' });
      expect(res.verified).toBe(false);
      expect(res.matchLevel).toBe('6-digit-category');
      expect(res.nearbyCandidates.every((c) => c.htsCode.startsWith('6912.00'))).toBe(true);
    });

    it('reports a code that is not in the tariff', async () => {
      const res = await verifyHtsCode({ htsCode: '1234.56.7890', productDescription: 'Imaginary thing' });
      expect(res.matchLevel).toBe('unmatched');
      expect(res.missingInputs).toContain('validHtsCode');
    });
  });

  describe('checkProductCompliance', () => {
    it('classifies a toy from its name when no HTS code is given, and requires CPSC CCC and eFiling', async () => {
      const res = await checkProductCompliance({
        productName: 'Wooden Building Blocks for Toddlers',
        description: 'Educational wooden puzzle block toy for children aged 3+. Non-toxic paint.',
        targetAge: 'child',
        material: 'wood',
      });
      expect(res.product.htsCode).toBe('9503.00.00.73');
      expect(res.product.detectedCategory).toContain('Tricycles, scooters');
      expect(res.htsPrediction?.bestMatch.confidence).toBe('high');
      expect(res.htsVerification?.verified).toBe(true);
      expect(res.overallStatus).toBe('action_required');
      expect(res.cpsc?.certificateType).toBe('CCC');
      expect(res.cpsc?.eFilingRequired).toBe(true);
      expect(res.cpsc?.applicableRegulations.some((r) => r.cfr.includes('16 CFR 1501'))).toBe(true);
      expect(res.actionPlan.some((a) => a.includes('CCC'))).toBe(true);
      expect(res.fda?.fdaRegulatedLikely).toBe(false);
    });

    it('does not infer the target age or material from the text (the caller passes what it knows)', async () => {
      const res = await checkProductCompliance({
        productName: 'Wooden Building Blocks for Toddlers',
        description: 'Educational wooden puzzle block toy for children aged 3+.',
      });
      expect(res.product.targetAge).toBe('unknown');
      expect(res.product.material).toBeUndefined();
      expect(res.missingInputs).toContain('targetAge');
    });

    it('classifies a mug as tableware (not as food) and carries the FDA food-contact question', async () => {
      const res = await checkProductCompliance({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', targetAge: 'adult', material: 'ceramic' });
      expect(res.product.htsCode).toStartWith('6912');
      expect(res.fda?.fdFlag).toBe('FD1');
      expect(res.missingInputs).toEqual(['foodContact']); // CPSC の対象リストに無いので、カテゴリは聞かない
      expect(res.overallStatus).not.toBe('needs_more_info');
    });

    it('reports complete input when the caller gave everything the CPSC and FDA checks need', async () => {
      const res = await checkProductCompliance({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', targetAge: 'adult', material: 'ceramic', foodContact: true });
      expect(res.inputCompleteness).toBe('complete');
      expect(res.missingInputs).toBeUndefined();
      expect(res.clarifyingQuestions).toBeUndefined();
    });

    it('uses the explicit HTS code and evaluates it, and does not warn when it agrees with the predicted chapter', async () => {
      const res = await checkProductCompliance({
        htsCode: '6506103045',
        productName: 'Aerodynamic Bicycle Helmet',
        description: 'Protective adult cycling helmet with adjustable chin strap.',
        targetAge: 'adult',
      });
      expect(res.product.htsCode).toBe('6506103045');
      expect(res.cpsc?.certificateType).toBe('GCC');
      expect(res.cpsc?.eFilingRequired).toBe(true);
      expect(res.overallStatus).toBe('action_required');
      expect(res.actionPlan.some((a) => a.includes('GCC'))).toBe(true);
      expect(res.actionPlan.some((a) => a.includes('【HTSコード乖離注意】'))).toBe(false);
    });

    it('warns when the given HTS code is in a different chapter from the one predicted for the product', async () => {
      const res = await checkProductCompliance({
        productName: 'Wooden Building Blocks for Toddlers',
        description: 'Solid natural wood building blocks for 3-year-olds',
        material: 'wood',
        targetAge: 'child',
        htsCode: '8504.40.9580', // Chapter 85 (power supplies) is unrelated to a toy
      });
      expect(res.actionPlan[0]).toContain('【HTSコード乖離注意】');
      expect(res.impactExplanation).toContain('8504.40.9580');
      expect(res.impactExplanation).toContain('Chapter 85');
      expect(res.impactExplanation).toContain('Chapter 95');
    });

    it('flags FDA regulation for cosmetics and food', async () => {
      const cream = await checkProductCompliance({ productName: 'Moisturizing Face Cream and Serum', description: 'Organic skincare lotion and beauty cosmetic cream.' });
      expect(cream.fda?.fdaRegulatedLikely).toBe(true);
      expect(cream.fda?.possiblePrograms).toContain('COS');
      expect(cream.actionPlan.some((a) => a.includes('MoCRA'))).toBe(true);
      const tea = await checkProductCompliance({ productName: 'Japanese Green Tea', description: 'Sencha loose leaf green tea', htsCode: '0902.10.10.50' });
      expect(tea.fda?.fdFlag).toBe('FD4');
      expect(tea.fda?.priorNoticeMayApply).toBe(true);
      expect(tea.actionPlan.some((a) => a.includes('Prior Notice'))).toBe(true);
    });

    it('does not require a CPSC certificate for general adult furniture', async () => {
      const res = await checkProductCompliance({ productName: 'Solid Oak Dining Table', description: 'Modern minimalist wooden dining table for home furniture.', targetAge: 'adult', material: 'wood' });
      expect(res.product.htsCode).toStartWith('9403.60');
      expect(res.cpsc?.certificateRequired).not.toBe(true);
      expect(res.cpsc?.eFilingRequired).toBe(false);
      expect(res.fda?.fdaRegulatedLikely).toBe(false);
    });

    it('adds the hazmat note for lithium-ion batteries and the Reese’s Law note for button cells', async () => {
      const lithium = await checkProductCompliance({
        productName: 'Rechargeable Power Bank',
        description: 'Portable lithium-ion battery pack with USB cable.',
        targetAge: 'adult',
        hasBattery: true,
        batteryType: 'other',
      });
      expect(lithium.product.htsCode).toBe('8507.60.00.10');
      expect(lithium.actionPlan.some((a) => a.includes('UN3480') || a.includes('PHMSA'))).toBe(true);
      const button = await checkProductCompliance({
        productName: 'Rechargeable Power Bank',
        description: 'Portable lithium-ion battery pack with USB cable.',
        targetAge: 'adult',
        hasBattery: true,
        batteryType: 'button_coin',
      });
      expect(button.actionPlan.some((a) => a.includes('16 CFR 1263'))).toBe(true);
      expect(button.actionPlan.some((a) => a.includes('UN3480'))).toBe(false);
    });

    it('does not proceed with a default code when the classification is not settled: it returns the candidates and the question instead', async () => {
      const res = await checkProductCompliance({ productName: 'Quantum Widget Model X', description: 'A completely novel gadget with no established classification.' });
      expect(res.overallStatus).toBe('needs_more_info');
      expect(res.htsVerification).toBeUndefined();
      expect(res.product.htsCode).toBeUndefined();
      expect(res.htsPrediction?.bestMatch.confidence).toBe('low');
      expect(res.clarifyingQuestions?.length).toBeGreaterThan(0);
    });

    it('asks for an English description when the product text has no English word', async () => {
      const res = await checkProductCompliance({ productName: '陶器のマグカップ', description: '食器として使う陶器のマグカップ' });
      expect(res.overallStatus).toBe('needs_more_info');
      expect(res.clarifyingQuestions?.[0]).toContain('英語');
      expect(res.missingInputs).toEqual(['productDetails']);
    });

    it('tells the caller to translate a Japanese product page instead of reporting "nothing found"', async () => {
      const res = await checkProductCompliance({ productName: '【あさみみちゃん】ランダムPUレザーコースター', description: 'PUレザータイプのコースター 素材：PUレザー 直径8.8cm' });
      expect(res.overallStatus).toBe('needs_more_info');
      expect(res.clarifyingQuestions?.[0]).toContain('日本語');
      expect(res.clarifyingQuestions?.[0]).toContain('英語');
    });

    it('asks for the product name when there is nothing to classify', async () => {
      const res = await checkProductCompliance({});
      expect(res.overallStatus).toBe('needs_more_info');
      expect(res.clarifyingQuestions).toEqual(['商品名または商品説明を教えてください。']);
    });

    it('still runs the checks on an explicit HTS code when the product text is not English', async () => {
      const res = await checkProductCompliance({ productName: '陶器のマグカップ', htsCode: '6912.00.44.00', foodContact: true });
      expect(res.overallStatus).not.toBe('needs_more_info');
      expect(res.htsVerification?.verified).toBe(true);
      expect(res.fda?.fdFlag).toBe('FD1');
    });
  });
});
