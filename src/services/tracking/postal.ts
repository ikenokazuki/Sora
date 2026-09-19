import type { S10ParseResult } from './types.js';

// UPU S10 公式重みベクトル: [8, 6, 4, 2, 3, 5, 9, 7]
const S10_WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7] as const;

/**
 * UPU S10 チェックディジット計算・検証
 * 8桁のシリアル番号と1桁のチェックディジットから整合性を判定
 */
export function validateS10CheckDigit(serialNumber8: string, checkDigit: number): boolean {
  if (!/^\d{8}$/.test(serialNumber8)) return false;

  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += Number(serialNumber8[i]) * S10_WEIGHTS[i];
  }

  const remainder = sum % 11;
  let expected: number;
  if (remainder === 0) {
    expected = 5;
  } else if (remainder === 1) {
    expected = 0;
  } else {
    expected = 11 - remainder;
  }

  return expected === checkDigit;
}

/**
 * UPU S10 追跡番号（AA123456789BB 形式）のパースおよびチェックディジット検証
 */
export function parseS10TrackingNumber(rawNumber: string): S10ParseResult {
  const num = rawNumber.trim().toUpperCase();
  const reasons: string[] = [];

  // 基本正規表現: 英字2文字 + 数字8桁 + 数字1桁(CD) + 英字2文字
  const match = num.match(/^([A-Z]{2})(\d{8})(\d)([A-Z]{2})$/);
  if (!match) {
    return {
      valid: false,
      serviceIndicator: '',
      serialNumber: '',
      checkDigit: -1,
      issuingCountry: '',
      reasons: ['Not an UPU S10 format (must be 2 letters + 9 digits + 2 letters)'],
    };
  }

  const serviceIndicator = match[1];
  const serialNumber8 = match[2];
  const checkDigit = Number(match[3]);
  const issuingCountry = match[4];

  const isChecksumValid = validateS10CheckDigit(serialNumber8, checkDigit);
  if (!isChecksumValid) {
    reasons.push(`Invalid S10 check digit (got ${checkDigit})`);
    return {
      valid: false,
      serviceIndicator,
      serialNumber: serialNumber8 + String(checkDigit),
      checkDigit,
      issuingCountry,
      reasons,
    };
  }

  reasons.push(`Valid UPU S10 parcel identifier for ${issuingCountry}`);
  return {
    valid: true,
    serviceIndicator,
    serialNumber: serialNumber8 + String(checkDigit),
    checkDigit,
    issuingCountry,
    reasons,
  };
}
