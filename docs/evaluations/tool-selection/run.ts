// ツール選びの評価。日本語の依頼（prompts.json）ごとに、全ツールの定義を渡して、モデルに最初に呼ぶツールを 1 つ選ばせる（実行はしない）。
// 使い方:
//   bun docs/evaluations/tool-selection/run.ts --tools <snapshot.json> --surface old|new --out <results.json>
//        [--model claude-haiku-5-5] [--limit N] [--concurrency 4]
// 依存: @anthropic-ai/sdk（リポジトリには入れない。別の場所で npm install し、この隣の node_modules にリンクする。node_modules は、この隣の .gitignore が無視する）
// 鍵: 環境変数 ANTHROPIC_API_KEY、無ければ ANTHROPIC_KEY_FILE（既定 ~/.config/sora-hl/anthropic_key）。鍵は表示しない。
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Expect = string | null | string[];
interface Item {
  id: string;
  family: string;
  prompt: string;
  old: string | string[];
  new: string | string[];
  new_args?: Record<string, Expect>;
}
interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const toolsFile = arg('tools');
const surface = arg('surface');
const outFile = arg('out');
if (!toolsFile || (surface !== 'old' && surface !== 'new') || !outFile) {
  console.error('使い方: bun run.ts --tools <snapshot.json> --surface old|new --out <results.json> [--model ..] [--limit N] [--concurrency N]');
  process.exit(2);
}
const model = arg('model', 'claude-haiku-5-5') as string;
const limit = Number(arg('limit', '0')) || 0;
const concurrency = Number(arg('concurrency', '4')) || 4;

const keyFile = process.env.ANTHROPIC_KEY_FILE ?? join(homedir(), '.config/sora-hl/anthropic_key');
const apiKey = process.env.ANTHROPIC_API_KEY ?? readFileSync(keyFile, 'utf8').trim();
const client = new Anthropic({ apiKey, maxRetries: 4 });

const tools = (JSON.parse(readFileSync(toolsFile, 'utf8')) as { tools: ToolDef[] }).tools;
const prompts = (JSON.parse(readFileSync(join(import.meta.dir, 'prompts.json'), 'utf8')) as { prompts: Item[] }).prompts;
const items = limit > 0 ? prompts.slice(0, limit) : prompts;

// 最後のツールの定義にキャッシュの印を付けると、ツールの定義（大きい）が 2 回目からキャッシュから読まれる
const toolParams = tools.map((t, i) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
}));

const SYSTEM =
  'あなたは、MCP のツールを使えるアシスタントです。ユーザーの依頼に最も合うツールを 1 つ選び、必要な引数をつけて呼んでください。' +
  'ツールの名前・説明・引数の説明を読んで選び、推測で答えず、必ずツールを呼ぶこと。最初に呼ぶべきツールを 1 つだけ選ぶこと。';

const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

function argMatches(actual: unknown, expected: Expect): boolean {
  const absent = actual === undefined || actual === null || actual === '';
  if (expected === null) return absent;
  if (Array.isArray(expected)) return expected.some((e) => (e === null ? absent : argMatches(actual, e)));
  if (expected === '*') return !absent;
  if (expected === '!true') return actual !== true;
  return actual === expected;
}

interface Result {
  id: string;
  family: string;
  prompt: string;
  accepted: string[];
  picked: string | null;
  input: Record<string, unknown> | null;
  toolOk: boolean;
  argsOk: boolean | null;
  argFailures: string[];
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

async function runOne(item: Item): Promise<Result> {
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    tools: toolParams,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: item.prompt }],
  });
  const use = res.content.find((b) => b.type === 'tool_use');
  const picked = use && use.type === 'tool_use' ? use.name : null;
  const input = use && use.type === 'tool_use' ? (use.input as Record<string, unknown>) : null;
  const accepted = asList(surface === 'old' ? item.old : item.new);
  const toolOk = picked !== null && accepted.includes(picked);
  const argFailures: string[] = [];
  if (surface === 'new' && toolOk && item.new_args) {
    for (const [key, expected] of Object.entries(item.new_args)) {
      if (!argMatches(input?.[key], expected)) argFailures.push(`${key}: ${JSON.stringify(input?.[key])} (期待 ${JSON.stringify(expected)})`);
    }
  }
  return {
    id: item.id,
    family: item.family,
    prompt: item.prompt,
    accepted,
    picked,
    input,
    toolOk,
    argsOk: surface === 'new' && toolOk && item.new_args ? argFailures.length === 0 : null,
    argFailures,
    usage: {
      input: res.usage.input_tokens,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      output: res.usage.output_tokens,
    },
  };
}

// 1 件目で、キャッシュを作る。2 件目からは並列で回す。
const results: Result[] = [];
results.push(await runOne(items[0]));
const rest = items.slice(1);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, rest.length) }, async () => {
    while (next < rest.length) {
      const item = rest[next++];
      results.push(await runOne(item));
    }
  }),
);
results.sort((a, b) => items.findIndex((i) => i.id === a.id) - items.findIndex((i) => i.id === b.id));

const total = results.length;
const toolOk = results.filter((r) => r.toolOk).length;
const withArgs = results.filter((r) => r.argsOk !== null);
const argsOk = withArgs.filter((r) => r.argsOk).length;
const families = [...new Set(results.map((r) => r.family))];
const sum = results.reduce(
  (s, r) => ({ input: s.input + r.usage.input, cacheWrite: s.cacheWrite + r.usage.cacheWrite, cacheRead: s.cacheRead + r.usage.cacheRead, output: s.output + r.usage.output }),
  { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
);
const summary = {
  model,
  surface,
  tools: tools.length,
  prompts: total,
  toolAccuracy: `${toolOk}/${total}`,
  argAccuracy: surface === 'new' ? `${argsOk}/${withArgs.length}` : null,
  byFamily: Object.fromEntries(families.map((f) => [f, `${results.filter((r) => r.family === f && r.toolOk).length}/${results.filter((r) => r.family === f).length}`])),
  wrong: results.filter((r) => !r.toolOk).map((r) => ({ id: r.id, picked: r.picked, accepted: r.accepted })),
  argProblems: results.filter((r) => r.argsOk === false).map((r) => ({ id: r.id, failures: r.argFailures })),
  usage: sum,
};
writeFileSync(outFile, `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
