// `${kind} ${key}` -> reason. Every entry must state why the difference is intentional.
const YAHOO_RESULT_CAP = 'The bundled Yahoo search returns at most 20 images or videos and 10 questions; the description says so, and the schema keeps 50 so a larger limit is not an error.';
export const NOTATION_ALLOWLIST: Record<string, string> = {
  'pair_mismatch search_road_traffic pref': 'REST accepts a numeric prefecture code; MCP keeps names only so the model passes 都道府県名.',
  'enum_missing mcp get_disaster_info minIntensity': 'Gemini function declarations accept string enums only; one numeric enum makes the whole tool list fail with 400. MCP declares the range and checks the scale codes with refine.',
  'pair_mismatch get_disaster_info minIntensity': 'MCP declares 10-70 without the numeric enum (Gemini rejects it); REST keeps the enum of scale codes for the OpenAPI document.',
  'return_note_mismatch search_realtime 返却': 'MCP returns count and items at the top level; REST /search/realtime wraps them in data. The note describes the MCP payload.',
  'return_note_mismatch search_web 返却': 'MCP returns count and items at the top level; REST /search/web wraps them in data. The note describes the MCP payload.',
  'return_note_mismatch get_disaster_info 返却': 'MCP wraps the REST /disaster/warnings and /disaster/earthquake results, unchanged, in one section per include kind (warnings, earthquake). The note describes the MCP payload.',
  'return_note_mismatch get_place_info 返却': 'MCP splits the flat REST /geo/elevation result into location and one section per include kind (elevation), with the same field names and values. The note describes the MCP payload.',
  'pair_mismatch search_keywords limit': 'One MCP limit serves both modes: suggestions (REST /search/suggest: 1-20, default 10) and trends (REST /search/trend: 1-50, default 20). MCP declares 1-50 without a default, states both defaults in the description and refuses limit > 20 with a query.',
  'range_mismatch mcp search_chiebukuro limit': YAHOO_RESULT_CAP,
  'range_mismatch rest POST /search/image limit': YAHOO_RESULT_CAP,
  'range_mismatch rest POST /search/video limit': YAHOO_RESULT_CAP,
  'range_mismatch rest POST /search/chiebukuro limit': YAHOO_RESULT_CAP,
};
