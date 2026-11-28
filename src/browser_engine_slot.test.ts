import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME_EXECUTABLE_PATH, closeSharedBrowser, getBrowser, launchProbe, slotUid } from './browser_engine.js';
import { DEFAULT_LAUNCHER } from './browser_launch_plan.js';
import { egressEndpointForSlot, getEgressGateway, stopEgressGateway } from './net/egress.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 番号（slot）が、起動する Chromium の uid に届くこと（設計 2。段階 6）。
 * root・起動用バイナリあり・capability 十分の環境を、差し替えて作り、puppeteer.launch に渡される起動用バイナリ・落とし先の uid・プロファイルの所有者を見る。
 * 実際に uid が分かれることの確認は、公開イメージでの実行（設計書の E42）。
 */

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4_000_000 + Math.floor(Math.random() * 1000);
  kill(): boolean {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

function fakeBrowser() {
  const child = new FakeProcess();
  return {
    connected: true,
    version: async () => 'fake',
    close: async () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    },
    process: () => child,
    browserContexts: () => [{}],
    pages: async () => [{}],
  };
}

const original = { ...launchProbe };
let launches: Array<{ executablePath?: string; env?: Record<string, string>; userDataDir?: string; args?: string[] }>;
let profiles: Array<{ uid: number; gid: number; dir: string }>;
let tmp: string;
let spy: ReturnType<typeof spyOn>;
const reaped: number[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'slot-test-'));
  launches = [];
  profiles = [];
  reaped.length = 0;
  launchProbe.currentUid = () => 0;
  launchProbe.launcherExists = () => true;
  launchProbe.missingCapabilities = () => [];
  launchProbe.makeProfileDir = (owner) => {
    const dir = mkdtempSync(join(tmp, 'profile-'));
    profiles.push({ ...owner, dir });
    return dir;
  };
  // 本物の reap は、/proc の uid 65532〜 のプロセス（ホストの nobody など）を、root なら終わらせてしまう。テストでは、記録だけ
  launchProbe.reap = async (uid) => {
    reaped.push(uid);
    return true;
  };
  spy = spyOn(puppeteer, 'launch').mockImplementation((async (options: (typeof launches)[number]) => {
    launches.push(options);
    return fakeBrowser();
  }) as never);
});

afterEach(async () => {
  await closeSharedBrowser();
  spy.mockRestore();
  Object.assign(launchProbe, original);
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(CHROME_EXECUTABLE_PATH === undefined)('slot → uid', () => {
  const strict = <T>(fn: () => Promise<T>, extra: Record<string, string | undefined> = {}) => withEnv({ SORA_ISOLATION: 'strict', SORA_BROWSER_IDLE_TTL_MS: '0', SORA_BROWSER_UID: undefined, ...extra }, fn);

  test('strict: tenant ごとに、起動用バイナリへ伝える uid・gid が、基準 + 番号（65532・65533・65534）。プロファイルも、その uid の所有', async () => {
    await strict(async () => {
      for (const tenant of ['name:A', 'name:B', 'name:C']) await getBrowser(undefined, tenant);
      expect(launches.map((launch) => launch.executablePath)).toEqual([DEFAULT_LAUNCHER, DEFAULT_LAUNCHER, DEFAULT_LAUNCHER]);
      expect(launches.map((launch) => launch.env?.SORA_LAUNCH_UID)).toEqual(['65532', '65533', '65534']);
      expect(launches.map((launch) => launch.env?.SORA_LAUNCH_GID)).toEqual(['65532', '65533', '65534']);
      expect(profiles.map((profile) => profile.uid)).toEqual([65532, 65533, 65534]);
      expect(launches.map((launch) => launch.userDataDir)).toEqual(profiles.map((profile) => profile.dir));
    });
  });

  test('strict: SORA_BROWSER_UID に数を明示したら、それが基準', async () => {
    await strict(async () => {
      await getBrowser(undefined, 'name:A');
      await getBrowser(undefined, 'name:B');
      expect(launches.map((launch) => launch.env?.SORA_LAUNCH_UID)).toEqual(['70000', '70001']);
    }, { SORA_BROWSER_UID: '70000' });
  });

  test('standard: tenant が違っても、1 つのプロセスを、基準の uid（65532）で', async () => {
    await withEnv({ SORA_ISOLATION: 'standard', SORA_BROWSER_IDLE_TTL_MS: '0', SORA_BROWSER_UID: undefined }, async () => {
      await getBrowser(undefined, 'name:A');
      await getBrowser(undefined, 'name:B');
      expect(launches).toHaveLength(1);
      expect(launches[0].env?.SORA_LAUNCH_UID).toBe('65532');
    });
  });

  test('番号を手放す前の確認（reap）は、その番号の uid を渡す。閉じたら、tenant の番号の分だけ', async () => {
    await strict(async () => {
      await getBrowser(undefined, 'name:A');
      await getBrowser(undefined, 'name:B');
      await closeSharedBrowser();
      expect(reaped.toSorted()).toEqual([65532, 65533]);
    });
  });

  test('出口のゲートウェイを使うとき: strict の tenant ごとのプロセスは、番号ごとの受け口を --proxy-server にする（その tenant の接続の数に入る）。standard の共有のプロセスは、本体の受け口', async () => {
    const proxyArg = (launch: (typeof launches)[number]) => launch.args?.find((arg) => arg.startsWith('--proxy-server='));
    const gatewayEnv = { SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined };
    try {
      await strict(async () => {
        const main = await getEgressGateway();
        await getBrowser(undefined, 'name:A');
        await getBrowser(undefined, 'name:B');
        const [a, b] = [await egressEndpointForSlot(0, 'name:A'), await egressEndpointForSlot(1, 'name:B')];
        expect(launches.map(proxyArg)).toEqual([`--proxy-server=${a.url}`, `--proxy-server=${b.url}`]);
        expect(new Set([main.port, a.port, b.port]).size).toBe(3);
        await closeSharedBrowser();
      }, gatewayEnv);
      launches.length = 0;
      await withEnv({ SORA_ISOLATION: 'standard', SORA_BROWSER_IDLE_TTL_MS: '0', SORA_BROWSER_UID: undefined, ...gatewayEnv }, async () => {
        const main = await getEgressGateway();
        await getBrowser(undefined, 'name:A');
        expect(launches.map(proxyArg)).toEqual([`--proxy-server=${main.url}`]);
      });
    } finally {
      await stopEgressGateway();
    }
  });

  test('slotUid: 基準 + 番号。uid を分けられない環境（root でない）は undefined', async () => {
    await withEnv({ SORA_BROWSER_UID: undefined }, async () => {
      expect([0, 1, 3].map(slotUid)).toEqual([65532, 65533, 65535]);
      launchProbe.currentUid = () => 1000;
      expect(slotUid(1)).toBeUndefined();
    });
  });

  test('uid を分けられない環境（root でない）では、プロセスだけを分け、起動用バイナリを使わず、reap もしない', async () => {
    await strict(async () => {
      launchProbe.currentUid = () => 1000;
      await getBrowser(undefined, 'name:A');
      await getBrowser(undefined, 'name:B');
      expect(launches).toHaveLength(2);
      expect(launches.every((launch) => launch.env?.SORA_LAUNCH_UID === undefined)).toBe(true);
      await closeSharedBrowser();
      expect(reaped).toEqual([]);
    });
  });
});
