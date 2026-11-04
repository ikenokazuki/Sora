// `${kind} ${key}` -> reason. Every entry must state why the difference is intentional.
export const NOTATION_ALLOWLIST: Record<string, string> = {
  'pair_mismatch search_road_traffic pref': 'REST accepts a numeric prefecture code; MCP keeps names only so the model passes 都道府県名.',
  'enum_missing mcp search_earthquake minIntensity': 'Gemini function declarations accept string enums only; one numeric enum makes the whole tool list fail with 400. MCP declares the range and checks the scale codes with refine.',
  'pair_mismatch search_earthquake minIntensity': 'MCP declares 10-70 without the numeric enum (Gemini rejects it); REST keeps the enum of scale codes for the OpenAPI document.',
  'return_note_mismatch search_realtime 返却': 'MCP returns count and items at the top level; REST /search/realtime wraps them in data. The note describes the MCP payload.',
  'return_note_mismatch search_web 返却': 'MCP returns count and items at the top level; REST /search/web wraps them in data. The note describes the MCP payload.',
};
