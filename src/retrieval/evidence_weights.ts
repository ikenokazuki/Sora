// Central evidence weight ladder (arch-debt 6).
// All score multipliers reference this table; tune here, never inline.
// Scale: 1.0 is neutral mention. Boosts reward answer-bearing evidence,
// penalties demote stale or mismatched evidence without excluding it.
export const EVIDENCE_WEIGHTS = {
  answeredWithEntity: 1.6,
  answered: 1.3,
  entityMention: 1.15,
  tableRowAnswer: 1.8,
  definitionPair: 1.4,
  currentEvidence: 1.2,
  impliedYearMatch: 1.1,
  oldMarker: 0.7,
  oldYear: 0.75,
  yearMismatch: 0.8,
} as const;
export type EvidenceWeightKey = keyof typeof EVIDENCE_WEIGHTS;
