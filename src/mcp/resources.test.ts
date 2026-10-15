import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServer } from '../mcp.js';
import { readSkill } from './resources.js';

const pluginDir = join(import.meta.dir, '..', '..', 'plugins', 'sora-deep-research');

describe('skills', () => {
  test('every skill listed in plugin.json exists and its frontmatter name matches the directory', () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8')) as { skills: string[] };
    expect(manifest.skills.length).toBeGreaterThanOrEqual(2);
    for (const dir of manifest.skills) {
      const text = readFileSync(join(pluginDir, dir, 'SKILL.md'), 'utf8');
      expect(text).toContain(`name: ${dir.split('/').pop()}`);
    }
  });

  test('both skills are published as MCP resources with the plugin text', async () => {
    const server = createMcpServer({ deferTools: true });
    const resources = Object.entries((server as any)._registeredResources) as Array<[string, any]>;
    for (const name of ['sora-deep-research', 'sora-client']) {
      const entry = resources.find(([uri]) => uri === `sora-skill://${name}`);
      expect(entry, name).toBeDefined();
      const { contents } = await entry![1].readCallback(new URL(`sora-skill://${name}`));
      expect(contents[0].text).toBe(readSkill(name));
    }
  });

  test('the client skill names the endpoints and the environment variables', () => {
    const text = readSkill('sora-client') ?? '';
    for (const word of ['GET /client', 'SORA_URL', 'SORA_API_KEY', 'SoraError']) expect(text).toContain(word);
  });
});
