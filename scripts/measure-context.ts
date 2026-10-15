/**
 * 文脈（コンテキスト）の大きさを、実際のクライアントが受け取る HTTP の経路で測る。
 * 使い方: bun scripts/measure-context.ts
 * 出力: JSON（tools/list の文字数、instructions の文字数、search_tools の応答の文字数）。
 */
import { openMcpSession } from '../src/test_fixtures/mcp_http.js';

export interface ContextMeasurement {
  /** 既定（遅延読み込み）の tools/list。 */
  defaultToolsList: { tools: number; chars: number };
  /** 全ツール（SORA_DEFER_TOOLS=false）の tools/list。 */
  allToolsList: { tools: number; chars: number };
  instructionsChars: number;
  /** search_tools の応答の文字数（詳細度ごと）。 */
  searchTools: Record<string, number>;
}

export async function measureContext(): Promise<ContextMeasurement> {
  const { app } = await import('../src/index.js');
  const request = (path: string, init?: RequestInit) => app.request(path, init);
  const previous = process.env.SORA_DEFER_TOOLS;
  try {
    process.env.SORA_DEFER_TOOLS = 'true';
    const deferred = await openMcpSession(request);
    const defaultList = await deferred.rpc('tools/list');
    const searchTools: Record<string, number> = {};
    for (const detail of [undefined, 'names', 'summary', 'schema'] as const) {
      const response = await deferred.rpc('tools/call', { name: 'search_tools', arguments: { query: '住所', ...(detail ? { detail, activate: false } : {}) } });
      searchTools[detail ?? 'default'] = response.chars;
    }
    process.env.SORA_DEFER_TOOLS = 'false';
    const all = await openMcpSession(request);
    const allList = await all.rpc('tools/list');
    return {
      defaultToolsList: { tools: defaultList.message.result.tools.length, chars: defaultList.chars },
      allToolsList: { tools: allList.message.result.tools.length, chars: allList.chars },
      instructionsChars: (deferred.initialized.message.result?.instructions ?? '').length,
      searchTools,
    };
  } finally {
    if (previous === undefined) delete process.env.SORA_DEFER_TOOLS;
    else process.env.SORA_DEFER_TOOLS = previous;
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await measureContext(), null, 2));
  process.exit(0);
}
