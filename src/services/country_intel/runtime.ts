import { researchCountryContext, type ResearchDependencies } from './report.js';
import { createGdacsProvider } from './providers/gdacs.js';
import { createGdeltEventsProvider } from './providers/gdelt_events.js';
import { createGdeltProvider, type GdeltFetch } from './providers/gdelt.js';
import { createNagerProvider } from './providers/nager.js';
import { createWikidataProvider } from './providers/wikidata.js';
import { createWorldBankProvider } from './providers/worldbank.js';
import type { CountryContextReport, CountryContextRequest } from './types.js';

/** fetch 注入のみで構成できる default provider。official_web / yahoo_realtime は別途追加する。 */
export const defaultCountryIntelProviderIds = [
  'gdelt', 'gdelt_events', 'gdacs', 'worldbank', 'nager', 'wikidata',
] as const;

export interface DefaultRuntimeOptions {
  fetchFn?: GdeltFetch;
}

export function createDefaultCountryIntelDependencies(
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): ResearchDependencies {
  const fetchFn = options.fetchFn;
  return {
    ...overrides,
    providers: [
      createGdeltProvider(fetchFn),
      createGdeltEventsProvider(fetchFn),
      createGdacsProvider(fetchFn),
      createWorldBankProvider(fetchFn),
      createNagerProvider(fetchFn),
      createWikidataProvider(fetchFn),
    ],
  };
}

/** REST / MCP 共通の default 実行口。report() 自体は injectable なまま維持する。 */
export function researchCountryWithDefaults(
  request: CountryContextRequest,
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): Promise<CountryContextReport> {
  return researchCountryContext(request, createDefaultCountryIntelDependencies(overrides, options));
}
