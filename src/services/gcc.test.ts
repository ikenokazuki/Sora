import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { GenerateGccCertificateRequestSchema } from '../types.js';
import { type GccItemInput, TradeGccIncompleteError, generateGccCertificate } from './gcc.js';
import { TradeInputError } from './trade.js';

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
const PENLIGHT: GccItemInput = { htsCode: '8513.10.20.00', productName: 'LED Penlight', identifier: 'PEN-001', targetAge: 'adult', hasBattery: true, batteryType: 'button_coin', manufacture: FACTORY, testing: { date: '2026-06-15', parties: [LAB] } };
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
    const wrong = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...PENLIGHT, citations: ['16 CFR 1203'] }] });
    expect(wrong.items[0].status).toBe('draft_needs_info');
    expect(wrong.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1263');
    const right = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 CFR 1263'] }] });
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
    await expect(generateGccCertificate({ items: [{ ...HELMET, productName: '  ' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(generateGccCertificate({ items: [{ ...HELMET, citations: [' '] }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(GenerateGccCertificateRequestSchema.safeParse({}).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: Array.from({ length: 51 }, () => HELMET) }).success).toBe(false);
    const fifty = Array.from({ length: 50 }, () => HELMET);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: fifty }).success).toBe(true);
    expect((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: fifty })).counts.gccGenerated).toBe(50);
  });

  it('gives stable IDs without a date, different for different products (M1)', async () => {
    const a1 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const a2 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(a2.packageId).toBe(a1.packageId);
    expect(a2.items[0].certificateId).toBe(a1.items[0].certificateId);
    const other = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...HELMET, identifier: 'HLM-002' }] });
    expect(other.items[0].certificateId).not.toBe(a1.items[0].certificateId);
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
  it('keeps 16 CFR 1610 on an unlisted garment code with a coin cell (review F1)', async () => {
    const shirt: GccItemInput = { ...PENLIGHT, htsCode: '6109.10.00.12', productName: 'Adult Cotton T-Shirt With LED Badge', identifier: 'TEE-LED-1', material: '100% cotton' };
    const only1263 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...shirt, citations: ['16 CFR 1263'] }] });
    expect(only1263.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['citations'] });
    expect(only1263.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1610');
    const both = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...shirt, citations: ['16 CFR 1263', '16 CFR 1610'] }] });
    expect(both.items[0].status).toBe('generated');
  });

  it('keeps an item with a battery of unknown type a draft, because the type decides 16 CFR 1263 (review m1)', async () => {
    const parties = { certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true };
    const helmet = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true }] });
    expect(helmet.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    expect(helmet.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1263');
    const moreMissing = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true, identifier: undefined }] });
    expect(moreMissing.items[0].missingFields).toEqual(['batteryType', 'identifier']);
    const exemptGarment = await generateGccCertificate({ allowDraft: true, items: [{ ...TEE, hasBattery: true }] });
    expect(exemptGarment.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    const noRule = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult', citations: [], hasBattery: true }] });
    expect(noRule.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    const knownType = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true, batteryType: 'other' }] });
    expect(knownType.items[0].status).toBe('generated');
  });

  it('reads "16 C.F.R." the same as "16 CFR" (review m2)', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 C.F.R. 1263'] }] });
    expect(res.items[0].status).toBe('generated');
  });

  it('accepts 16 CFR 1250 in place of 1263 only on a code in the Toys list (16 CFR 1263.1(c))', async () => {
    const toy: GccItemInput = { ...PENLIGHT, htsCode: '9503.00.00.73', productName: 'Adult Collectible Figure With Light', identifier: 'FIG-1', citations: ['16 CFR 1250'] };
    expect((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [toy] })).items[0].status).toBe('generated');
    const notToy = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...PENLIGHT, citations: ['16 CFR 1250'] }] });
    expect(notToy.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['citations'] });
  });

  it('asks for a test party when testing.parties is empty', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...HELMET, testing: { date: '2026-06-15', parties: [] } }] });
    expect(res.items[0].missingFields).toEqual(['testing.parties']);
  });

  it('reports the line of each draft in a generated and draft mix', async () => {
    const err = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET, { ...HELMET, identifier: undefined }] }).catch((e) => e);
    expect(err).toBeInstanceOf(TradeGccIncompleteError);
    expect(err.details.items.map((item: { line: number }) => item.line)).toEqual([2]);
    expect(err.details.missingFields).toEqual([]);
  });

  it('reads a broken server default only when a certificate needs it, and reports it as a server setting (review m5)', async () => {
    process.env.SORA_GCC_CERTIFIER = '{not json';
    process.env.SORA_GCC_CUSTODIAN = '[1]';
    const exempt = await generateGccCertificate({ orderNumber: 'ORDER-1001', items: [TEE] });
    expect(exempt.items[0].status).toBe('exempt_disclaim_b');
    expect(exempt.packageHtml).not.toContain('[MISSING]');
    const err = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TradeInputError);
    expect(err.message).toContain('SORA_GCC_CERTIFIER');
  });

  it('gives the same certificate id whatever the key order of the records (review m6)', async () => {
    const reversed = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).reverse()) as T;
    const a = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const b = await generateGccCertificate({
      certifier: reversed(CERTIFIER),
      recordCustodian: reversed(CUSTODIAN),
      items: [{ ...HELMET, manufacture: reversed(FACTORY), testing: reversed({ date: '2026-06-15', reportNumber: 'TR-0001', parties: [reversed(LAB)] }) }],
    });
    expect(b.items[0].certificateId).toBe(a.items[0].certificateId);
  });

  it('rejects sample or placeholder values in what the caller sent, even with allowDraft, but not in the server defaults (M2)', async () => {
    const err = await generateGccCertificate({
      allowDraft: true,
      certifier: { ...CERTIFIER, name: 'Sample Exporter Inc.', email: 'compliance@acme-imports.example.com', phone: '+81-3-0000-0000' },
      recordCustodian: CUSTODIAN,
      items: [{ ...HELMET, manufacture: { ...FACTORY, date: 'TBD', city: '仮置き工場', country: 'Unknown' } }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TradeInputError);
    expect(err.code).toBe('UNVERIFIED_PLACEHOLDER_INPUT');
    for (const field of ['certifier.name', 'certifier.email', 'certifier.phone', 'items[0].manufacture.date', 'items[0].manufacture.city', 'items[0].manufacture.country']) expect(err.message).toContain(field);
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, email: 'compliance@acme-imports.example.com' });
    const res = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(res.items[0].status).toBe('generated');
  });

  it('prints only the caller’s citations, never a rule Sora derived', async () => {
    const cited = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 CFR 1263'] }] });
    expect(cited.packageHtml).toContain('16 CFR 1263');
    expect(cited.packageHtml).not.toContain('ANSI/UL 4200A');
    const draft = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [PENLIGHT], allowDraft: true });
    expect(draft.items[0].clarifyingQuestions?.[0]).toContain('16 CFR 1263');
    expect(draft.packageHtml).not.toContain('16 CFR 1263');
  });

  it('asks about 16 CFR 1610.1(c) for an adult hat instead of citing 16 CFR 1610 on its own', async () => {
    const hat: GccItemInput = { htsCode: '6505.00.60.30', productName: 'Adult Knit Cap', identifier: 'CAP-1', targetAge: 'adult' };
    const res = await generateGccCertificate({ items: [hat], allowDraft: true });
    expect(res.items[0].status).toBe('draft_needs_info');
    expect(res.items[0].missingFields).toContain('citations');
    expect(res.items[0].clarifyingQuestions?.[0]).toContain('16 CFR 1610.1(c)(1)');
    expect(res.items[0].citations).toBeUndefined();
    const stated = await generateGccCertificate({ items: [{ ...hat, citations: [] }] });
    expect(stated.items[0].status).toBe('exempt_no_gcc_needed');
    expect(stated.packageHtml).toContain('16 CFR 1610.1(c)(1)');
  });

  it('escapes every caller string in packageHtml (XSS)', async () => {
    const xss = `<script>alert("xss")</script><img src=x onerror=alert('1')>&"`;
    const party = { ...CERTIFIER, name: `Party ${xss}`, street: `Street ${xss}` };
    const res = await generateGccCertificate({
      orderNumber: `ORD-${xss}`,
      awbNumber: `AWB-${xss}`,
      certifier: party,
      recordCustodian: party,
      items: [{ ...HELMET, identifier: `SKU-${xss}`, productName: `Helmet ${xss}`, description: `Desc ${xss}`, manufacture: { ...FACTORY, city: `City ${xss}` }, testing: { date: '2026-06-15', parties: [{ ...LAB, name: `Lab ${xss}` }] } }],
    });
    expect(res.packageHtml).not.toContain('<script>');
    expect(res.packageHtml).not.toContain('<img src=x');
    expect(res.packageHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});
