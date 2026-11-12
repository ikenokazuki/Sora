import { describe, expect, test } from 'bun:test';
import { slimToolsListMessage, SORA_MCP_INSTRUCTIONS } from './mcp.js';

describe('slimToolsListMessage', () => {
  const tools = [{ name: 'a', inputSchema: { type: 'object' }, outputSchema: { type: 'object', big: 'x'.repeat(50) } }];
  test('drops outputSchema from a tools/list result and leaves other messages untouched', () => {
    const out: any = slimToolsListMessage({ jsonrpc: '2.0', id: 1, result: { tools } });
    expect(JSON.stringify(out)).not.toContain('outputSchema');
    expect(out.result.tools[0].name).toBe('a');
    const call = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { a: 1 } } };
    expect(slimToolsListMessage(call)).toBe(call);
    const note = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    expect(slimToolsListMessage(note)).toBe(note);
  });
});

describe('stdio transport', () => {
  test('tools/list over stdio omits outputSchema and stays small', async () => {
    // stdio も起動時に環境変数を検査する。親のシェルの環境（旧い名前の設定など）を持ち込まず、止まったときの理由は標準エラーから見る
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', SORA_DB_PATH: ':memory:' };
    if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    const proc = Bun.spawn([process.execPath, '--no-env-file', 'src/stdio.ts'], { cwd: new URL('..', import.meta.url).pathname, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
    const stderrText = new Response(proc.stderr).text();
    let listLine = '';
    try {
      const send = (m: object) => proc.stdin.write(JSON.stringify(m) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      proc.stdin.flush();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 20000;
      while (!listLine && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        listLine = buf.split('\n').find((l) => l.includes('"id":2')) ?? '';
      }
    } finally {
      proc.kill();
      await proc.exited;
    }
    expect(listLine, await stderrText).not.toBe('');
    const msg = JSON.parse(listLine);
    expect(msg.result.tools.length).toBe(33);
    expect(listLine).not.toContain('outputSchema');
    expect(listLine.length).toBeLessThan(130_000);
  }, 40000);
});

describe('instructions', () => {
  test('explains how to read contextSufficiency for search_deep', () => {
    expect(SORA_MCP_INSTRUCTIONS).toContain('contextSufficiency');
    expect(SORA_MCP_INSTRUCTIONS).toContain('no_gap_detected');
  });
});
