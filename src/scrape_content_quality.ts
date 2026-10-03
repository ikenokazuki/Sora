/** Ignore generated metadata, loading messages and empty calendar grids. */
export function hasMeaningfulPageContent(markdown: string): boolean {
  const body = markdown
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/^>\s*(?:📅|📍).*$/gm, '')
    .trim();
  if (!body) return false;
  if (body.length < 500 && /javascript\s+(?:is\s+)?(?:disabled|required|needed|must be enabled)|please\s+enable\s+(?:your\s+)?javascript|javascript\s*(?:を\s*(?:有効|オン)|が\s*無効)|^(?:loading\.*|読み込み中\.*|now loading\.*)$/im.test(body)) {
    return false;
  }
  const tokens = body.replace(/[#|>*_]/g, ' ').split(/\s+/).filter(Boolean);
  const weekday = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|[月火水木金土日](?:曜日)?)$/i;
  const calendarToken = /^(?:\d{1,4}|\d{4}[-/]\d{1,2}|\d{4}年\d{1,2}月|January|February|March|April|May|June|July|August|September|October|November|December)$/i;
  return !(tokens.some((token) => weekday.test(token)) && tokens.every((token) => weekday.test(token) || calendarToken.test(token)));
}
