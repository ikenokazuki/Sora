import { Hono } from 'hono';
import {
  checkCpscCertificate,
  checkFdaRegulated,
  verifyHtsCode,
  predictHtsCode,
  checkProductCompliance,
} from '../scraper.js';
import {
  CpscCertificateCheckRequestSchema,
  FdaRegulatedCheckRequestSchema,
  VerifyHtsCodeRequestSchema,
  PredictHtsCodeRequestSchema,
  ProductComplianceRequestSchema,
} from '../types.js';
import { formatError } from './utils.js';

export const tradeRoutes = new Hono();

// 米国CPSC適合証明書 eFiling義務化判定 (POST /trade/cpsc-check)
tradeRoutes.post('/trade/cpsc-check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = CpscCertificateCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode and targetAge are required for CPSC certificate check', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await checkCpscCertificate(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'CPSC certificate check failed', 'TRADE_ERROR', 500);
  }
});

// 米国FDA規制対象 簡易判定 (POST /trade/fda-check)
tradeRoutes.post('/trade/fda-check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = FdaRegulatedCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode is required for FDA regulation check', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = checkFdaRegulated(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'FDA regulation check failed', 'TRADE_ERROR', 500);
  }
});

// HTS/HSコード実在確認・検証 (POST /trade/hts-verify)
tradeRoutes.post('/trade/hts-verify', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = VerifyHtsCodeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode and productDescription are required for HTS code verification', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await verifyHtsCode(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'HTS code verification failed', 'TRADE_ERROR', 500);
  }
});

// HTS/HSコード商品情報からの推測 (POST /trade/hts-predict)
tradeRoutes.post('/trade/hts-predict', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = PredictHtsCodeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'productName is required for HTS code prediction', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await predictHtsCode(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'HTS code prediction failed', 'TRADE_ERROR', 500);
  }
});

// 商品統合コンプライアンス一括判定 (POST /trade/compliance)
tradeRoutes.post('/trade/compliance', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = ProductComplianceRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid product compliance parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await checkProductCompliance(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Product compliance check failed', 'TRADE_ERROR', 500);
  }
});
