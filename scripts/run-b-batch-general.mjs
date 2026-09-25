import { writeFileSync } from 'node:fs';
import { researchCountryWithDefaults } from '../src/services/country_intel/runtime.ts';
const cases = [
  ['KR', 'Seoul National University GSIS English master admission requirements deadline 2027'],
  ['GB', 'Oxford MPP Master Public Policy admission requirements deadline 2027 entry'],
  ['FR', 'Sciences Po PSIA master international affairs English track admission deadline 2027'],
  ['DE', 'TUM Technical University Munich English master program admission deadline 2027'],
  ['ID', 'Universitas Indonesia English master program international admission requirements 2027'],
  ['MX', 'UNAM posgrado maestria convocatoria 2027 extranjeros requisitos admision'],
];
for (const [region, query] of cases) {
  const t0 = Date.now();
  const started = new Date().toISOString();
  const rep = await researchCountryWithDefaults({ region, query, noCache: true });
  const ms = Date.now() - t0;
  const ev = rep.evidence ? rep.evidence.length : 0;
  writeFileSync('docs/evaluations/research/runs/B-' + region + '-general-01-report.json', JSON.stringify(rep));
  console.log(region + ' ev=' + ev + ' ms=' + ms + ' started=' + started);
}
