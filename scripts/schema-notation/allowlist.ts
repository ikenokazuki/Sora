// `${kind} ${key}` -> reason. Every entry must state why the difference is intentional.
export const NOTATION_ALLOWLIST: Record<string, string> = {
  'pair_mismatch search_road_traffic pref': 'REST accepts a numeric prefecture code; MCP keeps names only so the model passes 都道府県名.',
};
