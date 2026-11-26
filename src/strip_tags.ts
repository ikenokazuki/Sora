/**
 * `<…>` を消す（`html.replace(/<[^>]*>/g, replacement)` と同じ結果）。閉じない `<` が大量に並ぶと、その正規表現はどの `<` からも最後まで
 * 読むので、二乗の時間になる。最後の `>` より後ろには一致が無いので、そこまでに当てる（どの `<` にも閉じる `>` があり、長さに比例する）
 */
export function stripTags(html: string, replacement = ''): string {
  const end = html.lastIndexOf('>') + 1;
  return html.slice(0, end).replace(/<[^>]*>/g, replacement) + html.slice(end);
}
