/** Sora のモジュール名（`SORA_MODULES` で選ぶ単位）。依存の無い葉のファイル（設定の登録簿と MCP の登録の両方が読む）。 */
export const MODULE_NAMES = ['web', 'browser', 'yahoo', 'life', 'disaster', 'watch', 'music', 'gov', 'trade', 'media', 'intel', 'lyrics', 'youtube', 'shazam', 'hts-archive'] as const;
export type SoraModule = (typeof MODULE_NAMES)[number];

/** `all` や未設定では有効にならず、名前を挙げたときだけ有効になるモジュール（自己責任で使う機能と、常駐の処理を伴う機能）。 */
export const EXPLICIT_ONLY_MODULES: readonly SoraModule[] = ['lyrics', 'shazam', 'hts-archive'];
