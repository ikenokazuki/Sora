// Answer-bearing evidence signals (RFC Part III, sections 28-32).
// Mention (facet term present) vs answer (facet + value in the same
// sentence), plus entity association (entity terms in the same sentence).
// CPU-only: substring search and regex, no models.
import { INTENT_ATTRIBUTE_TERMS } from './requirements.js';
import { CURRENT_INTENT_TERMS, CURRENT_MARKERS, FACET_KIND_TERMS, OLD_MARKERS, RELATIVE_DAY_OFFSETS } from './lexicons/temporal.js';
import { EVIDENCE_WEIGHTS } from './evidence_weights.js';
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
const FACET_KINDS: Array<{ terms: string[]; kinds: ValueKind[] }> = FACET_KIND_TERMS;
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
import { splitSentences } from '../extractor/hierarchical_bm25.js';
export { splitSentences };
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
/**
 * 見出し（「■チケット料金」）と値（「全席指定 8,800円」）が別文に分かれる日本語ページ向けに、
 * facet を含む文に値が無いとき、続く lookahead 文までの値も回答とみなす。0 で同一文のみ（従来動作）。
 * 既定 2 は保存済み100ページ・23クエリの実測で、ハイライト選抜が98/100不変・変化2件は改善、
 * answerCoverage 上昇31件・低下0件。
 */
export const DEFAULT_VALUE_LOOKAHEAD = 2;

export function analyzeFacetEvidence(
  sentences: string[],
  entityTerms: string[],
  facetTerm: string,
  lookahead = DEFAULT_VALUE_LOOKAHEAD,
): FacetEvidence {
  const res: FacetEvidence = { mentioned: false, answered: false, entityAssociated: false, answeredWithEntity: false };
  const facet = (facetTerm || '').toLowerCase();
  if (!facet || !sentences || sentences.length === 0) return res;
  const kinds = kindsForFacet(facet);
  const hasWantedValue = (found: ValueKind[]) => (kinds === null ? found.length > 0 : kinds.some((k) => found.includes(k)));
  for (let i = 0; i < sentences.length; i++) {
    const raw = sentences[i];
    const s = (raw || '').toLowerCase();
    if (!s.includes(facet)) continue;
    res.mentioned = true;
    let hasEntity = true;
    for (const term of entityTerms) {
      if (!termHitInText(s, term)) { hasEntity = false; break; }
    }
    if (entityTerms.length === 0) hasEntity = false;
    if (hasEntity) res.entityAssociated = true;
    let hasValue = hasWantedValue(detectValueKinds(raw));
    for (let j = i + 1; !hasValue && j <= i + lookahead && j < sentences.length; j++) {
      hasValue = hasWantedValue(detectValueKinds(sentences[j]));
    }
    if (hasValue) res.answered = true;
    if (hasValue && hasEntity) res.answeredWithEntity = true;
  }
  return res;
}
export function associationMultiplier(ev: FacetEvidence): number {
  if (ev.answeredWithEntity) return EVIDENCE_WEIGHTS.answeredWithEntity;
  if (ev.answered) return EVIDENCE_WEIGHTS.answered;
  if (ev.entityAssociated) return EVIDENCE_WEIGHTS.entityMention;
  return 1.0;
}
export function structuralMultiplier(blockText: string, facetTerm: string): number {
  if (!blockText || !facetTerm) return 1.0;
  const facet = facetTerm.toLowerCase();
  const kinds = kindsForFacet(facet);
  const lines = blockText.split('\n').map((l) => l.trim());
  let best = 1.0;
  const valueHit = (cell: string): boolean => {
    const found = detectValueKinds(cell);
    if (kinds === null) return found.length > 0;
    for (const k of kinds) {
      if (found.includes(k)) return true;
    }
    return false;
  };
  for (const line of lines) {
    if (line.length < 3 || line[0] !== '|') continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    let allSep = true;
    for (const c of cells) {
      if (!/^[-:]+$/.test(c)) { allSep = false; break; }
    }
    if (allSep) continue;
    let keyIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].toLowerCase().includes(facet)) { keyIdx = i; break; }
    }
    if (keyIdx < 0) continue;
    for (let i = 0; i < cells.length; i++) {
      if (i !== keyIdx && valueHit(cells[i])) {
        best = Math.max(best, EVIDENCE_WEIGHTS.tableRowAnswer);
        break;
      }
    }
  }
  const prose = lines.filter((l) => l.length > 0 && l[0] !== '|');
  for (let i = 0; i + 1 < prose.length; i++) {
    if (!prose[i].toLowerCase().includes(facet)) continue;
    if (prose[i + 1].toLowerCase().includes(facet)) continue;
    if (valueHit(prose[i + 1])) best = Math.max(best, EVIDENCE_WEIGHTS.definitionPair);
  }
  return best;
}
export function detectCurrentIntent(query: string): boolean {
  if (!query || typeof query !== 'string') return false;
  for (const term of CURRENT_INTENT_TERMS) {
    if (query.indexOf(term) >= 0) return true;
  }
  return false;
}
function sentenceYears(sentence: string): number[] {
  const out: number[] = [];
  const re = /(\d{4})\s*年|((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/g;
  let m: RegExpExecArray | null;
  try {
    while ((m = re.exec(sentence)) !== null) {
      const y = parseInt(m[1] || m[2], 10);
      if (Number.isFinite(y) && y >= 1900 && y <= 2100) out.push(y);
    }
  } catch {}
  return out;
}
export function temporalMultiplier(sentences: string[], facetTerm: string, currentIntent: boolean): number {
  if (!currentIntent) return 1.0;
  const facet = (facetTerm || '').toLowerCase();
  if (!facet || !sentences) return 1.0;
  const thisYear = new Date().getFullYear();
  let bestBoost = 1.0;
  let worstPenalty = 1.0;
  let seen = false;
  for (const raw of sentences) {
    const s = (raw || '').toLowerCase();
    if (s.indexOf(facet) < 0) continue;
    seen = true;
    let m = 1.0;
    let hasOld = false;
    for (const marker of OLD_MARKERS) {
      if (s.indexOf(marker) >= 0) { hasOld = true; break; }
    }
    if (hasOld) {
      m = EVIDENCE_WEIGHTS.oldMarker;
    } else {
      const years = sentenceYears(raw);
      let hasOldYear = false;
      let hasCurrentYear = false;
      for (const y of years) {
        if (y < thisYear) hasOldYear = true;
        if (y >= thisYear) hasCurrentYear = true;
      }
      if (hasOldYear && !hasCurrentYear) {
        m = EVIDENCE_WEIGHTS.oldYear;
      } else {
        let hasCurrent = false;
        for (const marker of CURRENT_MARKERS) {
          if (s.indexOf(marker) >= 0) { hasCurrent = true; break; }
        }
        if (hasCurrent || hasCurrentYear) m = EVIDENCE_WEIGHTS.currentEvidence;
      }
    }
    if (m > bestBoost) bestBoost = m;
    if (m < worstPenalty) worstPenalty = m;
  }
  if (!seen) return 1.0;
  if (bestBoost > 1.0) return bestBoost;
  return worstPenalty;
}
export interface EvidenceCoverage {
  mentionCoverage: number;
  answerCoverage: number;
  coveredRequirements: string[];
  answeredRequirements: string[];
  missingRequirements: string[];
}
export function computeEvidenceCoverage(
  blockTexts: string[],
  entityTerms: string[],
  requirements: string[],
  lookahead = DEFAULT_VALUE_LOOKAHEAD,
): EvidenceCoverage {
  const empty: EvidenceCoverage = {
    mentionCoverage: 0,
    answerCoverage: 0,
    coveredRequirements: [],
    answeredRequirements: [],
    missingRequirements: [],
  };
  if (!requirements || requirements.length === 0) return empty;
  const blocks = (blockTexts || []).map((t) => splitSentences(t || ''));
  let mentioned = 0;
  let answered = 0;
  for (const req of requirements) {
    let reqMentioned = false;
    let reqAnswered = false;
    for (const sentences of blocks) {
      const ev = analyzeFacetEvidence(sentences, entityTerms || [], req, lookahead);
      if (ev.mentioned) reqMentioned = true;
      if (ev.answered) reqAnswered = true;
      if (reqMentioned && reqAnswered) break;
    }
    if (reqMentioned) {
      mentioned += 1;
      empty.coveredRequirements.push(req);
    }
    if (reqAnswered) {
      answered += 1;
      empty.answeredRequirements.push(req);
    } else {
      empty.missingRequirements.push(req);
    }
  }
  empty.mentionCoverage = mentioned / requirements.length;
  empty.answerCoverage = answered / requirements.length;
  return empty;
}
export interface DateRequirement {
  month: number;
  day: number;
  year: number | null;
}
function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
export function extractDateRequirements(query: string, ref?: Date): DateRequirement[] {
  const out: DateRequirement[] = [];
  if (!query || typeof query !== 'string') return out;
  const base = ref instanceof Date ? new Date(ref.getTime()) : new Date();
  for (const entry of RELATIVE_DAY_OFFSETS) {
    if (query.indexOf(entry.term) < 0) continue;
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + entry.offset);
    out.push({ month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() });
    break;
  }
  const seen = new Set<string>();
  const push = (month: number, day: number, year: number | null) => {
    if (!validMonthDay(month, day)) return;
    const key = month + '-' + day + '-' + (year === null ? 'x' : String(year));
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ month, day, year });
  };
  let m: RegExpExecArray | null;
  const reJp = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  try {
    while ((m = reJp.exec(query)) !== null) {
      if (m[1] !== undefined && m[1] !== '') push(parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[1], 10));
      else push(parseInt(m[4], 10), parseInt(m[5], 10), null);
    }
  } catch {}
  const reSlash = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})|(\d{1,2})\s*[\/]\s*(\d{1,2})/g;
  try {
    while ((m = reSlash.exec(query)) !== null) {
      if (m[1] !== undefined && m[1] !== '') push(parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[1], 10));
      else push(parseInt(m[4], 10), parseInt(m[5], 10), null);
    }
  } catch {}
  return out;
}
export function impliedYear(req: DateRequirement, ref?: Date): number {
  if (req.year !== null && Number.isFinite(req.year)) return req.year;
  const base = ref instanceof Date ? ref : new Date();
  const thisYear = base.getFullYear();
  const thisMonth = base.getMonth() + 1;
  const thisDay = base.getDate();
  if (req.month > thisMonth || (req.month === thisMonth && req.day >= thisDay)) return thisYear;
  return thisYear + 1;
}
function sentenceHasMonthDay(sentence: string, month: number, day: number): boolean {
  const jp = new RegExp(month + '[\\s]*月[\\s]*' + day + '[\\s]*日');
  const slash = new RegExp(month + '[\\s]*\\/[\\s]*' + day + '(?![\\d\/])');
  try {
    if (jp.test(sentence)) return true;
  } catch {}
  try {
    if (slash.test(sentence)) return true;
  } catch {}
  return false;
}
export function dateYearMultiplier(sentences: string[], dateReqs: DateRequirement[], ref?: Date): number {
  if (!dateReqs || dateReqs.length === 0) return 1.0;
  const base = ref instanceof Date ? ref : new Date();
  let bestBoost = 1.0;
  let worstPenalty = 1.0;
  let seen = false;
  for (const raw of sentences || []) {
    const s = raw || '';
    for (const req of dateReqs) {
      if (!sentenceHasMonthDay(s, req.month, req.day)) continue;
      seen = true;
      const target = impliedYear(req, base);
      const years = sentenceYears(s);
      if (years.length === 0) continue;
      let m = 1.0;
      if (years.indexOf(target) >= 0) m = EVIDENCE_WEIGHTS.impliedYearMatch;
      else m = EVIDENCE_WEIGHTS.yearMismatch;
      if (m > bestBoost) bestBoost = m;
      if (m < worstPenalty) worstPenalty = m;
    }
  }
  if (!seen) return 1.0;
  if (bestBoost > 1.0) return bestBoost;
  return worstPenalty;
}
