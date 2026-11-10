import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clearCache } from '../cache.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { resetCrossBreakerForTest } from './cbp_cross.js';
import { CPSC_HTS_LIST } from './cpsc_hts_data.js';
import { resetHtsDataForTest } from './hts_data.js';
import {
  TradeInputError,
  checkCpscCertificate,
  checkFdaRegulated,
  checkProductCompliance,
  crossQueriesFor,
  detectProductAgeGender,
  findCpscListCategory,
  parseFiberContent,
  predictHtsCode,
  section1610cExclusionFor,
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
        expect(res.bestMatch.confidence).toBe('low'); // 判例の票が無い全文検索だけの推測は low（medium でも dev の的中が半分）
        expect(res.candidates[0].sources).toEqual(['hts-text']);
        // 総合判定は推測のコードで先へ進まず、聞き返す（判例が無いことと、htsCode を渡せば進むことを伝える）
        const compliance = await checkProductCompliance({ productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', material: 'ceramic', foodContact: true });
        expect(compliance.overallStatus).toBe('needs_more_info');
        expect(compliance.fda).toBeUndefined();
        expect(compliance.clarifyingQuestions?.some((q) => q.includes('CROSS') && q.includes('htsCode'))).toBe(true);
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

    it('adds the Reese’s Law note for button_coin without hasBattery, and rejects hasBattery: false with button_coin before any scrape or prediction', async () => {
      const alone = await checkProductCompliance({
        productName: 'Rechargeable Power Bank',
        description: 'Portable lithium-ion battery pack with USB cable.',
        targetAge: 'adult',
        batteryType: 'button_coin',
      });
      expect(alone.actionPlan.some((a) => a.includes('16 CFR 1263'))).toBe(true);
      // url だけなら、読めなくても「情報不足」の答えが返るだけ。矛盾は先に止まる
      await expect(checkProductCompliance({ url: 'http://127.0.0.1:1/product', hasBattery: false, batteryType: 'button_coin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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

    it('ignores GCC arguments: no gcc field and no sku or brand on product', async () => {
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

    it('exempts adult plain-surface apparel >= 2.6 oz/sq yd under 16 CFR 1610.1(d)(1) & Enforcement Discretion', async () => {
      const heavyCottonTee = await checkCpscCertificate({
        htsCode: '6109.10.00.12',
        targetAge: 'adult',
        material: '100% cotton',
        fabricSurface: 'plain',
        fabricWeightOzPerSqYd: 5.3,
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

    it('requires GCC and eFiling for non-exempt adult apparel (cotton-blend raised-fiber fleece or lightweight plain fabric < 2.6 oz/sq yd)', async () => {
      const raisedHoodie = await checkCpscCertificate({
        htsCode: '6110.20.20.79',
        targetAge: 'adult',
        material: '80% cotton 20% polyester',
        fabricSurface: 'raised',
        fabricWeightOzPerSqYd: 9.4,
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

    describe('CPSC list categories and button cells (no age table)', () => {
      it('requires a GCC for adult items on children’s and mattress codes instead of Disclaim A (review probes for C3 and M13)', async () => {
        for (const [htsCode, material] of [['9403.50.90.80', 'wood'], ['9503.00.00.90', 'plastic'], ['9404.29.90.95', 'polyurethane foam']] as const) {
          const res = await checkCpscCertificate({ htsCode, targetAge: 'adult', material });
          expect(res.certificateRequired, htsCode).toBe(true);
          expect(res.certificateType, htsCode).toBe('GCC');
          expect(res.disclaimerCodeHint, htsCode).toBeUndefined();
        }
        const unknownAge = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge: 'unknown', material: 'plastic' });
        expect(unknownAge.impactExplanation).not.toContain('Disclaim');
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
        for (const targetAge of ['adult', 'unknown'] as const) {
          const res = await checkCpscCertificate({ htsCode: '9403.60.80.40', targetAge, material: 'wood' });
          expect(res.certificateRequired, targetAge).toBe('unknown');
          expect(res.disclaimerCodeHint, targetAge).toBeUndefined();
          expect(res.nextActions.join(''), targetAge).not.toContain('A または B');
          expect(res.nextActions.join(''), targetAge).toContain('Disclaim A。Disclaimer には Intended Use Code も要ります');
        }
      });

      it('answers a child on a near code like a child on an unlisted code (CPC), keeping the near-code hint', async () => {
        const res = await checkCpscCertificate({ htsCode: '9403.60.80.40', targetAge: 'child', material: 'wood' });
        expect(res.certificateRequired).toBe(true);
        expect(res.certificateType).toBe('CCC');
        expect(res.eFilingRequired).toBe(true);
        expect(res.disclaimerCodeHint).toBeUndefined();
        expect(res.nextActions.join('')).toContain('"Other Children’s Furniture"');
        expect(res.nextActions.join('')).toContain('"9403608010"');
        expect(res.nextActions.join('')).not.toContain('Disclaim');
      });

      it('keeps 16 CFR 1263 for a child on a code that only shares six digits with a Toys code, and shows the § 1263.1(c) note', async () => {
        const res = await checkCpscCertificate({ htsCode: '8543.70.99.99', targetAge: 'child', hasBattery: true, batteryType: 'button_coin' });
        expect(res.certificateRequired).toBe(true);
        expect(res.certificateType).toBe('CCC');
        expect(res.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(true);
        expect(res.nextActions.join('')).toContain('16 CFR 1263.1(c)');
        expect(res.disclaimerCodeHint).toBeUndefined();
      });

      const ADULT_TOY_NOTE = 'CPSC の一覧の玩具のコードです。ASTM F963（16 CFR 1250）は 14 歳未満の遊び道具、16 CFR 1501 は 3 歳未満向けの品の規則です。対象の年齢に合わせて、当たる規則を確かめてください。';

      it('does not list the toy rules as applying to an adult on a Toys code, and keeps them for a child or an unknown age', async () => {
        const adult = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge: 'adult', material: 'plastic' });
        expect(adult.certificateRequired).toBe(true);
        expect(adult.certificateType).toBe('GCC');
        expect(adult.eFilingRequired).toBe(true);
        expect(adult.applicableRegulations.map((r) => r.cfr)).toContain('個別規格要確認');
        expect(adult.applicableRegulations.map((r) => r.cfr)).not.toContain('ASTM F963 / 16 CFR 1501');
        expect(adult.nextActions).toContain(ADULT_TOY_NOTE);
        const button = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge: 'adult', material: 'plastic', hasBattery: true, batteryType: 'button_coin' });
        expect(button.applicableRegulations.map((r) => r.cfr)).not.toContain('ASTM F963 / 16 CFR 1501');
        expect(button.applicableRegulations.map((r) => r.cfr)).toContain('個別規格要確認');
        expect(button.nextActions).toContain(ADULT_TOY_NOTE);
        for (const targetAge of ['child', 'unknown'] as const) {
          const res = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge, material: 'plastic' });
          expect(res.applicableRegulations.map((r) => r.cfr), targetAge).toContain('ASTM F963 / 16 CFR 1501');
          expect(res.nextActions, targetAge).not.toContain(ADULT_TOY_NOTE);
        }
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

      it('shows the § 1263.1(c) note for a button cell on a Toys code at an unknown age too', async () => {
        const res = await checkCpscCertificate({ htsCode: '9503.00.00.90', targetAge: 'unknown', hasBattery: true, batteryType: 'button_coin' });
        expect(res.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(true);
        expect(res.nextActions.join('')).toContain('16 CFR 1263.1(c)');
        expect(res.nextActions.join('')).toContain('14 歳未満');
        const other = await checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'unknown', hasBattery: true, batteryType: 'button_coin' });
        expect(other.nextActions.join('')).not.toContain('16 CFR 1263.1(c)');
      });

      it('counts an explicit button_coin as a battery without hasBattery, and rejects it with hasBattery: false', async () => {
        const alone = await checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'adult', batteryType: 'button_coin' });
        expect(alone.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(true);
        const other = await checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'adult', batteryType: 'other' });
        expect(other.applicableRegulations.some((r) => r.cfr.startsWith('16 CFR 1263'))).toBe(false);
        await expect(checkCpscCertificate({ htsCode: '8513.10.20.00', targetAge: 'adult', hasBattery: false, batteryType: 'button_coin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      });
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

      // Children's toy (9503, child) with button cell remains CCC under ASTM F963 (16 CFR 1263.1(c))
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

    it('clarifies FDA FCS tableware is exempt from Prior Notice under 21 CFR 1.276(b)(5)(i)(A) while flagging dual FDA + CPSC CCC for children’s mugs', async () => {
      const adultMugFda = checkFdaRegulated({
        htsCode: '6912.00.44.00',
        foodContact: true,
      });
      expect(adultMugFda.fdFlag).toBe('FD1');
      expect(adultMugFda.priorNoticeMayApply).toBe(false);
      expect(adultMugFda.requiredActions?.[0]).toContain('21 CFR');
      expect(adultMugFda.requiredActions?.[0]).toContain('Prior Notice');
      // 条文の番号は (b)(5)(i)(A)（food contact substances は food に入らない）。(b)(5) だけでは (i)(B) の農薬も指す
      expect(adultMugFda.requiredActions?.[0]).toContain('21 CFR § 1.276(b)(5)(i)(A)');
      const mugPlan = await checkProductCompliance({ htsCode: '6912.00.44.00', productName: 'Stoneware Coffee Mug', targetAge: 'adult', material: 'ceramic', foodContact: true });
      expect(mugPlan.actionPlan.join('')).toContain('21 CFR § 1.276(b)(5)(i)(A)');

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

    it('asks for the age on a babies’ garment heading (6111, 6209) with targetAge: adult, with no Disclaim B and no exemption (N3)', async () => {
      for (const htsCode of ['6111.30.50.50', '6209.30.30.40', '6111.20.10.00']) {
        for (const extra of [{}, { hasBattery: true, batteryType: 'button_coin' as const }]) {
          const res = await checkCpscCertificate({ htsCode, targetAge: 'adult', material: '100% polyester', ...extra });
          expect(res.certificateRequired, htsCode).toBe('unknown');
          expect(res.certificateType, htsCode).toBe('unknown');
          expect(res.missingInputs, htsCode).toEqual(['targetAge']);
          expect(res.clarifyingQuestions?.join(''), htsCode).toContain(`見出し ${htsCode.slice(0, 4)}`);
          expect(res.testingExemption, htsCode).toBeUndefined();
          expect(res.disclaimerCodeHint, htsCode).toBeUndefined();
          expect(JSON.stringify(res), htsCode).not.toContain('Disclaim B');
        }
      }
      expect((await checkCpscCertificate({ htsCode: '6111.30.50.50', targetAge: 'child', material: '100% polyester' })).certificateType).toBe('CCC');
      expect((await checkCpscCertificate({ htsCode: '6111.30.50.50', targetAge: 'unknown', material: '100% polyester' })).certificateRequired).toBe('unknown');
      expect((await checkCpscCertificate({ htsCode: '6109.90.10.07', targetAge: 'adult', material: '100% polyester' })).certificateRequired).toBe(false);
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

    // 以下は task review（2307e18）の指摘の固定
    const NAME_NOTE =
      '16 CFR 1610.1(d)(2) の 6 つの繊維の名前（acrylic・modacrylic・nylon・olefin・polyester・wool）と同じ名前のときだけ免除と判定しています。別の名前（例: polyamide は nylon、polypropylene は olefin）なら、その名前に書き直して確かめてください。';

    it('reads one fiber only at exactly 100% (made entirely) and "and" only between spaces', () => {
      expect(parseFiberContent('99.6% polyester')).toBeUndefined();
      expect(parseFiberContent('60% wooland40% nylon')).toBeUndefined();
      expect(parseFiberContent('60% wool and 40% nylon')).toEqual([{ percent: 60, fiber: 'wool' }, { percent: 40, fiber: 'nylon' }]);
      expect(parseFiberContent('50.3% wool 49.9% nylon')).toHaveLength(2); // 2 つ以上は丸めの ±0.5 まで
    });

    it('says it matches only the six (d)(2) names when a fiber name differs, without claiming the fabric is not of the six', async () => {
      for (const material of ['100% polyamide', '100% poly']) {
        const res = await checkCpscCertificate({ htsCode: '6109.90.10.07', targetAge: 'adult', material, fabricSurface: 'raised' });
        expect(res.certificateRequired, material).toBe(true);
        expect(res.nextActions, material).toContain(NAME_NOTE);
        expect(res.testingExemption?.reason, material).not.toContain('免除6繊維100%ではない');
      }
      const nylon = await checkCpscCertificate({ htsCode: '6109.90.10.07', targetAge: 'adult', material: '100% nylon', fabricSurface: 'raised' });
      expect(nylon.certificateRequired).toBe(false);
      expect(nylon.disclaimerCodeHint).toBe('B (Intended Use Code 130.006)');
      expect(nylon.nextActions).not.toContain(NAME_NOTE);
    });

    it('applies the 16 CFR 1610.1(c) condition to children too: CPC without 16 CFR 1610, the condition in missingInfo and nextActions', async () => {
      for (const htsCode of ['6402.99.31.73', '6404.11.90.20']) {
        const res = await checkCpscCertificate({ htsCode, targetAge: 'child', material: 'rubber sole, textile upper' });
        expect(res.certificateType, htsCode).toBe('CCC');
        expect(res.applicableRegulations.map((r) => r.cfr), htsCode).not.toContain('16 CFR 1610');
        expect(res.missingInfo.join(''), htsCode).toContain('16 CFR 1610.1(c)(3) の条件');
        expect(res.nextActions.join(''), htsCode).toContain('条件に当たれば CPC に 16 CFR 1610 は要りません');
        expect(res.nextActions.join(''), htsCode).not.toContain('1610.1(d)');
        expect(res.testingExemption, htsCode).toBeUndefined();
      }
    });

    it('asks only the age on a 16 CFR 1610.1(c) heading and names the (c) condition instead of the (d) / Disclaim B text', async () => {
      const res = await checkCpscCertificate({ htsCode: '6505.00.80.90', targetAge: 'unknown', material: '100% polyester' });
      expect(res.missingInputs).toEqual(['targetAge']);
      expect(res.clarifyingQuestions).toHaveLength(1);
      for (const text of [res.clarifyingQuestions?.[0], res.impactExplanation]) {
        expect(text).toContain('16 CFR 1610.1(c)(1)');
        expect(text).not.toContain('Disclaim B');
      }
      expect(res.testingExemption).toBeUndefined();
    });

    it('keeps the CPSC list item for a listed code when the age is unknown', async () => {
      const res = await checkCpscCertificate({ htsCode: '6109.90.10.09', targetAge: 'unknown' });
      expect(res.applicableRegulations[0].cfr).toContain('CPSC HTS Guidance List');
    });

    it('also gives the 16 CFR 1610.1(d) answer for an adult hat, glove or shoe that fails the (c) condition', async () => {
      const acrylic = await checkCpscCertificate({ htsCode: '6116.10.17.40', targetAge: 'adult', material: '100% acrylic' });
      expect(acrylic.certificateRequired).toBe('unknown');
      expect(acrylic.nextActions.join('')).toContain('条件に当たらないときは、繊維の組成（100% acrylic）が 16 CFR 1610.1(d)(2)');
      expect(acrylic.nextActions.join('')).toContain('Disclaim B');
      const cotton = await checkCpscCertificate({ htsCode: '6116.10.17.40', targetAge: 'adult', material: '100% cotton', fabricSurface: 'raised' });
      expect(cotton.nextActions.join('')).toContain('16 CFR 1610 の試験と GCC・eFiling が要ります');
      expect(cotton.nextActions).toContain(NAME_NOTE);
      const plain = await checkCpscCertificate({ htsCode: '6116.10.17.40', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain' });
      expect(plain.nextActions.join('')).toContain('生地の重さは何 oz/sq yd ですか');
      expect(plain.nextActions.join('')).not.toContain('生地の表面は平ら');
      expect(plain.missingInputs).toBeUndefined();
      expect(plain.inputCompleteness).toBe('complete');
    });

    it('keeps the near-code category hint (Bicycle Helmets) with the (c)(1) text on unlisted 6506.10 headgear at every age', async () => {
      for (const targetAge of ['adult', 'child', 'unknown'] as const) {
        const res = await checkCpscCertificate({ htsCode: '6506.10.60.30', targetAge });
        expect(`${res.missingInfo.join('')}${res.impactExplanation ?? ''}`, targetAge).toContain('16 CFR 1610.1(c)(1)');
        expect(res.nextActions.join(''), targetAge).toContain('"Bicycle Helmets"');
        expect(res.nextActions.join(''), targetAge).toContain('"6506103045"');
      }
    });

    it('asks and names only the missing fabric facts', async () => {
      const plain = await checkCpscCertificate({ htsCode: '6109.10.00.12', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain' });
      expect(plain.missingInputs).toEqual(['fabricWeightOzPerSqYd']);
      expect(`${plain.missingInfo.join('')}${plain.nextActions.join('')}`).not.toMatch(/繊維の?組成|生地の?表面/);
      expect(plain.nextActions.join('')).toContain('生地の重さ');
      expect(plain.nextActions).not.toContain(NAME_NOTE); // 決まる前（重さ次第で (d)(1) の免除）には出さない
      // 2.6 未満なら (d)(1) は当たらないと決まっているので、表面は聞かない
      const light = await checkCpscCertificate({ htsCode: '6109.10.00.12', targetAge: 'adult', material: 'cotton', fabricWeightOzPerSqYd: 2.0 });
      expect(light.missingInputs).toEqual(['material']);
    });

    it('decides the 16 CFR 1610.1(c) headings at the heading edges', () => {
      for (const [code, citation] of [['6216.00.08.00', '16 CFR 1610.1(c)(2)'], ['6401.10.00.00', '16 CFR 1610.1(c)(3)'], ['6405.90.90.00', '16 CFR 1610.1(c)(3)'], ['6504.00.90.15', '16 CFR 1610.1(c)(1)']] as const) {
        expect(section1610cExclusionFor(code)?.citation, code).toBe(citation);
      }
      for (const code of ['6406.10.05.00', '6507.00.00.00']) expect(section1610cExclusionFor(code), code).toBeUndefined();
    });

    it('summarises an adult (c) result as needing the 16 CFR 1610.1(c) condition', async () => {
      const res = await checkProductCompliance({ productName: 'Adult Safety Helmet', description: 'Protective headgear for adults', htsCode: '6506.10.60.30', targetAge: 'adult', material: 'polycarbonate shell' });
      expect(res.cpsc?.certificateRequired).toBe('unknown');
      expect(res.summary).toContain('16 CFR 1610.1(c)(1) の条件');
      expect(res.summary).not.toContain('類似コード');
    });

    it('summarises an unknown-age (c) result as needing only the age, the one thing it asks', async () => {
      const res = await checkProductCompliance({ productName: 'Safety Helmet', description: 'Protective headgear', htsCode: '6506.10.60.30', targetAge: 'unknown', material: 'polycarbonate shell' });
      expect(res.cpsc?.missingInputs).toEqual(['targetAge']);
      expect(res.summary).toContain('対象年齢の確定が必要');
      expect(res.summary).not.toContain('生地仕様');
      expect(res.summary).not.toContain('類似コード');
    });
  });
});

describe('checkCpscCertificate on a code the CPSC list does not carry', () => {
  it('keeps 16 CFR 1610 next to 16 CFR 1263 on an unlisted garment code, but not on a 16 CFR 1610.1(c) heading (review F1)', async () => {
    const cfrs = async (htsCode: string) =>
      (await checkCpscCertificate({ htsCode, targetAge: 'adult', hasBattery: true, batteryType: 'button_coin' })).applicableRegulations.map((r) => r.cfr);
    expect(await cfrs('6109.10.00.12')).toEqual(['16 CFR 1263 (ANSI/UL 4200A-2023)', '16 CFR 1610']);
    expect(await cfrs('6116.10.05.00')).toEqual(['16 CFR 1263 (ANSI/UL 4200A-2023)']);
  });

  it('does not ask for a productCategory, which no input could use', async () => {
    const res = await checkCpscCertificate({ htsCode: '7318.15.0000', targetAge: 'adult' });
    expect(res.certificateRequired).toBe('unknown');
    expect(res.missingInputs).toBeUndefined();
    expect(res.clarifyingQuestions).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('productCategory');
    // 案内は CPSC への個別確認と免責コードの申告に向かう
    expect(res.nextActions.join('')).toContain('CPSC公式に個別確認');
    expect(res.disclaimerCodeHint).toBe('A (only if confirmed that no CPSC rule applies; Intended Use Code required)');
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
