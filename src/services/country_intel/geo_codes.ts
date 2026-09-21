/** Provider固有の国コードとISOコードの変換を一箇所に隔離する。
 * 静的で監査可能。runtime network lookupは行わない。
 * 未知のコードは unknown として undefined を返し、推測で補完しない。
 */

type IsoEntry = readonly [alpha2: string, alpha3: string, name: string];

export const ISO_COUNTRIES: readonly IsoEntry[] = Object.freeze([
  ['AF', 'AFG', 'Afghanistan'], ['AX', 'ALA', 'Aland Islands'], ['AL', 'ALB', 'Albania'],
  ['DZ', 'DZA', 'Algeria'], ['AS', 'ASM', 'American Samoa'], ['AD', 'AND', 'Andorra'],
  ['AO', 'AGO', 'Angola'], ['AI', 'AIA', 'Anguilla'], ['AQ', 'ATA', 'Antarctica'],
  ['AG', 'ATG', 'Antigua and Barbuda'], ['AR', 'ARG', 'Argentina'], ['AM', 'ARM', 'Armenia'],
  ['AW', 'ABW', 'Aruba'], ['AU', 'AUS', 'Australia'], ['AT', 'AUT', 'Austria'],
  ['AZ', 'AZE', 'Azerbaijan'], ['BS', 'BHS', 'Bahamas'], ['BH', 'BHR', 'Bahrain'],
  ['BD', 'BGD', 'Bangladesh'], ['BB', 'BRB', 'Barbados'], ['BY', 'BLR', 'Belarus'],
  ['BE', 'BEL', 'Belgium'], ['BZ', 'BLZ', 'Belize'], ['BJ', 'BEN', 'Benin'],
  ['BM', 'BMU', 'Bermuda'], ['BT', 'BTN', 'Bhutan'], ['BO', 'BOL', 'Bolivia'],
  ['BQ', 'BES', 'Bonaire'], ['BA', 'BIH', 'Bosnia and Herzegovina'], ['BW', 'BWA', 'Botswana'],
  ['BV', 'BVT', 'Bouvet Island'], ['BR', 'BRA', 'Brazil'], ['IO', 'IOT', 'British Indian Ocean Territory'],
  ['BN', 'BRN', 'Brunei'], ['BG', 'BGR', 'Bulgaria'], ['BF', 'BFA', 'Burkina Faso'],
  ['BI', 'BDI', 'Burundi'], ['CV', 'CPV', 'Cabo Verde'], ['KH', 'KHM', 'Cambodia'],
  ['CM', 'CMR', 'Cameroon'], ['CA', 'CAN', 'Canada'], ['KY', 'CYM', 'Cayman Islands'],
  ['CF', 'CAF', 'Central African Republic'], ['TD', 'TCD', 'Chad'], ['CL', 'CHL', 'Chile'],
  ['CN', 'CHN', 'China'], ['CX', 'CXR', 'Christmas Island'], ['CC', 'CCK', 'Cocos Islands'],
  ['CO', 'COL', 'Colombia'], ['KM', 'COM', 'Comoros'], ['CG', 'COG', 'Congo'],
  ['CD', 'COD', 'Congo, Democratic Republic of the'], ['CK', 'COK', 'Cook Islands'], ['CR', 'CRI', 'Costa Rica'],
  ['CI', 'CIV', 'Cote dIvoire'], ['HR', 'HRV', 'Croatia'], ['CU', 'CUB', 'Cuba'],
  ['CW', 'CUW', 'Curacao'], ['CY', 'CYP', 'Cyprus'], ['CZ', 'CZE', 'Czechia'],
  ['DK', 'DNK', 'Denmark'], ['DJ', 'DJI', 'Djibouti'], ['DM', 'DMA', 'Dominica'],
  ['DO', 'DOM', 'Dominican Republic'], ['EC', 'ECU', 'Ecuador'], ['EG', 'EGY', 'Egypt'],
  ['SV', 'SLV', 'El Salvador'], ['GQ', 'GNQ', 'Equatorial Guinea'], ['ER', 'ERI', 'Eritrea'],
  ['EE', 'EST', 'Estonia'], ['SZ', 'SWZ', 'Eswatini'], ['ET', 'ETH', 'Ethiopia'],
  ['FK', 'FLK', 'Falkland Islands'], ['FO', 'FRO', 'Faroe Islands'], ['FJ', 'FJI', 'Fiji'],
  ['FI', 'FIN', 'Finland'], ['FR', 'FRA', 'France'], ['GF', 'GUF', 'French Guiana'],
  ['PF', 'PYF', 'French Polynesia'], ['TF', 'ATF', 'French Southern Territories'], ['GA', 'GAB', 'Gabon'],
  ['GM', 'GMB', 'Gambia'], ['GE', 'GEO', 'Georgia'], ['DE', 'DEU', 'Germany'],
  ['GH', 'GHA', 'Ghana'], ['GI', 'GIB', 'Gibraltar'], ['GR', 'GRC', 'Greece'],
  ['GL', 'GRL', 'Greenland'], ['GD', 'GRD', 'Grenada'], ['GP', 'GLP', 'Guadeloupe'],
  ['GU', 'GUM', 'Guam'], ['GT', 'GTM', 'Guatemala'], ['GG', 'GGY', 'Guernsey'],
  ['GN', 'GIN', 'Guinea'], ['GW', 'GNB', 'Guinea-Bissau'], ['GY', 'GUY', 'Guyana'],
  ['HT', 'HTI', 'Haiti'], ['HM', 'HMD', 'Heard Island and McDonald Islands'], ['VA', 'VAT', 'Holy See'],
  ['HN', 'HND', 'Honduras'], ['HK', 'HKG', 'Hong Kong'], ['HU', 'HUN', 'Hungary'],
  ['IS', 'ISL', 'Iceland'], ['IN', 'IND', 'India'], ['ID', 'IDN', 'Indonesia'],
  ['IR', 'IRN', 'Iran'], ['IQ', 'IRQ', 'Iraq'], ['IE', 'IRL', 'Ireland'],
  ['IM', 'IMN', 'Isle of Man'], ['IL', 'ISR', 'Israel'], ['IT', 'ITA', 'Italy'],
  ['JM', 'JAM', 'Jamaica'], ['JP', 'JPN', 'Japan'], ['JE', 'JEY', 'Jersey'],
  ['JO', 'JOR', 'Jordan'], ['KZ', 'KAZ', 'Kazakhstan'], ['KE', 'KEN', 'Kenya'],
  ['KI', 'KIR', 'Kiribati'], ['KP', 'PRK', 'North Korea'], ['KR', 'KOR', 'South Korea'],
  ['KW', 'KWT', 'Kuwait'], ['KG', 'KGZ', 'Kyrgyzstan'], ['LA', 'LAO', 'Laos'],
  ['LV', 'LVA', 'Latvia'], ['LB', 'LBN', 'Lebanon'], ['LS', 'LSO', 'Lesotho'],
  ['LR', 'LBR', 'Liberia'], ['LY', 'LBY', 'Libya'], ['LI', 'LIE', 'Liechtenstein'],
  ['LT', 'LTU', 'Lithuania'], ['LU', 'LUX', 'Luxembourg'], ['MO', 'MAC', 'Macao'],
  ['MG', 'MDG', 'Madagascar'], ['MW', 'MWI', 'Malawi'], ['MY', 'MYS', 'Malaysia'],
  ['MV', 'MDV', 'Maldives'], ['ML', 'MLI', 'Mali'], ['MT', 'MLT', 'Malta'],
  ['MH', 'MHL', 'Marshall Islands'], ['MQ', 'MTQ', 'Martinique'], ['MR', 'MRT', 'Mauritania'],
  ['MU', 'MUS', 'Mauritius'], ['YT', 'MYT', 'Mayotte'], ['MX', 'MEX', 'Mexico'],
  ['FM', 'FSM', 'Micronesia'], ['MD', 'MDA', 'Moldova'], ['MC', 'MCO', 'Monaco'],
  ['MN', 'MNG', 'Mongolia'], ['ME', 'MNE', 'Montenegro'], ['MS', 'MSR', 'Montserrat'],
  ['MA', 'MAR', 'Morocco'], ['MZ', 'MOZ', 'Mozambique'], ['MM', 'MMR', 'Myanmar'],
  ['NA', 'NAM', 'Namibia'], ['NR', 'NRU', 'Nauru'], ['NP', 'NPL', 'Nepal'],
  ['NL', 'NLD', 'Netherlands'], ['NC', 'NCL', 'New Caledonia'], ['NZ', 'NZL', 'New Zealand'],
  ['NI', 'NIC', 'Nicaragua'], ['NE', 'NER', 'Niger'], ['NG', 'NGA', 'Nigeria'],
  ['NU', 'NIU', 'Niue'], ['NF', 'NFK', 'Norfolk Island'], ['MK', 'MKD', 'North Macedonia'],
  ['MP', 'MNP', 'Northern Mariana Islands'], ['NO', 'NOR', 'Norway'], ['OM', 'OMN', 'Oman'],
  ['PK', 'PAK', 'Pakistan'], ['PW', 'PLW', 'Palau'], ['PS', 'PSE', 'Palestine'],
  ['PA', 'PAN', 'Panama'], ['PG', 'PNG', 'Papua New Guinea'], ['PY', 'PRY', 'Paraguay'],
  ['PE', 'PER', 'Peru'], ['PH', 'PHL', 'Philippines'], ['PN', 'PCN', 'Pitcairn'],
  ['PL', 'POL', 'Poland'], ['PT', 'PRT', 'Portugal'], ['PR', 'PRI', 'Puerto Rico'],
  ['QA', 'QAT', 'Qatar'], ['RE', 'REU', 'Reunion'], ['RO', 'ROU', 'Romania'],
  ['RU', 'RUS', 'Russia'], ['RW', 'RWA', 'Rwanda'], ['BL', 'BLM', 'Saint Barthelemy'],
  ['SH', 'SHN', 'Saint Helena'], ['KN', 'KNA', 'Saint Kitts and Nevis'], ['LC', 'LCA', 'Saint Lucia'],
  ['MF', 'MAF', 'Saint Martin'], ['PM', 'SPM', 'Saint Pierre and Miquelon'], ['VC', 'VCT', 'Saint Vincent and the Grenadines'],
  ['WS', 'WSM', 'Samoa'], ['SM', 'SMR', 'San Marino'], ['ST', 'STP', 'Sao Tome and Principe'],
  ['SA', 'SAU', 'Saudi Arabia'], ['SN', 'SEN', 'Senegal'], ['RS', 'SRB', 'Serbia'],
  ['SC', 'SYC', 'Seychelles'], ['SL', 'SLE', 'Sierra Leone'], ['SG', 'SGP', 'Singapore'],
  ['SX', 'SXM', 'Sint Maarten'], ['SK', 'SVK', 'Slovakia'], ['SI', 'SVN', 'Slovenia'],
  ['SB', 'SLB', 'Solomon Islands'], ['SO', 'SOM', 'Somalia'], ['ZA', 'ZAF', 'South Africa'],
  ['GS', 'SGS', 'South Georgia and the South Sandwich Islands'], ['SS', 'SSD', 'South Sudan'], ['ES', 'ESP', 'Spain'],
  ['LK', 'LKA', 'Sri Lanka'], ['SD', 'SDN', 'Sudan'], ['SR', 'SUR', 'Suriname'],
  ['SJ', 'SJM', 'Svalbard and Jan Mayen'], ['SE', 'SWE', 'Sweden'], ['CH', 'CHE', 'Switzerland'],
  ['SY', 'SYR', 'Syria'], ['TW', 'TWN', 'Taiwan'], ['TJ', 'TJK', 'Tajikistan'],
  ['TZ', 'TZA', 'Tanzania'], ['TH', 'THA', 'Thailand'], ['TL', 'TLS', 'Timor-Leste'],
  ['TG', 'TGO', 'Togo'], ['TK', 'TKL', 'Tokelau'], ['TO', 'TON', 'Tonga'],
  ['TT', 'TTO', 'Trinidad and Tobago'], ['TN', 'TUN', 'Tunisia'], ['TR', 'TUR', 'Turkey'],
  ['TM', 'TKM', 'Turkmenistan'], ['TC', 'TCA', 'Turks and Caicos Islands'], ['TV', 'TUV', 'Tuvalu'],
  ['UG', 'UGA', 'Uganda'], ['UA', 'UKR', 'Ukraine'], ['AE', 'ARE', 'United Arab Emirates'],
  ['GB', 'GBR', 'United Kingdom'], ['US', 'USA', 'United States'], ['UM', 'UMI', 'United States Minor Outlying Islands'],
  ['UY', 'URY', 'Uruguay'], ['UZ', 'UZB', 'Uzbekistan'], ['VU', 'VUT', 'Vanuatu'],
  ['VE', 'VEN', 'Venezuela'], ['VN', 'VNM', 'Vietnam'], ['VG', 'VGB', 'Virgin Islands, British'],
  ['VI', 'VIR', 'Virgin Islands, U.S.'], ['WF', 'WLF', 'Wallis and Futuna'], ['EH', 'ESH', 'Western Sahara'],
  ['YE', 'YEM', 'Yemen'], ['ZM', 'ZMB', 'Zambia'], ['ZW', 'ZWE', 'Zimbabwe'],
]);

const iso3ToIso2Map = new Map(ISO_COUNTRIES.map(([alpha2, alpha3]) => [alpha3, alpha2]));
const iso2ToIso3Map = new Map(ISO_COUNTRIES.map(([alpha2, alpha3]) => [alpha2, alpha3]));
const iso2Set = new Set(ISO_COUNTRIES.map(([alpha2]) => alpha2));

/** ISO 3166-1 alpha-3 → alpha-2。未知は undefined。 */
export function iso3ToIso2(code: string): string | undefined {
  const normalized = code.normalize('NFKC').trim().toUpperCase();
  return iso3ToIso2Map.get(normalized);
}

/** ISO 3166-1 alpha-2 → alpha-3。未知は undefined。 */
export function iso2ToIso3(code: string): string | undefined {
  const normalized = code.normalize('NFKC').trim().toUpperCase();
  return iso2ToIso3Map.get(normalized);
}

/** ISO alpha-2 として有効か。 */
export function isIso2(code: string): boolean {
  return iso2Set.has(code.normalize('NFKC').trim().toUpperCase());
}

/** FIPS 10-4 → ISO alpha-2。主要国の curated subset。未知は undefined。 */
const FIPS_TO_ISO2: Readonly<Record<string, string>> = Object.freeze({
  KS: 'KR', JA: 'JP', FR: 'FR', US: 'US', TW: 'TW', ID: 'ID',
  CH: 'CN', RS: 'RU', GM: 'DE', UK: 'GB', IT: 'IT', CA: 'CA',
  AU: 'AU', BR: 'BR', IN: 'IN', MX: 'MX', TH: 'TH', VN: 'VN',
  PH: 'PH', MY: 'MY', SG: 'SG', NZ: 'NZ', ES: 'ES', NL: 'NL',
  BE: 'BE', CHZ: 'CH', SW: 'SE', NO: 'NO', DA: 'DK', FI: 'FI',
  PO: 'PL', CZ: 'CZ', HU: 'HU', GR: 'GR', TU: 'TR', IS: 'IL',
  SA: 'SA', EG: 'EG', ZA: 'ZA', NG: 'NG', KE: 'KE', AR: 'AR',
  CL: 'CL', CO: 'CO', PE: 'PE', VE: 'VE',
});

export function fipsToIso2(code: string): string | undefined {
  const normalized = code.normalize('NFKC').trim().toUpperCase();
  return FIPS_TO_ISO2[normalized];
}

/** CAMEO 国コード → ISO alpha-2。既知の例外のみ明示し、残りは ISO3 として解決する。 */
const CAMEO_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // GDELT CAMEO で ISO3 と異なることが知られているコードのみ列挙する。
  // それ以外は ISO3 解決へフォールスルーする (推測ではなく ISO 対応表の参照)。
});

export function cameoCountryToIso2(code: string): string | undefined {
  const normalized = code.normalize('NFKC').trim().toUpperCase();
  return CAMEO_EXCEPTIONS[normalized] ?? iso3ToIso2(normalized);
}

export type ProviderCountryScheme = 'iso2' | 'iso3' | 'fips' | 'gdelt_geo' | 'gdacs' | 'cameo';

/** Provider境界での国コード正規化。解決不能は undefined (fallback禁止)。 */
export function normalizeProviderCountryCode(
  scheme: ProviderCountryScheme | string,
  code: string | undefined | null,
): string | undefined {
  if (code === undefined || code === null) return undefined;
  const normalized = code.normalize('NFKC').trim();
  if (!normalized) return undefined;
  switch (scheme) {
    case 'iso2':
      return isIso2(normalized) ? normalized.toUpperCase() : undefined;
    case 'iso3':
    case 'cameo':
      return cameoCountryToIso2(normalized);
    case 'gdelt_geo':
      // GDELT の地理コードは FIPS 互換 (例: KS) と CAMEO/ISO3 互換 (例: KOR) が混在する。
      return fipsToIso2(normalized) ?? cameoCountryToIso2(normalized);
    case 'fips':
      return fipsToIso2(normalized);
    case 'gdacs':
      // GDACS の country は ISO3 互換表記で現れる。未知表記は推測しない。
      return cameoCountryToIso2(normalized);
    default:
      return undefined;
  }
}
