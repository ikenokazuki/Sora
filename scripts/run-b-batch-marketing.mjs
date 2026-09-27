import { writeFileSync } from 'node:fs';
import { researchCountryWithDefaults } from '../src/services/country_intel/runtime.ts';
const cases = [
  ['KR', 'Seoul Korea Chuseok September 2026 hazards mourning events cafe boycott'],
  ['GB', 'London UK September 2026 hazards events mourning cafe boycott criticism'],
  ['FR', 'Paris France September 2026 hazards protests events cafe boycott criticism'],
  ['DE', 'Berlin Germany September 2026 hazards events mourning cafe boycott'],
  ['ID', 'Jakarta Indonesia September 2026 volcano earthquake hazards cafe boycott'],
  ['MX', 'Mexico City September 2026 earthquake memorial events cafe boycott criticism'],
];
for (const [region, query] of cases) {
  const t0 = Date.now();
  const started = new Date().toISOString();
  const rep = await researchCountryWithDefaults({ region, query, noCache: true });
  const ms = Date.now() - t0;
  const ev = rep.evidence ? rep.evidence.length : 0;
  writeFileSync('docs/evaluations/research/runs/B-' + region + '-marketing-01-report.json', JSON.stringify(rep));
  console.log(region + ' ev=' + ev + ' ms=' + ms + ' started=' + started);
}
