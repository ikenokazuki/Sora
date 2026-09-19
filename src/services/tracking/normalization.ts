export interface NormalizedTrackingNumber {
  raw: string;
  normalized: string;
}

/**
 * 伝票番号の正規化（全角英数の半角化、空白・ハイフンの除去、大文字統一）
 */
export function cleanTrackingNumber(raw: string): string {
  if (!raw) return '';
  // 全角英数を半角に変換
  const half = raw.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  // 空白・改行・ハイフン・全角ハイフン・ダッシュ等を除去
  return half.replace(/[\s\-_ー−‐―]/g, '').trim().toUpperCase();
}

/**
 * 生入力と正規化後番号をペアで保持する正規化ヘルパー
 */
export function normalizeTrackingNumber(raw: string): NormalizedTrackingNumber {
  return {
    raw: raw || '',
    normalized: cleanTrackingNumber(raw),
  };
}
