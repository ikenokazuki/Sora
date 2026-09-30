// Answer-bearing evidence signals (RFC Part III, sections 28-32).
// Mention (facet term present) vs answer (facet + value in the same
// sentence), plus entity association (entity terms in the same sentence).
// CPU-only: substring search and regex, no models.
import { INTENT_ATTRIBUTE_TERMS } from './requirements.js';
import { CURRENT_INTENT_TERMS, CURRENT_MARKERS, FACET_KIND_TERMS, OLD_MARKERS } from './lexicons/temporal.js';
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
        best = Math.max(best, 1.8);
        break;
      }
    }
  }
  const prose = lines.filter((l) => l.length > 0 && l[0] !== '|');
  for (let i = 0; i + 1 < prose.length; i++) {
    if (!prose[i].toLowerCase().includes(facet)) continue;
    if (prose[i + 1].toLowerCase().includes(facet)) continue;
    if (valueHit(prose[i + 1])) best = Math.max(best, 1.4);
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
      m = 0.7;
    } else {
      const years = sentenceYears(raw);
      let hasOldYear = false;
      let hasCurrentYear = false;
      for (const y of years) {
        if (y < thisYear) hasOldYear = true;
        if (y >= thisYear) hasCurrentYear = true;
      }
      if (hasOldYear && !hasCurrentYear) {
        m = 0.75;
      } else {
        let hasCurrent = false;
        for (const marker of CURRENT_MARKERS) {
          if (s.indexOf(marker) >= 0) { hasCurrent = true; break; }
        }
        if (hasCurrent || hasCurrentYear) m = 1.2;
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
      const ev = analyzeFacetEvidence(sentences, entityTerms || [], req);
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
