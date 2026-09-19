# Country Intelligence v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, evidence-backed `research_country_context` engine that returns structured country context without semantic risk or sentiment judgments.

**Architecture:** A deterministic pipeline resolves a region, runs isolated provider adapters, normalizes evidence, clusters events, computes factual temporal context, persists the result in SQLite, and exposes the same contract through REST and MCP. Providers fail independently and coverage explicitly records missing or unavailable evidence.

**Tech Stack:** Bun 1.x, TypeScript, `bun:sqlite`, Zod 4, Hono, MCP SDK, built-in `fetch`, existing Sora search/scrape services.

**Spec:** `docs/superpowers/specs/2026-09-19-country-intelligence-v1-design.md`

## Global Constraints

- Work only on `feat/country-intelligence-v1`, based on `origin/main` commit `6f7616f7052d7d959f9ea9c56a04f01a6d074dcf` or a later explicitly rebased `origin/main`.
- Add only `research_country_context`; do not add social-post assessment or decision endpoints.
- Do not add sentiment, hostility, anti-Japan, safety, or risk classifiers or scores.
- Use no API key, registration, authenticated provider, LLM, or new runtime dependency.
- Keep publisher country, event country, and mentioned countries separate.
- Keep article/evidence count, event cluster count, and independent source count separate.
- A single provider failure must not fail the complete report.
- SQLite at `SORA_DB_PATH` is the historical source of truth; in-memory-only persistence is forbidden outside tests.
- All new normal-suite tests are fixture-based and offline; live checks run only with `bun run test:intel:live`.
- Existing Tracking, Watch, Search, Browser, Yahoo, Media, database tables, and API contracts remain compatible.

## Review Focus

- Ambiguous region input such as `Georgia` must remain low-confidence rather than silently selecting a country or US state; Task 1 pins this behavior.
- Provider output with publisher geography but no event geography must never copy `publisherCountry` into `eventCountry`; Task 2 pins this behavior.
- Twenty syndicated copies of one wire story must form one event while preserving twenty evidence rows and one source family; Task 3 pins this behavior.
- A provider timeout or 429 alongside successful providers must return a partial report with failure coverage rather than 500; Tasks 6 and 9 pin this behavior.
- Migration of an existing database containing Watch rows must preserve those rows across close/reopen and Country Intelligence pruning; Task 5 pins this behavior.

---

## File map

New production files:

- `src/services/country_intel/types.ts` — domain interfaces, enums, and Zod request/response schemas.
- `src/services/country_intel/region.ts` — conservative region identity resolution.
- `src/services/country_intel/query_planner.ts` — bounded two-pass plans.
- `src/services/country_intel/evidence.ts` — URL/content normalization and stable evidence IDs.
- `src/services/country_intel/event_extract.ts` — deterministic actor, action, target, time, and location extraction.
- `src/services/country_intel/event_cluster.ts` — conservative event clustering and independent-source grouping.
- `src/services/country_intel/context.ts` — polls, calendar, foreign relations, Japan projection, coverage, and temporal calculations.
- `src/services/country_intel/db.ts` — Country Intelligence DAO, retention, checkpoint, and DB metrics.
- `src/services/country_intel/provider_registry.ts` — provider isolation, timeouts, cache, and run records.
- `src/services/country_intel/source_registry.ts` — candidate discovery/verification state.
- `src/services/country_intel/providers/*.ts` — GDELT, GDACS, World Bank, Nager, Wikidata, web, and Yahoo realtime adapters.
- `src/services/country_intel/report.ts` — orchestration and report assembly.
- `src/services/country_intel/index.ts` — public exports and default dependency wiring.
- `src/routes/intelligence.ts` — REST generation and retrieval routes.
- `src/services/country_intel/live_smoke.ts` — opt-in live smoke command.

Modified production files:

- `src/db.ts` — versioned migration runner hook while preserving existing tables.
- `src/index.ts` and `src/routes/system.ts` — mount and advertise REST endpoints.
- `src/mcp.ts` — `intel` module and one MCP tool.
- `src/types.ts` — OpenAPI paths and exported schemas.
- `Dockerfile`, `Containerfile`, `package.json`, `README.md`, `RELEASE_NOTES.md` — persistence, smoke script, documentation, and release notes.

Tests and fixtures live next to `src/services/country_intel/` in focused `*.test.ts` files and `fixtures/` JSON files.

### Task 1: Domain contracts and conservative region resolver

**Files:**
- Create: `src/services/country_intel/types.ts`
- Create: `src/services/country_intel/region.ts`
- Create: `src/services/country_intel/region.test.ts`

**Interfaces:**
- Produces: `CountryContextRequestSchema`, `CountryContextReportSchema`, all interfaces from the design spec, and `resolveRegion(input: string): RegionIdentity`.
- Consumes: Zod and standard ISO-style country identifiers embedded as geographic identity data only.

- [ ] **Step 1: Write failing contract and region tests**

```ts
import { expect, test } from 'bun:test';
import { CountryContextRequestSchema } from './types.js';
import { resolveRegion } from './region.js';

test('request defaults to comprehensive 30d collection without social', () => {
  expect(CountryContextRequestSchema.parse({ region: 'KR' })).toEqual({
    region: 'KR', period: '30d', includeSocial: false, noCache: false, verbose: false,
  });
});

test('resolves deterministic country identities and preserves ambiguity', () => {
  expect(resolveRegion('South Korea')).toMatchObject({ countryCode: 'KR', confidence: 'high' });
  expect(resolveRegion('대한민국')).toMatchObject({ countryCode: 'KR', confidence: 'high' });
  expect(resolveRegion('Georgia')).toMatchObject({ name: 'Georgia', confidence: 'low' });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/region.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the domain schemas and resolver**

Define the exact enums and interfaces in sections 5–39 of the spec. Use Zod schemas as the runtime source for request and report validation. Implement region normalization with an immutable identity table and this result rule:

```ts
export function resolveRegion(input: string): RegionIdentity {
  const normalized = input.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const matches = REGION_IDENTITIES.filter((region) =>
    [region.id, region.name, region.nativeName, region.countryCode, ...region.aliases]
      .filter(Boolean).some((value) => value!.toLocaleLowerCase('en-US') === normalized));
  if (matches.length === 1) return { ...matches[0], confidence: 'high' };
  return { id: `unresolved:${normalized}`, name: input.trim(), languages: [], aliases: [], confidence: 'low' };
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/services/country_intel/region.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/country_intel/types.ts src/services/country_intel/region.ts src/services/country_intel/region.test.ts
git commit -m "feat(intel): define country context contracts"
```

### Task 2: Evidence normalization and geographic integrity

**Files:**
- Create: `src/services/country_intel/evidence.ts`
- Create: `src/services/country_intel/evidence.test.ts`

**Interfaces:**
- Consumes: `CountryEvidence`, `RegionIdentity` from Task 1.
- Produces: `canonicalizeEvidenceUrl(url: string): string`, `hashEvidenceContent(text: string): string`, `normalizeEvidence(input, region, now): CountryEvidence`, and `deduplicateEvidence(items): CountryEvidence[]`.

- [ ] **Step 1: Write failing normalization tests**

```ts
test('keeps publisher and event geography independent', () => {
  const evidence = normalizeEvidence({
    url: 'https://reuters.com/a?utm_source=x', title: 'Japan earthquake',
    publisherCountry: 'GB', mentionedCountries: ['JP'], sourceType: 'international_media',
    primarySource: false, latencyClass: 'near_realtime',
  }, japan, new Date('2026-09-19T00:00:00Z'));
  expect(evidence.publisherCountry).toBe('GB');
  expect(evidence.eventCountry).toBeUndefined();
  expect(evidence.url).toBe('https://reuters.com/a');
});

test('deduplicates canonical URLs and exact normalized content', () => {
  expect(deduplicateEvidence([trackingUrlCopy, canonical, exactContentCopy])).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/evidence.test.ts`

Expected: FAIL because normalization functions do not exist.

- [ ] **Step 3: Implement deterministic normalization**

Use `URL` to remove `utm_*`, `fbclid`, and `gclid`, sort remaining parameters, remove fragments, and preserve meaningful query parameters. Hash NFKC text with collapsed whitespace using `createHash('sha256')`. Generate IDs from region, canonical URL, publication timestamp, and content hash. Never infer `eventCountry` from publisher metadata.

```ts
const idMaterial = [region.id, canonicalUrl, input.publishedAt ?? '', contentHash ?? ''].join('\n');
const id = `evd_${createHash('sha256').update(idMaterial).digest('hex').slice(0, 20)}`;
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test src/services/country_intel/evidence.test.ts`

```bash
git add src/services/country_intel/evidence.ts src/services/country_intel/evidence.test.ts
git commit -m "feat(intel): normalize auditable evidence"
```

### Task 3: Structural extraction, event clustering, and source independence

**Files:**
- Create: `src/services/country_intel/event_extract.ts`
- Create: `src/services/country_intel/event_cluster.ts`
- Create: `src/services/country_intel/event_cluster.test.ts`
- Create: `src/services/country_intel/fixtures/critical_events.json`
- Create: `src/services/country_intel/fixtures/wire_syndication.json`

**Interfaces:**
- Consumes: normalized `CountryEvidence`.
- Produces: `extractEvent(evidence, region, now): IntelEventDraft | undefined`, `clusterEvents(drafts, evidence): IntelEvent[]`, `sourceFamily(evidence): string`.

- [ ] **Step 1: Add failing critical-fixture tests**

```ts
test.each([
  ['日本で大地震', 'disaster_response'],
  ['日本製品不買イベント', 'boycott'],
  ['歴史記念日の記事', 'memorial_event'],
])('extracts factual action for %s', (fixture, type) => {
  expect(extractEvent(evidenceFor(fixture), region, now)?.type).toBe(type);
});

test('separates Japanese government from Japanese people', () => {
  const event = extractEvent(evidenceFor('日本政府の政策を批判'), region, now)!;
  expect(event.targets).toContainEqual(expect.objectContaining({ type: 'foreign_government' }));
  expect(event.targets).not.toContainEqual(expect.objectContaining({ type: 'people_nationality' }));
});

test('attributes a quoted statement to the politician, not the publisher', () => {
  const event = extractEvent(evidenceFor('新聞が政治家の日本批判を引用'), region, now)!;
  expect(event.actors[0].type).toBe('politician');
});

test('clusters twenty wire copies as one event and one independent family', () => {
  const events = clusterEvents(wireDrafts, wireEvidence);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ evidenceCount: 20, independentSourceCount: 1 });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/event_cluster.test.ts`

Expected: FAIL because extractors and clustering do not exist.

- [ ] **Step 3: Implement conservative extraction and clustering**

Implement precedence as structured fields → metadata → deterministic patterns → unknown. Keep a small generic ontology of action phrases and target forms. Require compatible action type plus at least two of entity overlap, location match, time proximity, title Jaccard ≥ 0.72, content hash, or canonical/wire family before merging.

```ts
const merge = sameAction && [entityOverlap, sameLocation, nearTime, titleSimilarity >= 0.72,
  sameCanonicalUrl, sameContentHash].filter(Boolean).length >= 2;
```

Compute independent families from canonical primary domain, explicit provider wire metadata, and syndication title/content signatures. Do not encode publisher ideology or trust.

- [ ] **Step 4: Verify GREEN and false-merge resistance**

Run: `bun test src/services/country_intel/event_cluster.test.ts`

Expected: PASS, including a fixture where same-country protests on different dates remain separate.

- [ ] **Step 5: Commit**

```bash
git add src/services/country_intel/event_extract.ts src/services/country_intel/event_cluster.ts src/services/country_intel/event_cluster.test.ts src/services/country_intel/fixtures
git commit -m "feat(intel): extract and cluster factual events"
```

### Task 4: Context calculations

**Files:**
- Create: `src/services/country_intel/context.ts`
- Create: `src/services/country_intel/context.test.ts`

**Interfaces:**
- Consumes: events, evidence, polls, calendars, provider runs, historical metric samples.
- Produces: `pollsComparable`, `normalizeCalendarDate`, `buildForeignRelations`, `buildJapanView`, `computeTemporalMetric`, and `buildCoverage`.

- [ ] **Step 1: Write failing tests for factual context**

```ts
test('compares polls only when wording population and mode align', () => {
  expect(pollsComparable(basePoll, { ...basePoll, pollster: 'Other' })).toBe(true);
  expect(pollsComparable(basePoll, { ...basePoll, mode: 'online' })).toBe(false);
});

test('normalizes calendar date in the region timezone', () => {
  expect(normalizeCalendarDate('2026-01-01T00:30:00+09:00', 'Asia/Tokyo')).toBe('2026-01-01');
});

test('computes clipped MAD anomaly without semantic labels', () => {
  expect(computeTemporalMetric('protest_event_count', 12, '7d', [1, 1, 2, 2, 3], 'external_historical'))
    .toMatchObject({ anomalyZ: 6, direction: 'rising' });
});

test('cold start records insufficient baseline', () => {
  expect(computeTemporalMetric('media_cluster_count', 2, '24h', [], 'insufficient').baseline)
    .toEqual({ sampleCount: 0, origin: 'insufficient' });
});
```

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run RED and GREEN with: `bun test src/services/country_intel/context.test.ts`

Implement median/MAD with epsilon `1e-9`, clip to `[-6, 6]`, generic counterpart grouping, JP projection only when a relation has `counterpartCountryCode === 'JP'`, and coverage degradation based on provider area statuses and evidence presence.

- [ ] **Step 3: Commit**

```bash
git add src/services/country_intel/context.ts src/services/country_intel/context.test.ts
git commit -m "feat(intel): build temporal and relation context"
```

### Task 5: Versioned SQLite migrations, DAO, and maintenance

**Files:**
- Modify: `src/db.ts`
- Create: `src/services/country_intel/db.ts`
- Create: `src/services/country_intel/db.test.ts`

**Interfaces:**
- Consumes: existing `getDb()`/`initDatabase()` and Country Intelligence domain records.
- Produces: `runMigrations(db)`, `saveCountryContext(report, records)`, `getCountryContext(contextId)`, `pruneCountryIntel(now)`, `checkpointCountryIntel()`, `getCountryIntelDbMetrics()`.

- [ ] **Step 1: Write migration and persistence tests against a temporary file**

Create a database with a Watch row before running migrations, close/reopen it, and assert:

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  'schema_migrations', 'country_sources', 'intel_provider_runs', 'intel_evidence',
  'intel_events', 'intel_event_evidence', 'intel_poll_observations',
  'intel_daily_metrics', 'intel_reports', 'intel_calendar_events',
]));
expect(reopened.query('SELECT id FROM watch_targets').get()).toEqual({ id: 'watch-existing' });
expect(getCountryContext('ctx_test')?.contextId).toBe('ctx_test');
expect(foreignKeys).toBe(1);
```

Add prune assertions showing expired reports/evidence are removed while Watch rows, sources, polls, recent events, and two-year metrics remain. Assert required indexes through `PRAGMA index_list` and checkpoint returns a nonnegative frame count.

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/db.test.ts`

Expected: FAIL because migrations and DAO do not exist.

- [ ] **Step 3: Add transactional migrations and DAO**

Add a generic migration list to `src/db.ts`:

```ts
export interface DbMigration { version: number; name: string; up: (db: Database) => void }
export function applyMigrations(db: Database, migrations: DbMigration[]): void {
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const apply = db.transaction((migration: DbMigration) => {
    migration.up(db);
    db.query('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, Date.now());
  });
  for (const migration of migrations) if (!hasMigration(db, migration.version)) apply(migration);
}
```

Use integer epoch milliseconds for indexed timestamps and JSON only for structured payload fields. Wrap report, provider-run, evidence, event, join, poll, calendar, and daily-metric writes in one transaction.

- [ ] **Step 4: Verify GREEN and existing Watch tests**

Run:

```bash
bun test src/services/country_intel/db.test.ts
bun test src/index.test.ts --test-name-pattern "SQLite|watch"
```

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/services/country_intel/db.ts src/services/country_intel/db.test.ts
git commit -m "feat(intel): persist country intelligence history"
```

### Task 6: Provider registry, source verification, isolation, and cache

**Files:**
- Create: `src/services/country_intel/provider_registry.ts`
- Create: `src/services/country_intel/source_registry.ts`
- Create: `src/services/country_intel/query_planner.ts`
- Create: `src/services/country_intel/provider_registry.test.ts`

**Interfaces:**
- Consumes: provider interface, `CountryContextRequest`, region identity, existing persistent cache DAO.
- Produces: `runProviders(plan, providers, options): Promise<AcquisitionResult>`, `planCountryResearch`, `verifyCountrySource`, and two-pass bounded plan types.

- [ ] **Step 1: Write failing isolation and planning tests**

```ts
test('keeps successful evidence when another provider is rate limited', async () => {
  const result = await runProviders(plan, [successfulProvider, rateLimitedProvider], options);
  expect(result.items).toHaveLength(1);
  expect(result.runs.map((run) => run.status)).toEqual(['success', 'rate_limited']);
});

test('times out one provider without rejecting the acquisition', async () => {
  const result = await runProviders(plan, [neverResolvingProvider], { ...options, timeoutMs: 10 });
  expect(result.runs[0]).toMatchObject({ status: 'unavailable', errorCode: 'PROVIDER_TIMEOUT' });
});

test('caps two-pass plans', () => {
  const plan = planCountryResearch(request, region, capabilities, verifiedSources);
  expect(plan.pass1.length).toBeLessThanOrEqual(12);
  expect(plan.limits.maxPass2Queries).toBe(8);
});

test('does not trust an unverified discovered source', async () => {
  const source = await verifyCountrySource(candidate, verificationDependencies);
  expect(source.verificationStatus).toBe('candidate');
  expect(source.verifiedAt).toBeUndefined();
});
```

- [ ] **Step 2: Verify RED, implement registry, and verify GREEN**

Run: `bun test src/services/country_intel/provider_registry.test.ts`

Use `AbortSignal.timeout`, one retry only for transient 5xx/network failures, no retry for 4xx except one `Retry-After`-bounded 429 retry, provider TTL cache keys including region/topics/period/query, and explicit status mapping. `noCache` skips reads. Verify source candidates by HTTPS, redirects, official cross-links when present, consistency, and recent availability; unverified candidates remain `candidate`.

- [ ] **Step 3: Commit**

```bash
git add src/services/country_intel/provider_registry.ts src/services/country_intel/source_registry.ts src/services/country_intel/query_planner.ts src/services/country_intel/provider_registry.test.ts
git commit -m "feat(intel): isolate country data providers"
```

### Task 7: Structured provider adapters and fixture parsers

**Files:**
- Create: `src/services/country_intel/providers/gdelt.ts`
- Create: `src/services/country_intel/providers/gdelt_events.ts`
- Create: `src/services/country_intel/providers/gdacs.ts`
- Create: `src/services/country_intel/providers/worldbank.ts`
- Create: `src/services/country_intel/providers/nager.ts`
- Create: `src/services/country_intel/providers/wikidata.ts`
- Create: `src/services/country_intel/providers/providers.test.ts`
- Create: `src/services/country_intel/fixtures/{gdelt,gdelt_events,gdacs,worldbank,nager,wikidata}.json`

**Interfaces:**
- Consumes: `ProviderInput`, fetch injection, provider-neutral acquisition item types.
- Produces: six `CountryIntelProvider` implementations and pure `parse*Response` functions.

- [ ] **Step 1: Save minimal representative fixtures and write parser tests**

Tests must assert exact URLs, dates, source types, latency classes, provider/event geography, calendar local dates, economic observation values, and Wikidata discovery-only tagging. Include this GDELT invariant:

```ts
const [item] = parseGdeltDocResponse(fixture, input);
expect(item.evidence.publisherCountry).toBe('US');
expect(item.evidence.eventCountry).toBeUndefined();
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/providers/providers.test.ts`

Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Implement pure parsers and bounded fetchers**

Each adapter validates content type and required envelope fields before parsing. URL builders use `URLSearchParams`, explicit result limits, region code, and period bounds. Wikidata outputs source candidates only. World Bank outputs temporal observations, not events. Nager outputs calendars, not risk indicators.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test src/services/country_intel/providers/providers.test.ts`

```bash
git add src/services/country_intel/providers src/services/country_intel/fixtures
git commit -m "feat(intel): add structured public providers"
```

### Task 8: Existing Sora web and social adapters

**Files:**
- Create: `src/services/country_intel/providers/official_web.ts`
- Create: `src/services/country_intel/providers/yahoo_realtime_jp.ts`
- Create: `src/services/country_intel/providers/web_adapters.test.ts`

**Interfaces:**
- Consumes: injected `searchYahooWeb`, `scrapeUrl`, and `searchYahooRealtime` functions.
- Produces: official/media evidence and optional social observations in provider-neutral form.

- [ ] **Step 1: Write failing adapter tests with injected fixtures**

Assert official-domain results become `official` candidates only after verification, media remains media evidence, social is omitted when `includeSocial:false`, Yahoo realtime declares Japanese/Japan-proxy coverage, and no social item creates a poll.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run RED and GREEN with: `bun test src/services/country_intel/providers/web_adapters.test.ts`

Limit official web queries to planner caps, scrape only verified/candidate official URLs selected in Pass 2, and keep excerpts bounded. Map Yahoo errors to provider statuses rather than empty successful observations.

- [ ] **Step 3: Commit**

```bash
git add src/services/country_intel/providers/official_web.ts src/services/country_intel/providers/yahoo_realtime_jp.ts src/services/country_intel/providers/web_adapters.test.ts
git commit -m "feat(intel): bridge existing web and social evidence"
```

### Task 9: Report orchestration and persistence

**Files:**
- Create: `src/services/country_intel/report.ts`
- Create: `src/services/country_intel/index.ts`
- Create: `src/services/country_intel/report.test.ts`

**Interfaces:**
- Consumes: all Tasks 1–8 interfaces.
- Produces: `researchCountryContext(request, dependencies?): Promise<CountryContextReport>` and `getPersistedCountryContext(contextId)`.

- [ ] **Step 1: Write failing end-to-end service tests with fixture providers**

```ts
test('assembles and persists a comprehensive evidence-backed report', async () => {
  const report = await researchCountryContext({ region: 'South Korea' }, fixtureDependencies);
  expect(report.region.countryCode).toBe('KR');
  expect(report.keyEvents.length).toBeGreaterThan(0);
  expect(report.evidence.length).toBeGreaterThan(0);
  expect(getPersistedCountryContext(report.contextId)).toEqual(report);
});

test('returns partial report when a provider returns 429', async () => {
  const report = await researchCountryContext({ region: 'KR' }, partialDependencies);
  expect(report.coverage.overall).toBe('partial');
  expect(report.providerCoverage).toContainEqual(expect.objectContaining({ status: 'rate_limited' }));
});

test('creates Japan projection without semantic scores', async () => {
  const report = await researchCountryContext({ region: 'KR' }, japanRelationDependencies);
  expect(report.japan?.countryCode).toBe('JP');
  expect(JSON.stringify(report)).not.toMatch(/antiJapan|hostility|riskScore/i);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/report.test.ts`

- [ ] **Step 3: Implement orchestration**

Resolve region, plan Pass 1, acquire, normalize/extract/cluster, plan bounded Pass 2, merge new evidence, build relations/calendar/polls/metrics/coverage, validate with `CountryContextReportSchema`, then persist transactionally. Generate `contextId` from `randomUUID`; use an injected `now()` in tests.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test src/services/country_intel/report.test.ts`

```bash
git add src/services/country_intel/report.ts src/services/country_intel/index.ts src/services/country_intel/report.test.ts
git commit -m "feat(intel): assemble country context reports"
```

### Task 10: REST endpoints and system metadata

**Files:**
- Create: `src/routes/intelligence.ts`
- Modify: `src/index.ts`
- Modify: `src/routes/system.ts`
- Create: `src/services/country_intel/rest.test.ts`

**Interfaces:**
- Consumes: Task 9 service and Task 1 request schema.
- Produces: `POST /intelligence/country`, `GET /intelligence/context/:contextId`.

- [ ] **Step 1: Write failing REST tests**

Test valid generation, default values, invalid/ambiguous empty input returning 400, persisted retrieval returning 200, unknown ID returning 404, and provider partial failure returning 200 with partial coverage.

```ts
expect((await app.request('/intelligence/country', { method: 'POST', body: '{}' })).status).toBe(400);
expect((await app.request('/intelligence/context/missing')).status).toBe(404);
```

- [ ] **Step 2: Verify RED, implement routes, and verify GREEN**

Run: `bun test src/services/country_intel/rest.test.ts`

Use `formatError` with stable codes `INVALID_COUNTRY_CONTEXT_REQUEST`, `COUNTRY_CONTEXT_NOT_FOUND`, and `COUNTRY_CONTEXT_ERROR`. Mount `intelligenceRoutes` once in `src/index.ts` and advertise both endpoints in system metadata.

- [ ] **Step 3: Commit**

```bash
git add src/routes/intelligence.ts src/index.ts src/routes/system.ts src/services/country_intel/rest.test.ts
git commit -m "feat(intel): expose country context REST API"
```

### Task 11: MCP module and OpenAPI contract synchronization

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/types.ts`
- Create: `src/services/country_intel/contracts.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and Task 9 service.
- Produces: module `intel`, core MCP tool `research_country_context`, OpenAPI component schemas and two REST paths.

- [ ] **Step 1: Write failing MCP/OpenAPI parity tests**

Assert `createMcpServer({ modules:['intel'] })` exposes only `search_tools` plus `research_country_context` as applicable, its Zod input keys equal `CountryContextRequestSchema.shape`, disabled intel modules never register the tool, the handler returns a validated report, and OpenAPI contains both intelligence paths plus named schemas for Evidence, Event, Poll, Calendar, ForeignRelation, TemporalMetric, Coverage, ProviderRun, RegionIdentity, SituationSection, and CountryContextReport.

- [ ] **Step 2: Verify RED**

Run: `bun test src/services/country_intel/contracts.test.ts`

- [ ] **Step 3: Implement synchronized contracts**

Extend:

```ts
export type SoraModule = 'web' | 'browser' | 'yahoo' | 'life' | 'disaster' |
  'watch' | 'music' | 'gov' | 'trade' | 'media' | 'intel';
```

Register `research_country_context` as `defaultEnabled: true`, add an evidence-only instruction explaining caller responsibility, and use the shared schema/service. Add OpenAPI `components.schemas` generated by `zodToOpenApiSchema` and request/response definitions for both routes.

- [ ] **Step 4: Verify GREEN and core tool-count compatibility**

Run:

```bash
bun test src/services/country_intel/contracts.test.ts
bun test src/llm_contract_sync.test.ts src/index.test.ts --test-name-pattern "tools/list|module"
```

Update existing exact tool-count expectations only when `intel` is enabled; preserve the established count for explicit module sets that omit `intel`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts src/types.ts src/services/country_intel/contracts.test.ts
git commit -m "feat(intel): synchronize MCP and OpenAPI contracts"
```

### Task 12: Persistence operations, live smoke, Docker, and documentation

**Files:**
- Create: `src/services/country_intel/live_smoke.ts`
- Create: `src/services/country_intel/maintenance.test.ts`
- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `Containerfile`
- Modify: `README.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: default provider registry, DB maintenance, REST/MCP contract.
- Produces: `bun run test:intel:live`, persistence guidance, `/data` volume declaration, retention verification.

- [ ] **Step 1: Write failing maintenance and command-contract tests**

Assert ephemeral production DB path detection warns for `/app/data/sora.db` and not `/data/sora.db`, prune retention boundaries, metrics report main/WAL/SHM bytes, and `package.json` contains an opt-in smoke script that does not run under `bun test`.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run RED and GREEN with: `bun test src/services/country_intel/maintenance.test.ts`

Add:

```json
"test:intel:live": "bun run src/services/country_intel/live_smoke.ts"
```

The smoke script checks South Korea, Taiwan, United States, France, and Indonesia with bounded limits, prints provider status/parser/date/event/coverage checks, and exits nonzero when a parser contract fails. Add `VOLUME ["/data"]` to both container build files and document `SORA_DB_PATH=/data/sora.db` with a mounted volume.

- [ ] **Step 3: Update user and release documentation**

Document request/response examples, comprehensive defaults, evidence versus event counts, coverage semantics, provider limitations, persistence, retention, and the explicit absence of risk/sentiment decisions. Mark the feature as a `v2.26.0` release candidate without changing version fields before the release flow.

- [ ] **Step 4: Commit**

```bash
git add src/services/country_intel/live_smoke.ts src/services/country_intel/maintenance.test.ts package.json Dockerfile Containerfile README.md RELEASE_NOTES.md
git commit -m "docs(intel): document persistence and live smoke"
```

### Task 13: Full verification, live smoke report, and release-candidate diff

**Files:**
- Modify only files required by failures attributable to this branch, with a new failing regression test before each production fix.

**Interfaces:**
- Consumes: complete branch.
- Produces: verified release-candidate evidence and final report data.

- [ ] **Step 1: Run focused Country Intelligence tests**

Run: `bun test src/services/country_intel`

Expected: all Country Intelligence fixture, DB, REST, MCP, and contract tests pass with no live network dependency.

- [ ] **Step 2: Run complete regression suite**

Run: `bun test`

Expected: all existing and new tests pass. Record exact test, assertion, and file counts.

- [ ] **Step 3: Build production entry point**

Run: `bun run build`

Expected: exit 0 and `server.js` emitted.

- [ ] **Step 4: Run live smoke separately**

Run: `bun run test:intel:live`

Record each country/provider as success, partial, rate-limited, unavailable, or parser failure. Do not weaken fixture tests because of live availability.

- [ ] **Step 5: Inspect release-candidate diff and forbidden scope**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n "antiJapanScore|hostilityScore|JapanRiskScore|assess_social_post|classifier\.dev|semantic_classifier" src
git status --short --branch
```

Expected: clean diff, no forbidden production symbols, and no uncommitted changes.

- [ ] **Step 6: Commit verification-only fixes if any**

If provider timeout verification requires a code change, commit that regression with its test using:

```bash
git add src/services/country_intel/report.test.ts src/services/country_intel/report.ts
git commit -m "fix(intel): preserve partial report on provider timeout"
```

If no files changed, do not create an empty commit.

- [ ] **Step 7: Apply the repository release version update**

After all functional verification is green, update `package.json` and `SORA_VERSION` in `src/types.ts` from `2.25.0` to `2.26.0`, add the final dated release heading in `RELEASE_NOTES.md`, and run:

```bash
bun test src/version_contract.test.ts
bun run build
```

Commit only those release files:

```bash
git add package.json src/types.ts RELEASE_NOTES.md
git commit -m "release: v2.26.0"
```

- [ ] **Step 8: Prepare completion report**

Include final commit SHA, changed files, architecture, implemented providers, provider limitations, migrations, persistence, clustering, foreign relations, Japan projection, baseline behavior, full tests, build, live smoke, known limitations, unavailable/partial providers, and `git diff --stat origin/main...HEAD`.
