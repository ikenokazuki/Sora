import { describe, expect, test } from 'bun:test';
import { createMcpServer } from '../mcp.js';

const search = async (server: unknown, args: Record<string, unknown>) =>
  ((server as any)._registeredTools['search_tools'].handler(args) as Promise<any>);
const enabledCount = (server: unknown) =>
  Object.values((server as any)._registeredTools).filter((t: any) => t.enabled).length;

describe('search_tools detail / activate', () => {
  test('default output is unchanged (activates and reports 有効化完了)', async () => {
    const server = createMcpServer({ deferTools: true });
    const text = (await search(server, { query: '荷物追跡' })).content[0].text as string;
    expect(text).toContain('以下のツールをセッション内で有効化しました:');
    expect(text).toContain('track_package');
    expect(text).toContain('有効化完了');
  });

  test('detail:"names" lists name and category only, no descriptions or schemas', async () => {
    const server = createMcpServer({ deferTools: true });
    const text = (await search(server, { query: '荷物追跡', detail: 'names' })).content[0].text as string;
    expect(text).toMatch(/^- track_package \[life\]/m);
    expect(text).not.toContain('有効化完了');
    expect(text).not.toContain('"properties"');
  });

  test('activate:false leaves the tool list unchanged', async () => {
    const server = createMcpServer({ deferTools: true });
    const before = enabledCount(server);
    const text = (await search(server, { query: '荷物追跡', detail: 'summary', activate: false })).content[0].text as string;
    expect(text).toContain('track_package');
    expect(text).toContain('未有効化');
    expect(enabledCount(server)).toBe(before);
  });

  test('detail:"schema" returns the same input schema that tools/list publishes', async () => {
    const server = createMcpServer({ deferTools: true });
    const text = (await search(server, { query: '荷物追跡', detail: 'schema', activate: false })).content[0].text as string;
    expect(text).toContain('### track_package');
    expect(text).toContain('"properties"');
    expect(text).not.toContain('$schema');
  });

  test('detail:"schema" caps the number of tools and says how many were omitted', async () => {
    const server = createMcpServer({ deferTools: false });
    const text = (await search(server, { query: 'web', detail: 'schema', activate: false })).content[0].text as string;
    expect((text.match(/^### /gm) ?? []).length).toBeLessThanOrEqual(8);
    expect(text.length).toBeLessThan(21_000);
  });

  test.each(['names', 'summary', 'schema'] as const)('detail:"%s" ends with the pointer to the typed client', async (detail) => {
    const server = createMcpServer({ deferTools: true });
    const text = (await search(server, { query: '荷物追跡', detail, activate: false })).content[0].text as string;
    expect(text.trimEnd().endsWith('sora-skill://sora-client）から関数を呼び、必要な項目だけ出力する方が文脈を節約できます。')).toBe(true);
  });

  test('the default activation output also carries the pointer', async () => {
    const server = createMcpServer({ deferTools: true });
    expect(((await search(server, { query: '荷物追跡' })).content[0].text as string)).toContain('GET /client');
  });
});
