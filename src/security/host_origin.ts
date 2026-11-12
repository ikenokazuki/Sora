// Host と Origin の正規化（依存の無い葉のファイル。設定の登録簿 src/config.ts と、Origin の中間層 mcp_origin.ts が読む）。

/** Host ヘッダーの値（小文字化）。scheme・パス・資格情報・空白を含むもの、数字でないポートは undefined。 */
export function normalizeHost(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.indexOf('/') >= 0 || v.indexOf('?') >= 0 || v.indexOf('#') >= 0 || v.indexOf('@') >= 0) return undefined;
  if (/\s/.test(v)) return undefined;
  const lower = v.toLowerCase();
  if (lower.charAt(0) === '[') {
    const close = lower.indexOf(']');
    if (close < 0) return undefined;
    const rest = lower.slice(close + 1);
    if (rest !== '' && !/^:[0-9]+$/.test(rest)) return undefined;
    return lower;
  }
  const colon = lower.lastIndexOf(':');
  if (colon >= 0) {
    const portPart = lower.slice(colon + 1);
    if (!/^[0-9]+$/.test(portPart)) return undefined;
  }
  return lower;
}

/** ブラウザの Origin（http・https で、パス・問い合わせ・資格情報の無いもの）を `url.origin` に。それ以外は undefined。 */
export function normalizeOrigin(value: string): string | undefined {
  const v = value.trim();
  if (!v || v === 'null') return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return undefined;
  return url.origin;
}
