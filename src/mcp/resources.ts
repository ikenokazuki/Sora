import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** MCP リソースとして配るスキル。実体は plugins/sora-deep-research/skills/<name>/SKILL.md。 */
const SKILLS = [
  { name: 'sora-deep-research', description: '深層調査の手順（確認事項・証拠・不足の記録、取得失敗と0件の区別）' },
  { name: 'sora-client', description: 'コードを実行できる環境から、型付きクライアント（GET /client）で Sora を使う手順' },
] as const;

/** スキルの本文。ソース実行（src/mcp/）とイメージ内のバンドル（/app/server.js）で plugins/ の相対位置が違うので両方を試す。 */
export function readSkill(name: string): string | null {
  const path = `plugins/sora-deep-research/skills/${name}/SKILL.md`;
  for (const url of [new URL(`../../${path}`, import.meta.url), new URL(`./${path}`, import.meta.url)]) {
    try {
      const text = readFileSync(url, 'utf8');
      if (text.trim()) return text;
    } catch {}
  }
  return null;
}

/** 接続した呼出元が sora-skill://<name> を読むだけで、スキルの手順を取得できるようにする。 */
export function registerSkillResources(mcpServer: McpServer): void {
  for (const { name, description } of SKILLS) {
    const text = readSkill(name);
    if (!text) continue;
    mcpServer.resource(
      `${name}-skill`,
      `sora-skill://${name}`,
      { mimeType: 'text/markdown', description },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }),
    );
  }
}
