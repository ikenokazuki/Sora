import { describe, expect, test } from 'bun:test';
import { EVIDENCE_WEIGHTS } from './evidence_weights.js';
describe('evidence weights ladder (hermetic)', () => {
  test('boosts order above neutral above penalties', () => {
    const boosts = [EVIDENCE_WEIGHTS.tableRowAnswer, EVIDENCE_WEIGHTS.answeredWithEntity, EVIDENCE_WEIGHTS.definitionPair, EVIDENCE_WEIGHTS.answered, EVIDENCE_WEIGHTS.currentEvidence, EVIDENCE_WEIGHTS.entityMention, EVIDENCE_WEIGHTS.impliedYearMatch];
    const penalties = [EVIDENCE_WEIGHTS.oldMarker, EVIDENCE_WEIGHTS.oldYear, EVIDENCE_WEIGHTS.yearMismatch];
    for (const b of boosts) expect(b).toBeGreaterThan(1.0);
    for (const p of penalties) expect(p).toBeLessThan(1.0);
    expect(Math.min(...boosts)).toBeGreaterThan(Math.max(...penalties));
  });
});
