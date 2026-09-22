import { ISO_COUNTRIES } from './geo_codes.js';

const B = String.fromCharCode(92);
const ESCAPER = new RegExp('[.*+?^()|[' + B + ']' + B + B + ']', 'gu');

const COUNTRY_NAME_SOURCE: string = (() => {
  const escaped = ISO_COUNTRIES.map((entry) => entry[2].replace(ESCAPER, B + B + '$&'))
    .sort((left, right) => right.length - left.length);
  return '(?<!' + B + 'p{L})(' + escaped.join('|') + ')(?!' + B + 'p{L})';
})();

const COUNTRY_NAME_TO_ISO2: ReadonlyMap<string, string> = new Map(
  ISO_COUNTRIES.map((entry) => [entry[2].normalize('NFKC').toLocaleLowerCase('en-US'), entry[0]]),
);

/** Free text (USGS place / EONET title) to ISO alpha-2. No gazetteer beyond ISO_COUNTRIES. */
export function inferCountryCodesFromText(text: string | undefined): string[] {
  if (!text) return [];
  const normalized = text.normalize('NFKC');
  const pattern = new RegExp(COUNTRY_NAME_SOURCE, 'giu');
  const codes = new Set<string>();
  for (const match of normalized.matchAll(pattern)) {
    const code = COUNTRY_NAME_TO_ISO2.get(match[1].toLocaleLowerCase('en-US'));
    if (code) codes.add(code);
  }
  return [...codes];
}
