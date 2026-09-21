# Sora Country Intelligence v1 Design

## Purpose and boundaries

Country Intelligence adds `research_country_context` as an evidence and context engine. It collects current and historical facts about a country or region, normalizes the supporting evidence, separates duplicate articles from distinct events, and returns an auditable `CountryContextReport`. It does not decide whether a post, trip, advertisement, or investment is safe or appropriate.

The implementation must not introduce sentiment, hostility, anti-Japan, or risk scores. It must not infer that missing evidence means normal conditions. Ambiguous actors, targets, locations, dates, or source relationships remain `unknown`, and those gaps appear in coverage output.

The engine is comprehensive by default. Omitting `topics` asks every enabled provider for the areas it can cover, within bounded request and crawl limits. Explicit topics reduce the plan but do not alter the meaning of collected evidence.

## Architecture

The feature lives under `src/services/country_intel/` and exposes one orchestration entry point:

```ts
researchCountryContext(request, dependencies?): Promise<CountryContextReport>
```

The subsystem has six boundaries:

1. **Identity and planning** resolves the requested region conservatively and creates a two-pass acquisition plan.
2. **Provider adapters** translate external structured data or existing Sora search results into provider-neutral acquisition items.
3. **Evidence normalization** assigns stable IDs, preserves publisher/event geography separately, canonicalizes URLs, and removes exact content duplicates.
4. **Event construction** performs deterministic structural extraction and conservative clustering, then calculates independent source families.
5. **Context assembly** builds situation sections, calendars, foreign relations, the Japan projection, temporal metrics, coverage, and missing-evidence statements.
6. **Persistence** stores source registry entries, provider runs, evidence, events, polls, metrics, calendars, and reports in the existing SQLite database.

All pure transformations accept explicit inputs and clocks. Network and database dependencies are injected at the provider and orchestration boundaries so fixture tests remain offline and deterministic.

## Region identity and query planning

`resolveRegion` normalizes country codes, common English names, native names, and a small protocol-level alias dataset derived from ISO country identity. It may return a country, subdivision, or unresolved regional identity. A low-confidence result is retained instead of silently selecting a country.

Country-specific political or sentiment rules are forbidden. Aliases only establish geographic identity. The initial implementation supports country-level identities broadly and preserves unresolved subdivision input with `parentCountryCode` only when deterministically known.

The query planner receives the region identity, requested period, optional query and topics, languages, provider capabilities, and verified source registry entries. Pass 1 requests structured providers, official sources, calendar data, current events, polls, and major media. Pass 2 may use entities, counterpart countries, and event topics discovered in Pass 1. Both passes have explicit query and item caps; there is no unbounded crawl.

## Provider model and v1 coverage

Every provider implements a common descriptor and runner:

```ts
interface CountryIntelProvider {
  id: string;
  areas: CoverageArea[];
  latencyClass: CountryEvidence['latencyClass'];
  defaultTtlSeconds: number;
  run(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult>;
}
```

The registry wraps each provider with a timeout, bounded retry policy, cache, and status conversion. A failure produces a `ProviderRun` with `unavailable`, `rate_limited`, `partial`, or `error`; it does not reject the complete report.

The v1 core adapters are:

- **GDELT DOC** for broad current-event and media discovery. Its source country is stored as publisher geography, never event geography.
- **GDELT Events** where structured event fields are available, used conservatively for event geography and historical counts.
- **GDACS** for structured disaster alerts and locations.
- **World Bank** for slow-changing economic indicators and historical context.
- **Nager.Holidays** for public holidays.
- **Wikidata** for source and identity discovery only; it cannot be the final evidence for important political or security claims.
- **Official/generic web** through existing Sora web search and scraping for official and primary-source discovery.
- **Yahoo realtime** as optional Japanese-language social observation when `includeSocial` is true. It is never treated as representative public opinion.

Provider contracts exist for later WHO, UNHCR, OECD, Eurostat, UCDP, Crossref, International IDEA, UN Observances, Bluesky, and Mastodon adapters. v1 reports these areas as missing or unavailable unless a concrete adapter returned evidence; placeholder network calls are not created.

All provider parser tests use saved fixtures. Live provider checks run only through `bun run test:intel:live`.

## Evidence, events, and source independence

`CountryEvidence` is the source of truth for claims in a report. Stable evidence IDs derive from canonical URL, publisher, publication time, and content hash. URL canonicalization removes tracking parameters without changing semantic path or query parameters. Content dedup uses normalized text hashes.

Publisher geography, event geography, and mentioned countries are separate fields throughout acquisition, persistence, and output. Provider adapters may leave event geography undefined when only publisher geography is known.

Structural extraction follows this order:

1. Structured provider fields.
2. Official metadata.
3. JSON-LD and schema.org fields.
4. HTML metadata.
5. Small deterministic dictionaries for generic actor/action/target ontology.
6. Conservative text patterns.
7. `unknown` or `none`.

Quoted attribution takes precedence over publisher identity. A newspaper quoting a politician records the politician as actor and the newspaper only as publisher. Target patterns distinguish a government, people/nationality, company, product, culture, territory, policy, and institution. Japanese government and Japanese people can never collapse into the same target type.

Clustering uses action type, overlapping canonical entities, event location, bounded time distance, normalized title tokens, content similarity, canonical URLs, and wire family. A cluster merge requires multiple compatible signals; false splits are preferred over false merges. Article count remains the number of evidence items, while event count is the number of clusters.

Source independence groups evidence by canonical source, known wire family, syndication signature, and publisher domain/ownership when known. Reuters, AP, and AFP copies count as one source family unless an independent primary source is also present. The source-family mechanism is generic and does not encode political trust or sentiment.

## Polls, calendar, and foreign relations

Representative polls require question wording, response distribution, pollster, source URL, and evidence. Field dates, population, sample size, mode, sampling, weighting, margin of error, and sponsor are preserved when available. Polls are comparable only when normalized question wording, population, and mode match sufficiently. Social observations never enter poll series.

Calendar entries preserve date, title, official status, commemoration subject, and related countries. Calendar entries receive no sensitivity or risk labels. Public-holiday normalization uses the region timezone so a UTC boundary cannot shift the local date.

Foreign relations are derived from event targets and mentioned counterpart countries. Each counterpart receives official, protest, trade, business, cultural, and violence event lists plus polls and media metrics. When the counterpart is `JP`, the report also exposes a convenience `JapanContextView`; the underlying event and relation records remain generic.

## Temporal context

Metrics use available windows from `6h`, `24h`, `7d`, `30d`, `90d`, `180d`, and `365d`. The first release computes event-cluster rate, independent-source event rate, official event count, protest count, violence count, boycott count, media cluster count, and social observation count when data supports them.

Historical samples prefer structured external history, then locally observed daily metrics, with origin recorded as `external_historical`, `local_observed`, `mixed`, or `insufficient`. Cold start never fabricates a stable baseline.

For at least three usable historical samples, anomaly is:

```text
0.6745 * (current - median) / (MAD + epsilon)
```

The result is clipped to `[-6, 6]`. Direction is derived from current versus median with a deterministic tolerance. An anomaly describes activity volume only and is not converted to danger or sentiment.

## Persistence and migrations

The existing `bun:sqlite` database remains the source of truth. `src/db.ts` will gain a generic migration runner and create `schema_migrations` without recreating or renaming current Watch, cache, cookie, or storage tables. Country Intelligence migrations are ordered SQL migrations and run in transactions.

The initial migration creates:

- `country_sources`
- `intel_provider_runs`
- `intel_evidence`
- `intel_events`
- `intel_event_evidence`
- `intel_poll_observations`
- `intel_daily_metrics`
- `intel_reports`
- `intel_calendar_events`

Entities and targets are stored in event JSON for v1 because access is report/event scoped; normalized relational entity tables are deferred until query patterns justify them. Foreign keys and indexes cover region, report, event, evidence, provider, source domain, publication time, observation date, and expiry.

Reports and evidence are inserted transactionally after assembly. Retrieval by `contextId` reads the stored report. Provider cache uses existing SQLite cache primitives with provider-specific TTLs. `noCache` bypasses reads but still records evidence, provider runs, metrics, and the final report.

Maintenance exposes an internal DAO operation for retention prune, passive WAL checkpoint, and DB size metrics. Default retention is 180 days for evidence excerpts, 90 days for reports, at least one year for events, and at least two years for daily metrics; sources and polls are retained indefinitely. Pruning deletes only expired Country Intelligence rows and relies on foreign keys for join cleanup.

For non-test operation, the default remains `./data/sora.db`. Startup emits a warning when the resolved path appears container-ephemeral. Docker documentation recommends `SORA_DB_PATH=/data/sora.db` and a `/data` volume; the image declares `VOLUME ["/data"]` without forcing existing installations to change paths.

## Report assembly and coverage

Situation sections contain evidence-backed factual statements generated from structured event fields. They do not contain purpose-dependent recommendations. Every summary fact links to event and evidence IDs.

Coverage is computed from successful provider areas, evidence freshness, primary-source presence, and provider failures. `good`, `partial`, and `limited` describe collection coverage only. Missing evidence contains concrete statements such as absent recent representative polls, limited social sampling, missing primary evidence for an event, or delayed historical data.

Evidence strength is derived as `PRIMARY`, `CORROBORATED`, `SECONDARY`, `WEAK`, or `UNVERIFIED` from source structure and corroboration. No probability is emitted.

## REST, MCP, and OpenAPI

`CountryContextRequestSchema` validates:

- required non-empty `region`
- optional `query`
- optional topic enum array
- `period` defaulting to `30d`
- `includeSocial` defaulting to `false`
- `noCache` and `verbose` defaulting to `false`

REST adds:

- `POST /intelligence/country` to generate and persist a report
- `GET /intelligence/context/:contextId` to retrieve a persisted report or return 404

MCP adds module `intel` and one core tool, `research_country_context`, backed by the same request schema and service. No social-post endpoint or decision tool is registered.

OpenAPI exports component schemas for Evidence, Event, Poll, Calendar, ForeignRelation, TemporalMetric, Coverage, ProviderRun, RegionIdentity, SituationSection, and CountryContextReport, and documents both REST routes. Contract tests compare REST, MCP, and OpenAPI input fields and enums.

## Error handling and observability

Invalid requests return 400. Unknown persisted contexts return 404. A complete orchestration failure returns 500 only when the report cannot be assembled or persisted. Individual provider errors remain in `providerCoverage` and may yield a limited but successful report.

Verbose reports may include planner and provider diagnostics, but never raw credentials or unrestricted article bodies. Provider latency, status, item count, coverage areas, and stable error codes are persisted. Health output may report Country Intelligence DB readiness without probing live providers.

## Testing strategy

Pure unit tests cover region resolution, evidence normalization, geography separation, URL/content/wire deduplication, conservative event clustering, false-merge resistance, independent-source counts, actor attribution, government-versus-people targets, boycott and disaster fixtures, poll comparability, calendar timezone boundaries, MAD anomaly, cold start, coverage degradation, and partial provider failure.

Database tests use temporary SQLite files and cover migration from a database containing existing Watch tables, restart persistence, reopen behavior, foreign keys, indexes, prune, checkpoint, and DB metrics. They assert that existing Watch records survive migrations.

Provider tests parse local fixtures and make no network requests. REST and MCP tests use injected providers to verify equivalent reports and retrieval. OpenAPI contract tests verify schemas and paths. The normal `bun test` suite remains offline for all new tests.

The separate live smoke command runs bounded checks for South Korea, Taiwan, United States, France, and Indonesia. It reports provider connectivity, parser drift, content type, normalized dates, event extraction, and coverage. Live smoke failures are reported but do not alter fixture test status.

## Release and compatibility

The feature is a `v2.26.0` minor-release candidate. Version files change only in the repository's release step after implementation and verification. Existing Tracking, Watch, Search, Browser, Yahoo, Media, routes, schemas, and tables remain backward compatible. The feature branch starts from current `origin/main` commit `6f7616f`, which already includes the LibreChat deferred-tool fixes beyond the `d0894c6` reference in the original instruction.
