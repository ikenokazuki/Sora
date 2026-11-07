import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clearCache } from '../cache.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { resetCrossBreakerForTest } from './cbp_cross.js';
import { resetHtsDataForTest } from './hts_data.js';
import {
  TradeGccIncompleteError,
  TradeInputError,
  checkCpscCertificate,
  checkFdaRegulated,
  checkProductCompliance,
  crossQueriesFor,
  detectProductAgeGender,
  generateGccCertificate,
  predictHtsCode,
  stripNegations,
  verifyHtsCode,
} from './trade.js';

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

    it('puts the explicit material first in the ruling queries ("plastic coaster" reaches 3924.10 rulings that "coaster" alone does not show)', async () => {
      expect(crossQueriesFor('PU Leather Coaster', 'plastic').slice(0, 2)).toEqual(['plastic leather coaster', 'plastic coaster']);
      expect(crossQueriesFor('PU Leather Coaster')[0]).toBe('pu leather coaster');
      expect(crossQueriesFor('Wooden Building Blocks for Toddlers', 'wood')).toContain('wood building blocks');
      // 実際に CBP へ出る照会語にも反映される
      const asked: string[] = [];
      const fixtureFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const u = new URL(raw);
        if (u.hostname === 'rulings.cbp.gov') asked.push(u.searchParams.get('term') ?? '');
        return fixtureFetch(input as never, init);
      }) as typeof fetch;
      try {
        await predictHtsCode({ productName: 'Ceramic Coffee Mug', description: 'Coffee mug', material: 'plastic' });
      } finally {
        globalThis.fetch = fixtureFetch;
      }
      expect(asked[0]).toBe('plastic coffee mug');
    });

    it('asks for the material when the answer is not high-confidence and none was given, and not otherwise', async () => {
      const unsure = await predictHtsCode({ productName: 'Aerodynamic Bicycle Helmet', description: 'Protective adult cycling helmet.' });
      expect(unsure.bestMatch.confidence).not.toBe('high');
      expect(unsure.missingInputs).toContain('material');
      expect(unsure.clarifyingQuestions?.some((q) => q.includes('material に英語で指定'))).toBe(true);
      const given = await predictHtsCode({ productName: 'Aerodynamic Bicycle Helmet', description: 'Protective adult cycling helmet.', material: 'plastic' });
      expect(given.clarifyingQuestions?.some((q) => q.includes('material に英語で指定'))).toBe(false);
      const sure = await predictHtsCode({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', targetAge: 'adult', foodContact: true });
      expect(sure.bestMatch.confidence).toBe('high');
      expect(sure.clarifyingQuestions?.some((q) => q.includes('material に英語で指定')) ?? false).toBe(false);
    });

    it('does not report an answer for nonsense with a confident label', async () => {
      const res = await predictHtsCode({ productName: 'Quantum Widget Model X', description: 'A completely novel gadget with no established classification.' });
      expect(res.bestMatch.confidence).toBe('low');
      expect(res.evidence.crossStatus).toBe('no_rulings');
      expect(res.missingInputs).toContain('classificationDetail');
    });
  });

  describe('age and gender line selection (10-digit choice inside the best subheading)', () => {
    it('reads the age and gender from the description text, facts first', () => {
      expect(detectProductAgeGender("Men's Cotton T-Shirt", 'adult')).toMatchObject({ men: true });
      expect(detectProductAgeGender("Women's Cotton T-Shirt", 'adult')).toMatchObject({ women: true });
      expect(detectProductAgeGender("Women's Cotton T-Shirt", 'adult').men).toBeUndefined(); // "women" contains "men"
      expect(detectProductAgeGender('blocks for children aged 3-plus.', 'child')).toMatchObject({ children: true, ageYears: 3 });
      expect(detectProductAgeGender('Soft blocks for babies under 3 years.', 'child')).toMatchObject({ infants: true });
      expect(detectProductAgeGender('Wooden blocks.', 'child')).toMatchObject({ children: true });
      expect(detectProductAgeGender('Wooden blocks.', undefined).children).toBeUndefined();
    });

    it('picks the "3 to 12 years" line for a toy described as aged 3+', async () => {
      const res = await predictHtsCode({
        productName: 'Wooden Building Blocks for Toddlers',
        description: 'Educational wooden puzzle block toy for children aged 3-plus. Non-toxic paint.',
        targetAge: 'child',
        material: 'wood',
      });
      expect(res.detectedSubheading).toBe('9503.00');
      expect(res.bestMatch.htsCode).toBe('9503.00.00.73');
      expect(res.bestMatch.confidence).not.toBe('low');
      expect(res.bestMatch.reason).toContain('3歳以上');
    });

    it('picks the matching gender line for apparel when the text says it', async () => {
      // 白いTシャツ（品名に white が無いので暫定は "all white" の行だが、男女の区分は men's の枝）
      const men = await predictHtsCode({ productName: "Men's Cotton T-Shirt", description: 'Short sleeve knitted crew neck tee, 100% cotton', targetAge: 'adult' });
      expect(men.bestMatch.htsCode.startsWith('6109.10')).toBe(true);
      expect(men.bestMatch.path?.join(' ')).toMatch(/Men's/);
      expect(men.bestMatch.path?.join(' ')).not.toMatch(/Women's/);
      const women = await predictHtsCode({ productName: "Women's Cotton T-Shirt", description: 'Short sleeve knitted crew neck tee for women, 100% cotton', targetAge: 'adult' });
      expect(women.bestMatch.description).toMatch(/Women's/);
    });

    it('keeps the adult apparel line when targetAge is adult (the age/gender change is not part of v4.1)', async () => {
      const input = { productName: "Men's Thermal Undershirt", description: 'cotton knit thermal undershirt', material: 'cotton' };
      const adult = await predictHtsCode({ ...input, targetAge: 'adult' });
      const plain = await predictHtsCode(input);
      expect(adult.bestMatch.htsCode).toBe('6109.10.00.11');
      expect(plain.bestMatch.htsCode).toBe('6109.10.00.11');
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
  });

  describe('Practical CPSC & FDA regulatory rules (2016 Enforcement Discretion, Reese’s Law, Disclaim A/B, FCS)', () => {
    it('exempts adult apparel made solely of 16 CFR 1610.1(d)(2) fibers from GCC & eFiling (ACE Disclaim B / IUC 130.006)', async () => {
      const poly = await checkCpscCertificate({
        htsCode: '6109.90.10.07',
        targetAge: 'adult',
        material: '100% polyester',
      });
      expect(poly.certificateRequired).toBe(false);
      expect(poly.certificateType).toBe('none');
      expect(poly.eFilingRequired).toBe(false);
      expect(poly.disclaimerCodeHint).toContain('B');
      expect(poly.disclaimerCodeHint).toContain('130.006');
      expect(poly.testingExemption?.exempt).toBe(true);
      expect(poly.testingExemption?.citation).toBe('16 CFR 1610.1(d)(2)');
      expect(poly.testingExemption?.enforcementDiscretion).toBe(true);
    });

    it('exempts adult plain-surface apparel >= 2.6 oz/sq yd (88.2 g/m²) under 16 CFR 1610.1(d)(1) & Enforcement Discretion', async () => {
      const heavyCottonTee = await checkCpscCertificate({
        htsCode: '6109.10.00.12',
        targetAge: 'adult',
        material: '100% cotton',
        fabricSurface: 'plain',
        fabricWeightGsm: 180,
      });
      expect(heavyCottonTee.certificateRequired).toBe(false);
      expect(heavyCottonTee.certificateType).toBe('none');
      expect(heavyCottonTee.eFilingRequired).toBe(false);
      expect(heavyCottonTee.disclaimerCodeHint).toContain('B');
      expect(heavyCottonTee.disclaimerCodeHint).toContain('130.006');
      expect(heavyCottonTee.testingExemption?.exempt).toBe(true);
      expect(heavyCottonTee.testingExemption?.citation).toBe('16 CFR 1610.1(d)(1)');
      expect(heavyCottonTee.testingExemption?.enforcementDiscretion).toBe(true);
    });

    it('requires GCC and eFiling for non-exempt adult apparel (cotton-blend raised-fiber fleece or lightweight plain cotton < 88.2 g/m²)', async () => {
      const raisedHoodie = await checkCpscCertificate({
        htsCode: '6110.20.20.79',
        targetAge: 'adult',
        material: '80% cotton 20% polyester',
        fabricSurface: 'raised',
        fabricWeightGsm: 320,
      });
      expect(raisedHoodie.certificateRequired).toBe(true);
      expect(raisedHoodie.certificateType).toBe('GCC');
      expect(raisedHoodie.eFilingRequired).toBe(true);
      expect(raisedHoodie.testingExemption?.exempt).toBe(false);

      const sheerCotton = await checkCpscCertificate({
        htsCode: '6109.10.00.12',
        targetAge: 'adult',
        material: '95% polyester 5% spandex', // spandex disqualifies (d)(2), < 2.6 oz disqualifies (d)(1)
        fabricSurface: 'plain',
        fabricWeightOzPerSqYd: 2.1,
      });
      expect(sheerCotton.certificateRequired).toBe(true);
      expect(sheerCotton.certificateType).toBe('GCC');
      expect(sheerCotton.eFilingRequired).toBe(true);
      expect(sheerCotton.testingExemption?.exempt).toBe(false);
    });

    it('excludes standalone adult hats, gloves, and footwear under 16 CFR 1610.1(c) (ACE Disclaim A)', async () => {
      const cap = await checkCpscCertificate({
        htsCode: '6505.00.80.90',
        targetAge: 'adult',
        material: '100% cotton',
        productCategory: 'Clothing',
        description: 'Adult embroidered baseball cap hat',
      });
      expect(cap.certificateRequired).toBe(false);
      expect(cap.certificateType).toBe('none');
      expect(cap.eFilingRequired).toBe(false);
      expect(cap.disclaimerCodeHint).toContain('A');
    });

    it('still requires CPC (CCC) and eFiling for children’s apparel even when fabric meets 16 CFR 1610.1(d)', async () => {
      const kidsPolyTee = await checkCpscCertificate({
        htsCode: '6109.90.10.47',
        targetAge: 'child',
        material: '100% polyester',
      });
      expect(kidsPolyTee.certificateRequired).toBe(true);
      expect(kidsPolyTee.certificateType).toBe('CCC');
      expect(kidsPolyTee.eFilingRequired).toBe(true);
      expect(kidsPolyTee.testingExemption?.exempt).toBe(true);
      expect(kidsPolyTee.testingExemption?.enforcementDiscretion).toBe(false);
    });

    it('returns ACE Disclaim A (certificateRequired: false) for adult items in children-only CPSC categories (collectibles, jewelry, shoes)', async () => {
      const adultFigure = await checkCpscCertificate({
        htsCode: '9503.00.00.90',
        targetAge: 'adult',
        material: 'PVC plastic',
        description: 'Adult collector scale statue figure (ages 15+)',
      });
      expect(adultFigure.certificateRequired).toBe(false);
      expect(adultFigure.certificateType).toBe('none');
      expect(adultFigure.eFilingRequired).toBe(false);
      expect(adultFigure.disclaimerCodeHint).toContain('A');

      const adultShoes = await checkCpscCertificate({
        htsCode: '6402.99.31.65',
        targetAge: 'adult',
        material: 'rubber and synthetic upper',
      });
      expect(adultShoes.certificateRequired).toBe(false);
      expect(adultShoes.certificateType).toBe('none');
      expect(adultShoes.eFilingRequired).toBe(false);
    });

    it('applies cross-cutting 16 CFR Part 1263 (Reese’s Law / ANSI UL 4200A) GCC + eFiling to button/coin-cell consumer products without overwriting HTS to 8506', async () => {
      const penlight = await checkProductCompliance({
        htsCode: '9405.42.84.40', // portable LED lamp / light stick in fixture chapter 9405
        productName: 'Official Concert LED Penlight',
        description: 'Handheld LED concert light stick powered by 3x LR44 button cell batteries',
        targetAge: 'adult',
        material: 'ABS plastic',
        hasBattery: true,
        batteryType: 'button_coin',
      });
      expect(penlight.product.htsCode).toBe('9405.42.84.40');
      expect(penlight.cpsc?.certificateRequired).toBe(true);
      expect(penlight.cpsc?.certificateType).toBe('GCC');
      expect(penlight.cpsc?.eFilingRequired).toBe(true);
      expect(penlight.cpsc?.applicableRegulations.some((r) => r.cfr.includes('16 CFR 1263'))).toBe(true);

      // Children's toy (9503, child) with button cell remains CCC under ASTM F963 (16 CFR 1263.1(d) toy exemption)
      const childToy = await checkCpscCertificate({
        htsCode: '9503.00.00.73',
        targetAge: 'child',
        material: 'plastic',
        hasBattery: true,
        batteryType: 'button_coin',
      });
      expect(childToy.certificateType).toBe('CCC');
      expect(childToy.eFilingRequired).toBe(true);
    });

    it('clarifies FDA FCS tableware is exempt from Prior Notice under 21 CFR 1.276(b)(5) while flagging dual FDA + CPSC CCC for children’s mugs', async () => {
      const adultMugFda = checkFdaRegulated({
        htsCode: '6912.00.44.00',
        foodContact: true,
      });
      expect(adultMugFda.fdFlag).toBe('FD1');
      expect(adultMugFda.priorNoticeMayApply).toBe(false);
      expect(adultMugFda.requiredActions?.[0]).toContain('21 CFR');
      expect(adultMugFda.requiredActions?.[0]).toContain('Prior Notice');

      const childMug = await checkProductCompliance({
        htsCode: '6912.00.44.00',
        productName: 'Kids Cartoon Ceramic Mug',
        description: 'Small stoneware drinking mug designed for children aged 4+',
        targetAge: 'child',
        material: 'ceramic',
        foodContact: true,
      });
      expect(childMug.fda?.fdaRegulatedLikely).toBe(true);
      expect(childMug.fda?.fdFlag).toBe('FD1');
      expect(childMug.cpsc?.certificateRequired).toBe(true);
      expect(childMug.cpsc?.certificateType).toBe('CCC');
      expect(childMug.cpsc?.eFilingRequired).toBe(true);
    });
  });

  describe('generateGccCertificate & checkProductCompliance GCC integration', () => {
    const sampleCertifier = {
      name: 'Acme Imports LLC',
      address: '100 Example Street, Anytown, CA, United States',
      email: 'compliance@acme-imports.test',
      phone: '+1-213-555-0199',
    };
    const sampleCustodian = {
      name: 'Compliance Manager',
      address: '100 Example Street, Anytown, CA, United States',
      email: 'qa-records@acme-imports.test',
      phone: '+1-202-555-0103',
    };

    it('generates a complete 7-element 16 CFR 1110.11 GCC (JSON, Markdown, print HTML) for a regulated SKU', async () => {
      const res = await generateGccCertificate({
        productName: 'Official Concert LED Penlight',
        sku: 'PEN-2026-TOUR',
        brand: 'Acme',
        modelOrBatch: 'LOT-2026-09A',
        description: 'Handheld LED concert penlight using LR44 button cells',
        htsCode: '9405.42.84.40',
        targetAge: 'adult',
        material: 'ABS plastic',
        hasBattery: true,
        batteryType: 'button_coin',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
        manufacture: {
          date: '2026-09',
          city: 'Shenzhen, Guangdong',
          country: 'China',
          manufacturerName: 'Acme Electronics Factory',
        },
        testing: {
          date: '2026-09-18',
          location: 'Shenzhen, China',
          laboratoryName: 'Acme Test Lab',
          laboratoryAddress: '2 Example Road, Shenzhen, Guangdong, China',
          laboratoryPhone: '+1-202-555-0104',
          reportNumber: 'TR-0001',
        },
      });

      expect(res.mode).toBe('single_product');
      expect(res.overallStatus).toBe('ready');
      expect(res.counts.gccGenerated).toBe(1);
      const item = res.items[0];
      expect(item.status).toBe('generated');
      expect(item.missingFields).toEqual([]);
      expect(item.aceFilingGuidance.eFilingRequired).toBe(true);
      expect(item.statutoryFields?.productIdentification.sku).toBe('PEN-2026-TOUR');
      expect(item.statutoryFields?.citations.some((c) => c.includes('16 CFR 1263'))).toBe(true);
      expect(item.statutoryFields?.certifier?.name).toBe('Acme Imports LLC');
      expect(item.statutoryFields?.recordCustodian?.email).toBe('qa-records@acme-imports.test');
      expect(item.statutoryFields?.manufactureDateAndPlace).toMatchObject({
        date: '2026-09',
        city: 'Shenzhen, Guangdong',
        country: 'China',
      });
      expect(item.statutoryFields?.testingLaboratory.name).toContain('Acme Test Lab');
      expect(item.certificateMarkdown).toContain('General Certificate of Conformity');
      expect(item.certificateMarkdown).toContain('PEN-2026-TOUR');
      expect(item.certificateMarkdown).toContain('16 CFR 1263');
      expect(res.packageHtml).toContain('<!DOCTYPE html>');
      expect(res.packageHtml).toContain('@media print');
    });

    it('fails closed with TradeGccIncompleteError by default when statutory fields are missing, and returns draft_needs_info only with allowDraft: true', async () => {
      const incompleteInput = {
        productName: 'Tour Brushed Fleece Pullover Hoodie',
        sku: 'HD-COT-BLK-M',
        htsCode: '6109.10.00.12',
        targetAge: 'adult' as const,
        material: '80% cotton 20% polyester',
        fabricSurface: 'raised' as const,
        fabricWeightGsm: 310,
      };

      let caught: unknown;
      try {
        await generateGccCertificate(incompleteInput);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradeGccIncompleteError);
      const incompleteErr = caught as TradeGccIncompleteError;
      expect(incompleteErr.code).toBe('MISSING_REQUIRED_GCC_FIELDS');
      expect(incompleteErr.missingFields).toContain('certifier.name');
      expect(incompleteErr.missingFields).toContain('certifier.email');
      expect(incompleteErr.missingFields).toContain('recordCustodian.email');
      expect(incompleteErr.missingFields).toContain('manufacture.date');
      expect(incompleteErr.missingFields).toContain('testing.laboratoryName');

      const res = await generateGccCertificate({
        ...incompleteInput,
        allowDraft: true,
      });

      expect(res.overallStatus).toBe('partial_or_draft');
      const item = res.items[0];
      expect(item.status).toBe('draft_needs_info');
      expect(item.missingFields).toContain('certifier.name');
      expect(item.missingFields).toContain('certifier.address');
      expect(item.missingFields).toContain('certifier.email');
      expect(item.missingFields).toContain('certifier.phone');
      expect(item.missingFields).toContain('recordCustodian.name');
      expect(item.missingFields).toContain('recordCustodian.email');
      expect(item.missingFields).toContain('manufacture.date');
      expect(item.missingFields).toContain('manufacture.city');
      expect(item.missingFields).toContain('manufacture.country');
      expect(item.missingFields).toContain('testing.date');
      expect(item.missingFields).toContain('testing.laboratoryName');
      expect(item.certificateMarkdown).toContain('DRAFT');
    });

    it('rejects sample, placeholder, or uncertain values in statutory GCC fields even when allowDraft is true', async () => {
      let caught: unknown;
      try {
        await generateGccCertificate({
          productName: 'Tour Brushed Fleece Pullover Hoodie',
          sku: 'HD-COT-BLK-M',
          htsCode: '6109.10.00.12',
          targetAge: 'adult',
          material: '100% cotton',
          fabricSurface: 'raised',
          fabricWeightGsm: 320,
          allowDraft: true,
          certifier: {
            name: 'Sample Exporter Inc.',
            address: '100 Example Street, Anytown, CA',
            email: 'compliance@acme-imports.example.com',
            phone: '+81-3-0000-0000',
          },
          manufacture: {
            date: 'TBD',
            city: '仮置き工場',
            country: 'Unknown',
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradeInputError);
      const inputErr = caught as TradeInputError;
      expect(inputErr.code).toBe('UNVERIFIED_PLACEHOLDER_INPUT');
      expect(inputErr.message).toContain('certifier.name');
      expect(inputErr.message).toContain('certifier.email');
      expect(inputErr.message).toContain('certifier.phone');
      expect(inputErr.message).toContain('manufacture.date');
      expect(inputErr.message).toContain('manufacture.city');
      expect(inputErr.message).toContain('manufacture.country');
    });

    it('uses pre-configured SORA_GCC_CERTIFIER_* and SORA_GCC_CUSTODIAN_* environment defaults without requiring LLM lookup', async () => {
      const envKeys = [
        'SORA_GCC_CERTIFIER_NAME',
        'SORA_GCC_CERTIFIER_ADDRESS',
        'SORA_GCC_CERTIFIER_EMAIL',
        'SORA_GCC_CERTIFIER_PHONE',
        'SORA_GCC_CUSTODIAN_NAME',
      ] as const;
      const prev: Record<string, string | undefined> = {};
      for (const k of envKeys) prev[k] = process.env[k];

      process.env.SORA_GCC_CERTIFIER_NAME = 'Acme Imports LLC';
      process.env.SORA_GCC_CERTIFIER_ADDRESS = '100 Example Street, Anytown, CA, United States';
      process.env.SORA_GCC_CERTIFIER_EMAIL = 'compliance@acme-imports.test';
      process.env.SORA_GCC_CERTIFIER_PHONE = '+1-202-555-0101';
      process.env.SORA_GCC_CUSTODIAN_NAME = 'Compliance Manager, Acme Imports LLC';

      try {
        const res = await generateGccCertificate({
          productName: 'Adult Road Bicycle Helmet',
          sku: 'HLM-ENV-01',
          htsCode: '6506.10.60.45',
          targetAge: 'adult',
          material: 'polycarbonate',
          manufacture: { date: '2026-10', city: 'Taichung', country: 'Taiwan' },
          testing: {
            date: '2026-10-12',
            location: 'Osaka, Japan',
            laboratoryName: 'Acme Test Lab Osaka',
            reportNumber: 'TR-0004',
          },
        });
        expect(res.overallStatus).toBe('ready');
        expect(res.items[0].status).toBe('generated');
        expect(res.items[0].statutoryFields?.certifier).toEqual({
          name: 'Acme Imports LLC',
          address: '100 Example Street, Anytown, CA, United States',
          email: 'compliance@acme-imports.test',
          phone: '+1-202-555-0101',
        });
        expect(res.items[0].statutoryFields?.recordCustodian).toEqual({
          name: 'Compliance Manager, Acme Imports LLC',
          address: '100 Example Street, Anytown, CA, United States',
          email: 'compliance@acme-imports.test',
          phone: '+1-202-555-0101',
        });
      } finally {
        for (const k of envKeys) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
      }
    });

    it('refuses to issue a GCC when a product is for children <= 12 (returns cpc_required_instead)', async () => {
      const res = await generateGccCertificate({
        productName: 'Kids Plush Mascot Doll',
        sku: 'PLUSH-KIDS-01',
        htsCode: '9503.00.00.73',
        targetAge: 'child',
        material: 'polyester plush',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
      });

      expect(res.overallStatus).toBe('cpc_required');
      expect(res.warnings?.length).toBe(1);
      expect(res.warnings?.[0]).toContain('CPC');
      expect(res.warnings?.[0]).toContain('非対応');
      expect(res.items[0].status).toBe('cpc_required_instead');
      expect(res.items[0].warnings?.length).toBe(1);
      expect(res.items[0].aceFilingGuidance.certificateType).toBe('CCC');
      expect(res.items[0].aceFilingGuidance.eFilingRequired).toBe(true);
    });

    it('generates a multi-SKU post-shipment Courier / Customs Clearance Package (Page 1 Cover Sheet + per-SKU GCCs & Fabric Exemption Statement)', async () => {
      const pkg = await generateGccCertificate({
        orderNumber: 'SHOP-ORD-10492',
        awbNumber: 'TEST-AWB-0003',
        carrier: 'FedEx',
        invoiceNumber: 'INV-2026-10492',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
        items: [
          {
            sku: 'TEE-WHT-L',
            productName: "Men's Heavyweight Plain Cotton T-Shirt",
            description: 'Short sleeve crew neck plain jersey t-shirt',
            htsCode: '6109.10.00.12',
            targetAge: 'adult',
            material: '100% cotton',
            fabricSurface: 'plain',
            fabricWeightGsm: 190,
            manufacture: { date: '2026-08', city: 'Osaka', country: 'Japan' },
          },
          {
            sku: 'HD-FLC-XL',
            productName: 'Unisex Cotton-Blend Brushed Fleece Hoodie',
            description: 'Pullover sweatshirt hoodie with brushed fleece interior',
            htsCode: '6109.10.00.12',
            targetAge: 'adult',
            material: '80% cotton 20% polyester',
            fabricSurface: 'raised',
            fabricWeightGsm: 320,
            manufacture: { date: '2026-08', city: 'Suzhou, Jiangsu', country: 'China' },
            testing: {
              date: '2026-08-20',
              location: 'Shanghai, China',
              laboratoryName: 'Acme Test Lab Shanghai',
              reportNumber: 'TR-0002',
            },
          },
          {
            sku: 'PEN-LED-02',
            productName: 'LED Concert Penlight Stick',
            description: 'Portable LED light stick powered by coin cell battery',
            htsCode: '9405.42.84.40',
            targetAge: 'adult',
            material: 'ABS plastic',
            hasBattery: true,
            batteryType: 'button_coin',
            manufacture: { date: '2026-09', city: 'Shenzhen', country: 'China' },
            testing: {
              date: '2026-09-10',
              location: 'Shenzhen, China',
              laboratoryName: 'Acme Test Lab Shenzhen',
              reportNumber: 'TR-0003',
            },
          },
          {
            sku: 'ACR-STD-05',
            productName: 'Character Acrylic Stand Figure (Adult Collector)',
            description: 'Decorative desktop acrylic stand for adult collectors aged 15+',
            htsCode: '9503.00.00.90',
            targetAge: 'adult',
            material: 'PMMA acrylic plastic',
          },
          {
            sku: 'MUG-CER-01',
            productName: 'Logo Stoneware Coffee Mug',
            description: 'Ceramic coffee mug for hot beverages',
            htsCode: '6912.00.44.00',
            targetAge: 'adult',
            material: 'ceramic',
            foodContact: true,
            manufacture: {
              date: '2026-07',
              city: 'Tajimi, Gifu',
              country: 'Japan',
              manufacturerName: 'Acme Ceramics Factory',
            },
          },
        ],
      });

      expect(pkg.mode).toBe('order_package');
      expect(pkg.overallStatus).toBe('ready');
      expect(pkg.counts).toEqual({
        totalItems: 5,
        gccGenerated: 2,
        draftNeedsInfo: 0,
        disclaimBExempt: 1,
        disclaimAExempt: 2,
        cpcRequired: 0,
      });

      expect(pkg.items[0].status).toBe('exempt_disclaim_b');
      expect(pkg.items[0].aceFilingGuidance.disclaimCode).toBe('B');
      expect(pkg.items[0].aceFilingGuidance.intendedUseCode).toBe('130.006');
      expect(pkg.items[1].status).toBe('generated');
      expect(pkg.items[2].status).toBe('generated');
      expect(pkg.items[3].status).toBe('exempt_no_gcc_needed');
      expect(pkg.items[3].aceFilingGuidance.disclaimCode).toBe('A');
      expect(pkg.items[4].status).toBe('exempt_no_gcc_needed');
      expect(pkg.items[4].aceFilingGuidance.fdaNote).toContain('21 CFR');

      // Cover sheet + individual SKU documents + print page breaks
      expect(pkg.packageMarkdown).toContain('SHOP-ORD-10492');
      expect(pkg.packageMarkdown).toContain('TEST-AWB-0003');
      expect(pkg.packageMarkdown).toContain('130.006');
      expect(pkg.packageHtml).toContain('page-break-before: always');
      expect(pkg.packageHtml).toContain('HD-FLC-XL');
      expect(pkg.packageHtml).toContain('PEN-LED-02');
    });

    it('strictly HTML-escapes all untrusted product, order, and party strings in certificateHtml and packageHtml (XSS prevention)', async () => {
      const xss = `<script>alert("xss")</script><img src=x onerror=alert('1')>&"`;
      const res = await generateGccCertificate({
        orderNumber: `ORD-${xss}`,
        awbNumber: `AWB-${xss}`,
        certifier: {
          name: `Certifier ${xss}`,
          address: `Addr ${xss}`,
          email: 'sec@acme-imports.test',
          phone: '+1-213-555-0144',
        },
        recordCustodian: {
          name: `Custodian ${xss}`,
          address: `CustAddr ${xss}`,
          email: 'rec@acme-imports.test',
          phone: '+1-213-555-0145',
        },
        items: [
          {
            sku: `SKU-${xss}`,
            productName: `Helmet ${xss}`,
            description: `Adult cycling helmet ${xss}`,
            htsCode: '6506.10.60.45',
            targetAge: 'adult',
            material: 'polycarbonate',
            manufacture: { date: '2026-05', city: `City ${xss}`, country: 'Japan' },
            testing: { date: '2026-05-10', location: `LabLoc ${xss}`, laboratoryName: `Lab ${xss}` },
          },
        ],
      });

      expect(res.packageHtml).not.toContain('<script>');
      expect(res.packageHtml).not.toContain('<img src=x');
      expect(res.packageHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(res.items[0].certificateHtml).not.toContain('<script>');
      expect(res.items[0].certificateHtml).toContain('&amp;&quot;');
    });
  });
});

describe('checkCpscCertificate on a code the CPSC list does not carry', () => {
  it('does not ask for a productCategory, which no input could use', async () => {
    const res = await checkCpscCertificate({ htsCode: '7318.15.0000', targetAge: 'adult' });
    expect(res.certificateRequired).toBe('unknown');
    expect(res.missingInputs).toBeUndefined();
    expect(res.clarifyingQuestions).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('productCategory');
    // 案内は CPSC への個別確認と免責コードの申告に向かう
    expect(res.nextActions.join('')).toContain('CPSC公式に個別確認');
    expect(res.disclaimerCodeHint).toContain('A');
  });

  it('says "CPSC公式に個別確認" once, in nextActions, and keeps the other fields to their own point', async () => {
    const res = await checkCpscCertificate({ htsCode: '7318.15.0000', targetAge: 'adult' });
    expect(JSON.stringify(res).split('個別確認').length - 1).toBe(1);
    expect(res.nextActions.join('')).toContain('CPSC公式に個別確認');
    expect(res.missingInfo.join('')).toContain('証明書不要を意味しません');
    expect(res.impactExplanation).toContain('12歳以下');
  });

  it('gives the same answer when the removed productCategory and description are sent anyway', async () => {
    const plain = await checkCpscCertificate({ htsCode: '7318.15.0000', targetAge: 'adult' });
    const extra = await checkCpscCertificate({ htsCode: '7318.15.0000', targetAge: 'adult', productCategory: 'toy', description: 'a toy' } as never);
    expect(extra).toEqual(plain);
  });

  it('keeps asking for targetAge and material on a listed code', async () => {
    const res = await checkCpscCertificate({ htsCode: '9503.00.0073', targetAge: 'unknown' });
    expect(res.missingInputs).toEqual(['targetAge', 'material']);
  });
});
