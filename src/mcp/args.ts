// モード付きのツールの、引数の組み合わせの検査。mcpServer.tool は引数の素の形を受けるので、
// スキーマ全体の refine は使えない。ハンドラの先頭で確かめ、誤りは usageError で返す。

/** 値が空でない（undefined・null・空文字・空配列でない）か。false と 0 は指定とみなす。 */
const given = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/** keys のうち、ちょうど 1 つが指定されていなければ、usage を添えたエラーの文。 */
export function exactlyOne(args: Record<string, unknown>, keys: string[], usage: string): string | undefined {
  const set = keys.filter((k) => given(args[k]));
  if (set.length === 1) return undefined;
  const head = set.length === 0
    ? `${keys.join('・')} のどれか 1 つを指定してください。`
    : `${keys.join('・')} は 1 つだけ指定してください（指定: ${set.join(', ')}）。`;
  return `${head}${usage}`;
}

/**
 * keys のどれかが指定されているのに、args[key] が allowedWhen でないときの、エラーの文。
 * モードが引数の値（action・type など）で決まるときだけ使う。入力の有無や形でモードを決めるツールは onlyForMode を使う。
 * 既定値（zod の default）のある引数を keys に入れると、いつも指定されたことになる。
 */
export function onlyWith(args: Record<string, unknown>, key: string, allowedWhen: string, keys: string[]): string | undefined {
  if (args[key] === allowedWhen) return undefined;
  const set = keys.filter((k) => given(args[k]));
  if (set.length === 0) return undefined;
  const now = given(args[key]) ? String(args[key]) : '未指定';
  return `${set.join(', ')} は ${key} が "${allowedWhen}" のときだけ指定できます（いまの ${key}: ${now}）。`;
}

/**
 * mode（ハンドラが入力から決めた文字列。url か urls か、動画かチャンネルか、など）が allowedModes に含まれないのに、
 * keys のどれかが指定されているとき、usage を添えたエラーの文。モードに合わない引数を、黙って無視せずに知らせる。
 * 既定値（zod の default）のある引数を keys に入れると、いつも指定されたことになる。
 */
export function onlyForMode(mode: string, allowedModes: string[], args: Record<string, unknown>, keys: string[], usage: string): string | undefined {
  if (allowedModes.includes(mode)) return undefined;
  const set = keys.filter((k) => given(args[k]));
  if (set.length === 0) return undefined;
  return `${set.join(', ')} は ${allowedModes.map((m) => `"${m}"`).join('・')} モードのときだけ指定できます（いまのモード: ${mode}）。${usage}`;
}

/** MCP のエラー応答（入力の誤り）。 */
export function usageError(message: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text: `入力の誤り: ${message}` }] };
}
