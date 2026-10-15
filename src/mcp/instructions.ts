import { isModuleActive, type SoraModule } from './registry.js';

export function buildSoraMcpInstructions(activeModules?: (SoraModule | 'all')[]): string {
  const hasMod = (mod: SoraModule) => isModuleActive(mod, activeModules);

  const hasWeb = hasMod('web');
  const hasBrowser = hasMod('browser');
  const hasYahoo = hasMod('yahoo');
  const hasLife = hasMod('life');
  const hasDisaster = hasMod('disaster');
  const hasMusic = hasMod('music');
  const hasGov = hasMod('gov');
  const hasTrade = hasMod('trade');
  const hasIntel = hasMod('intel');
  const hasWatch = hasMod('watch');
  // inspect_image は web モジュールでも有効になる（createMcpServer の shouldEnableMedia と同じ条件）
  const hasMedia = hasMod('media') || hasWeb;

  const lines: string[] = [
    '# Sora MCP Server - AI Interaction & Tool Routing Guidelines',
    '',
    '## 1. Zero-Refusal & Active Investigation Policy',
    '- **NEVER refuse to answer or give up by claiming "a specific tool is not available"** (e.g. "I have no tool for live concert schedules, business hours, release dates.").',
  ];

  if (hasWeb) {
    lines.push(
      '- If a query asks for factual, real-time, time-sensitive, or external information not covered by a Tier 1 specialized domain tool, **you MUST use `search_deep` or `search_web`**.',
    );
  } else {
    lines.push(
      '- If a query asks for factual, real-time, time-sensitive, or external information, actively investigate using the currently available tools and modules without inventing data.',
    );
  }

  lines.push(
    '',
    '## 2. Dynamic Tool Discovery Protocol',
    '- **Visible Tools**: If the required specialized tool is present in the current model tool definitions, call it directly without discovery or activation.',
    '- **Catalog vs Model Context**: MCP tools/list is the server catalog; the host may expose only a subset of those definitions to the model.',
    '- **Host Deferred Loading**: If the host provides tool discovery, use the host-provided tool search to load a missing definition; Sora search_tools is then not needed.',
    '- **Legacy Sora Activation**: Otherwise, if the server uses deferred activation, call search_tools with relevant keywords, then wait for the host to load its input schema before calling the tool (a name in search output alone is not callable).',
    '- **Unavailable Modules**: If discovery cannot find the tool, its module may be disabled; use a safe available fallback without inventing data.',
    '- **Code Execution (preferred)**: If you can run code that reaches this server, fetch the typed client (`GET /client`, skill resource `sora-skill://sora-client`) and print only the fields you need. Otherwise call the MCP tools directly.',
  );

  if (hasWeb || hasBrowser || hasWatch || hasMedia) {
    lines.push('', '## 3. Web Tool Overlap & Primary Boundaries');
    if (hasWeb) {
      lines.push(
        '- **`search_web`**: URL / snippet discovery (fast & lightweight candidate search by default) + optional same-call extraction via `formats: ["markdown"]`.',
        '- **`search_deep`**: Universal deep investigation combining Web search + full-article scraping + realtime X + Deep Evidence Rerank.',
        '- **`scrape` / `scrape_batch`**: Known URL content extraction (single or batch) for deep reading of specific pages/documents.',
        '- **`search_social_posts` / `fetch_social_post`**: Public SNS posts (Weibo keyword-latest search; Threads/Instagram/Facebook public-post discovery plus body). For X posts use `search_realtime` / `fetch_x_post`.',
        '- **`map_site` / `crawl_site`**: Same-site URL listing / multi-page traversal for documentation or full-site knowledge collection.',
      );
    }
    if (hasBrowser) {
      lines.push(
        '- **`browser_action`**: Interactive browser operation requiring clicks, form fills, JS execution, or complex dynamic rendering.',
      );
    }
    if (hasMedia) {
      lines.push('- **`inspect_image`**: Image input for a flyer, timetable or table only when the answer needs its content.');
    }
    if (hasWatch) {
      lines.push('- **`watch_register` / `watch_check` / `watch_list` / `watch_delete`**: Page change monitoring (ticket results, restocks, notices).');
    }
  }

  lines.push('', '## 4. Two-Tier Tool Decision Framework');

  const tier1Directives: string[] = [];
  if (hasTrade) {
    tier1Directives.push(
      "1. US Export Compliance & Tariffs (HTS classification, CPSC certificates & 2026 eFiling mandate, FDA PGA flags FD1-FD4): Use 'trade' tools (check_product_compliance [CORE], predict_hts_code, check_cpsc_certificate, check_fda_regulated, verify_hts_code).\n   - CRITICAL HTS RULE: To classify a product, call 'check_product_compliance' with 'htsCode' OMITTED; Sora finds the 10-digit code from the official HTS and CBP rulings. NEVER supply a guessed 'htsCode' (only one the user gave). Pass productName/description as a plain English generic name (translate Japanese; no brand or sales copy): the HTS and rulings are English.",
    );
  }
  if (hasGov) {
    tier1Directives.push(
      "2. Japanese Laws & Diet Minutes (Official e-Gov API v2, National Diet Library minutes): Use 'gov' tools (search_laws [CORE], get_law_text, search_diet_minutes).",
    );
  }
  if (hasLife) {
    tier1Directives.push(
      "3. Japan Weather, Domestic Transit & Flights (Japan Meteorological Agency direct CDN, Yahoo! Transit IC fares & transfer routes, airport flight delays & cancellations): Use 'life' tools (get_weather [CORE], search_route [CORE], get_flight_status).",
    );
    tier1Directives.push(
      "4. Package & Delivery Tracking (Yamato Transport, Sagawa Express, Japan Post domestic & international/EMS, Seino, Fukuyama Transporting, UPS, FedEx, DHL Express delivery status & event history): Use 'track_package'. Discovery keywords: '荷物追跡', 'track_package'. Follow section 2 only when its definition is missing.",
    );
  }
  if (hasDisaster) {
    tier1Directives.push(
      "5. Japan Disaster & Emergency Information (Japan Meteorological Agency weather warnings, P2P Earthquake, JARTIC road traffic, GSI elevation, addresses): Use 'disaster' tools (search_disaster_warnings [CORE], search_earthquake [CORE], search_road_traffic, get_elevation, search_poi, search_postal_code, normalize_address, reverse_geocode).",
    );
  }
  if (hasYahoo) {
    tier1Directives.push(
      "6. Real-time Social, News & Q&A (X/Twitter realtime posts, Yahoo! News, trending ranking, Yahoo! Chiebukuro, image/video search): Use 'yahoo' tools (search_realtime [CORE], search_chiebukuro [CORE], fetch_x_post, search_news, search_trend, suggest_keywords, search_image, search_video).",
    );
  }
  if (hasMusic) {
    tier1Directives.push(
      "7. Music Metadata & Catalog (Official iTunes API metadata, previews, artwork): Use 'music' tools (search_song, search_artist, search_music).",
    );
  }
  if (hasIntel) {
    tier1Directives.push(
      "8. Country & Region Intelligence (evidence-backed country context, calendars, polls, Japan projection; no sentiment or risk scores): Use 'research_country_context'; reopen a saved report by its contextId with get_country_context, get_country_context_evidence, get_country_context_updates. Discovery keywords: '国地域', 'research_country_context'. Follow section 2 only when its definition is missing.",
    );
  }

  if (tier1Directives.length > 0) {
    lines.push(
      '',
      '### Tier 1: Official Specialized Domain Directives (MANDATORY TOOL CALL)',
      'For queries strictly within the following domains, **NEVER answer using internal parametric knowledge, estimations, or general web search**. Follow the Dynamic Tool Discovery Protocol and call the specialized tool:',
      tier1Directives.join('\n'),
    );
  }

  if (hasWeb) {
    lines.push(
      '',
      '### Tier 2: Universal Web & Deep Search (ALL OTHER REAL-WORLD QUERIES)',
      'For ANY query requiring up-to-date facts, event dates, or external context outside Tier 1, invoke:',
      '- **`search_deep` (Primary Recommended Tool for Deep Web + X Investigation)**:',
      '  - **`responseMode: "evidence"`**: Use for focused or local fact confirmation (e.g. specific dates/times, lyricists, single spec details, localized proof). Returns query-selected highlights and omits redundant full Markdown when safe.',
      '  - **`responseMode: "full"` (Default)**: Use for whole-document summaries, exhaustive enumeration, broad comparison, or when page-wide context is needed.',
      '  - **Evidence Escalation**: If evidence is insufficient, ambiguous, or conflicting across sources, re-fetch with `responseMode: "full"` or specify `formats: ["markdown"]` (keeps full Markdown in evidence mode).',
      '  - **`realtimeFocus`**: `"public"` puts posts by others first (reputation, reactions, backlash, on-site reports); `"official"` (default) puts the account\'s own posts first (schedules, announcements). It is inferred from words like 評判/炎上/口コミ when omitted. `realtime.omittedCount` > 0 means posts were left out by the cap; raise `realtimeLimit` if more are needed.',
      '  - **`realtimeAnchor`** (`anchor` on `search_realtime`): Pass the query word that is the proper noun (person, group, work or venue name) when known; relaxed X searches then keep it.',
      '  - **`schedule`** (response field): events from the top pages, merged by date and name, upcoming first with past events after them. Read it first for schedule or event-date questions; `sources` lists the pages. `includeMedia: false` omits image/video URLs when they are not needed.',
      '  - **`contextSufficiency`** (response field): `partial` / `insufficient` with `reasons` (`unmentioned:<term>` = no evidence mentions the term, `unanswered:<term>` = no time/price/date value found, `few-success` = fewer than 3 pages retrieved) shows what is missing; investigate those items further. `no_gap_detected` only means no gap was found by lexical checks, not that the answer is verified.',
      '  - *Token Efficiency*: Do not cut upstream retrieval early to save tokens; evidence mode already trims safely.',
      '- **`search_web` (Candidate Discovery & Optional 1-Call Enrichment)**:',
      '  - **URL / Snippet Discovery**: Omit `formats` for lightweight candidate search.',
      '  - **Search + Content in One Call**: Specify `formats: ["markdown"]` (or `formats: ["markdown", "tables"]`) to scrape top results and attach requested formats in a single round-trip.',
      '  - *Note*: If snippets lack details, read the page with `scrape`, unless `formats` already retrieved it.',
    );
  }

  lines.push(
    '',
    '## 5. Interactive Clarification Flow',
    "- When tools return 'inputCompleteness: \"partial\"' or 'clarifyingQuestions', do not guess missing parameters Present the returned questions and impact explanation to the user.",
  );

  return lines.join('\n');
}

export const SORA_MCP_INSTRUCTIONS = buildSoraMcpInstructions();
