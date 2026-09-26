// Answer-bearing evidence signals (RFC Part III, sections 28-32).
// Mention (facet term present) vs answer (facet + value in the same
// sentence), plus entity association (entity terms in the same sentence).
// CPU-only: substring search and regex, no models.
import { INTENT_ATTRIBUTE_TERMS } from './requirements.js';
export type ValueKind = 'price' | 'weight' | 'date' | 'time' | 'version' | 'wifi';
const PRICE_PATTERN = /[¥￥$＄]|\d[\d,]*\s*円/;
const WEIGHT_PATTERN = /\d[\d,.]*\s*(kg|g|グラム|キロ)/i;
const DATE_PATTERN = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/;
const TIME_PATTERN = /\d{1,2}\s*時(\s*\d{1,2}\s*分)?|\d{1,2}:\d{2}/;
const VERSION_PATTERN = /v\d+(\.\d+)+|version\s*\d+|バージョン\s*\d+/i;
const WIFI_PATTERN = /wi-?fi\s*\d+|802\.11\w*/i;
const KIND_PATTERNS: Array<{ kind: ValueKind; re: RegExp }> = [
  { kind: 'price', re: PRICE_PATTERN },
  { kind: 'weight', re: WEIGHT_PATTERN },
  { kind: 'date', re: DATE_PATTERN },
  { kind: 'time', re: TIME_PATTERN },
  { kind: 'version', re: VERSION_PATTERN },
  { kind: 'wifi', re: WIFI_PATTERN },
];
const FACET_KINDS: Array<{ terms: string[]; kinds: ValueKind[] }> = [
  { terms: ['価格', '料金', '値段', '販売価格', '希望小売価格'], kinds: ['price'] },
  { terms: ['重量', '質量', '重さ'], kinds: ['weight'] },
  { terms: ['発売日', '公開日', '配信日', 'リリース', '日付', '日程', '販売開始日'], kinds: ['date'] },
  { terms: ['時刻', '時間', '営業時間', '開演', '開場', '上映'], kinds: ['time'] },
  { terms: ['バージョン', 'version'], kinds: ['version'] },
  { terms: ['wi-fi', 'wifi', '無線lan', '802.11'], kinds: ['wifi'] },
];
export function kindsForFacet(facetTerm: string): ValueKind[] | null {
  const f = (facetTerm || '').toLowerCase();
  if (!f) return null;
  for (const entry of FACET_KINDS) {
    for (const t of entry.terms) {
      if (f.includes(t)) return entry.kinds;
    }
  }
  return null;
}
export function detectValueKinds(sentence: string): ValueKind[] {
  const out: ValueKind[] = [];
  if (!sentence) return out;
  for (const entry of KIND_PATTERNS) {
    try {
      if (entry.re.test(sentence)) out.push(entry.kind);
    } catch {}
  }
  return out;
}
export function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
const ENTITY_STOPWORDS = new Set([
  'の', 'に', 'は', 'を', 'と', 'が', 'で', 'から', 'まで', 'より', 'な', 'や', 'か',
  'について', 'とは', 'とは？',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
]);
function isAsciiAlnum(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}
export function termHitInText(text: string, token: string): boolean {
  if (!text || !token) return false;
  const t = text.toLowerCase();
  const k = token.toLowerCase();
  if (k.length >= 2) return t.includes(k);
  if (!isAsciiAlnum(k)) return t.includes(k);
  let idx = t.indexOf(k);
  while (idx >= 0) {
    const before = idx === 0 ? '' : t[idx - 1];
    const after = idx + k.length >= t.length ? '' : t[idx + k.length];
    if (!isAsciiAlnum(before) && !isAsciiAlnum(after)) return true;
    idx = t.indexOf(k, idx + 1);
  }
  return false;
}
export function entityTermsForQuery(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  const tokens = query
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.length >= 2 && ENTITY_STOPWORDS.has(tok)) continue;
    if (tok.length < 2 && !isAsciiAlnum(tok)) continue;
    let isIntent = false;
    for (const attr of INTENT_ATTRIBUTE_TERMS) {
      if (tok === attr.toLowerCase()) { isIntent = true; break; }
    }
    if (isIntent) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}
export interface FacetEvidence {
  mentioned: boolean;
  answered: boolean;
  entityAssociated: boolean;
  answeredWithEntity: boolean;
}
export function analyzeFacetEvidence(
  sentences: string[],
  entityTerms: string[],
  facetTerm: string,
): FacetEvidence {
  const res: FacetEvidence = { mentioned: false, answered: false, entityAssociated: false, answeredWithEntity: false };
  const facet = (facetTerm || '').toLowerCase();
  if (!facet || !sentences || sentences.length === 0) return res;
  const kinds = kindsForFacet(facet);
  for (const raw of sentences) {
    const s = (raw || '').toLowerCase();
    if (!s.includes(facet)) continue;
    res.mentioned = true;
    let hasEntity = true;
    for (const term of entityTerms) {
      if (!termHitInText(s, term)) { hasEntity = false; break; }
    }
    if (entityTerms.length === 0) hasEntity = false;
    if (hasEntity) res.entityAssociated = true;
    const found = detectValueKinds(raw);
    let hasValue = false;
    if (kinds === null) {
      hasValue = found.length > 0;
    } else {
      for (const k of kinds) {
        if (found.includes(k)) { hasValue = true; break; }
      }
    }
    if (hasValue) res.answered = true;
    if (hasValue && hasEntity) res.answeredWithEntity = true;
  }
  return res;
}
export function associationMultiplier(ev: FacetEvidence): number {
  if (ev.answeredWithEntity) return 1.6;
  if (ev.answered) return 1.3;
  if (ev.entityAssociated) return 1.15;
  return 1.0;
}
