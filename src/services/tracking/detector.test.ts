import { describe, it, expect } from 'bun:test';
import { detectCandidates, detectCandidateCarrierCodes } from './detector.js';
import { parseS10TrackingNumber } from './postal.js';

describe('Tracking v2 Detection Unit Tests', () => {
  describe('UPS 1Z Exclusive Detection', () => {
    it('1Zで始まる18桁英数字はUPSのみを唯一のexclusive候補として即時確定する', () => {
      const res = detectCandidates('1Z9999999999999999');
      expect(res.length).toBe(1);
      expect(res[0].carrier).toBe('ups');
      expect(res[0].strength).toBe('exclusive');
      expect(res[0].score).toBe(100);
    });

    it('小文字混在・ハイフン区切りのUPS番号も正規化後にexclusive判定される', () => {
      const res = detectCandidates('1z-999-999-99-9999-9999');
      expect(res.length).toBe(1);
      expect(res[0].carrier).toBe('ups');
      expect(res[0].strength).toBe('exclusive');
    });
  });

  describe('UPU S10 International Postal Detection', () => {
    it('日本郵便 JP発行の有効なS10伝票番号を検出する', () => {
      // EM 12345678 ? JP
      // 重み: 1*8 + 2*6 + 3*4 + 4*2 + 5*3 + 6*5 + 7*9 + 8*7
      // = 8 + 12 + 12 + 8 + 15 + 30 + 63 + 56 = 204
      // 204 % 11 = 6
      // 11 - 6 = 5 (checkDigit = 5)
      // 番号: EM123456785JP
      const s10 = parseS10TrackingNumber('EM123456785JP');
      expect(s10.valid).toBe(true);
      expect(s10.checkDigit).toBe(5);
      expect(s10.issuingCountry).toBe('JP');

      const res = detectCandidates('EM123456785JP');
      expect(res.length).toBe(1);
      expect(res[0].carrier).toBe('japanpost');
      expect(res[0].score).toBeGreaterThanOrEqual(95);
    });

    it('外国発行（US等）の有効なS10番号も独立USPSではなくjapanpost国際追跡へルーティングされる', () => {
      // EM 12345678 5 US
      const res = detectCandidates('EM123456785US');
      expect(res.length).toBe(1);
      expect(res[0].carrier).toBe('japanpost');
      expect(res[0].reasons.some((r) => r.includes('US') || r.includes('UPU'))).toBe(true);
    });

    it('チェックディジットが不正なS10形式はjapanpostのスコアが低下する', () => {
      const s10 = parseS10TrackingNumber('EM123456780JP'); // 0 is invalid
      expect(s10.valid).toBe(false);

      const res = detectCandidates('EM123456780JP');
      // 不正な場合はスコアが低め（50）
      const jp = res.find((r) => r.carrier === 'japanpost');
      expect(jp).toBeDefined();
      expect(jp!.score).toBeLessThan(90);
    });
  });

  describe('Domestic 10/11/12/13-digit Collision & Scoring', () => {
    it('12桁数字（ヤマト・佐川・郵便・福山）の競合をスコア順にランク付けする', () => {
      const res = detectCandidates('564832878562');
      const carriers = res.map((r) => r.carrier);
      expect(carriers).toContain('sagawa');
      expect(carriers).toContain('yamato');
      expect(carriers).toContain('japanpost');
      expect(carriers).toContain('fukutsu');
      // exclusive ではないこと
      expect(res.every((r) => r.strength !== 'exclusive')).toBe(true);
    });

    it('10桁数字は西濃、佐川、DHL等が候補となる', () => {
      const res = detectCandidates('1234567890');
      const carriers = res.map((r) => r.carrier);
      expect(carriers).toContain('seino');
      expect(carriers).toContain('sagawa');
      expect(carriers).toContain('dhl');
    });

    it('13桁数字は日本郵便の国内伝票番号が優先される', () => {
      const res = detectCandidates('1234567890123');
      expect(res[0].carrier).toBe('japanpost');
      expect(res[0].score).toBe(85);
    });

    it('preferredCarriersヒントにより対象キャリアのスコアがブーストされる', () => {
      const unboosted = detectCandidates('564832878562');
      const boosted = detectCandidates('564832878562', { preferredCarriers: ['sagawa'] });

      const unboostedSagawa = unboosted.find((r) => r.carrier === 'sagawa')!;
      const boostedSagawa = boosted.find((r) => r.carrier === 'sagawa')!;
      expect(boostedSagawa.score).toBeGreaterThan(unboostedSagawa.score);
    });
  });
});
