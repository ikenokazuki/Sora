import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * deploy/seccomp-sora.json は、Docker（moby）の既定の seccomp プロファイルに、規則を 1 つ足しただけのもの。
 * 元: https://github.com/moby/moby/blob/docker-v29.9.3/vendor/github.com/moby/profiles/seccomp/default.json
 * 更新するときは、新しい版の default.json の syscalls の末尾に、下の許可の規則（comment つき）を足し、UPSTREAM_SHA256 を新しい版のものにする。
 */
const UPSTREAM_SHA256 = '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334';

interface Rule {
  names: string[];
  action: string;
  comment?: string;
  args?: unknown;
  includes?: unknown;
  excludes?: unknown;
}
interface Profile {
  defaultAction: string;
  syscalls: Rule[];
}

const profile = JSON.parse(readFileSync(new URL('../../deploy/seccomp-sora.json', import.meta.url), 'utf8')) as Profile;

describe('deploy/seccomp-sora.json（Docker の既定の seccomp + Chromium のサンドボックスに要る許可）', () => {
  test('足したのは、末尾の 1 つの規則だけ。それを除くと、元にした Docker の既定のプロファイルと、1 バイトも違わない', () => {
    const rest = structuredClone(profile);
    rest.syscalls.pop();
    // 元のファイルは、タブ字下げで、末尾に改行が無い
    expect(createHash('sha256').update(JSON.stringify(rest, null, '\t')).digest('hex')).toBe(UPSTREAM_SHA256);
  });

  test('足した規則は、chroot・clone・unshare の、条件なしの許可だけ（これ以上は広げない）', () => {
    const added = profile.syscalls.at(-1);
    expect(added?.names).toEqual(['chroot', 'clone', 'unshare']);
    expect(added?.action).toBe('SCMP_ACT_ALLOW');
    expect(added?.args).toBeUndefined();
    expect(added?.includes).toBeUndefined();
    expect(added?.excludes).toBeUndefined();
  });

  test('既定の動作は、許可でなく、拒否のまま（許可リスト方式）', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });
});
