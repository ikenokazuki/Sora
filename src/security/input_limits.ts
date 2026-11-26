// 利用者が送る文字列の長さの上限。長い入力は、全員の要求を処理するメインスレッドを、二乗の時間の処理（正規表現など）で止められる
// （句読点 10 万字の検索語で 7 秒。二乗なので、10 倍の入力で 100 倍）。掛ける所は、REST（認証のあとの中間処理。routes/input_limits.ts）と
// MCP（ツールの共通の包み。mcp/registry.ts）の 2 つだけにする。欄が増えても、上限は勝手に掛かる
import { limits, type Limits } from './limits.js';

/** URL の欄。中の値（urls の要素）も同じ */
const URL_FIELDS = new Set(['url', 'urls', 'webhookUrl']);
/** 長い文章の欄。中の値（headers の値・cookies の value など）も同じ */
const LONG_TEXT_FIELDS = new Set(['description', 'productDescription', 'text', 'script', 'headers', 'cookies']);
/** 専用の上限がある欄（スキーマの max と同じ値）。指紋は base64 で長い（types.ts の SongRecognitionSignatureRequestSchema） */
const OWN_LIMIT_FIELDS: Record<string, number> = { signature: 65_536 };
/** エラーの文に書く欄の名前の長さの上限（欄の名前そのものが長いことがある） */
const NAME_IN_MESSAGE_MAX = 80;

type Kind = 'text' | 'long' | 'url';
type Path = { parent?: Path; part: string | number };

const maxFor = (kind: Kind, lim: Readonly<Limits>): number =>
  kind === 'url' ? lim.inputUrlChars : kind === 'long' ? lim.inputLongTextChars : lim.inputTextChars;

/** エラーの文に書く欄の名前（items[3].description の形）。エラーのときだけ組み立てる（深い入れ子で、道筋の文字列を全部作ると二乗になる） */
function pathName(path: Path | undefined): string {
  const parts: Array<string | number> = [];
  for (let at = path; at && parts.length < 20; at = at.parent) parts.push(at.part);
  let name = '';
  for (const part of parts.reverse()) name += typeof part === 'number' ? `[${part}]` : `${name ? '.' : ''}${part.slice(0, NAME_IN_MESSAGE_MAX)}`;
  return name.length > NAME_IN_MESSAGE_MAX ? `…${name.slice(-NAME_IN_MESSAGE_MAX)}` : name;
}

/** 入力（JSON の値・クエリの欄）に、長さの上限を超える文字列があれば、その理由の文を返す。無ければ undefined */
export function findOversizedInput(input: unknown, lim: Readonly<Limits> = limits()): string | undefined {
  let total = 0;
  const tooLong = (value: string, max: number, name: () => string): string | undefined => {
    if (value.length > max) return `「${name()}」が長すぎます（${value.length} 字。上限は ${max} 字です）`;
    total += value.length;
    return total > lim.inputTotalChars ? `入力の文字の合計が大きすぎます（上限は ${lim.inputTotalChars} 字です）` : undefined;
  };
  // 再帰にしない（深い入れ子の JSON で、スタックをあふれさせない）
  const stack: Array<{ value: unknown; path?: Path; kind: Kind; ownMax?: number }> = [{ value: input, kind: 'text' }];
  while (stack.length > 0) {
    const { value, path, kind, ownMax } = stack.pop()!;
    if (typeof value === 'string') {
      const problem = tooLong(value, ownMax ?? maxFor(kind, lim), () => pathName(path));
      if (problem) return problem;
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: { parent: path, part: i }, kind, ownMax });
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value).reverse()) {
        const childPath: Path = { parent: path, part: key };
        const problem = tooLong(key, lim.inputTextChars, () => pathName(childPath));
        if (problem) return problem;
        const childKind: Kind = URL_FIELDS.has(key) ? 'url' : LONG_TEXT_FIELDS.has(key) ? 'long' : kind;
        stack.push({ value: child, path: childPath, kind: childKind, ownMax: OWN_LIMIT_FIELDS[key] ?? ownMax });
      }
    }
  }
  return undefined;
}

