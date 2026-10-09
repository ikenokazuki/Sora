// `${kind} ${key}` -> reason. Every entry must state why the difference is intentional.
export const NOTATION_ALLOWLIST: Record<string, string> = {
  'pair_mismatch search_road_traffic pref': 'REST accepts a numeric prefecture code; MCP keeps names only so the model passes 都道府県名.',
  'return_note_mismatch search_realtime 返却': 'MCP returns count and items at the top level; REST /search/realtime wraps them in data. The note describes the MCP payload.',
};
