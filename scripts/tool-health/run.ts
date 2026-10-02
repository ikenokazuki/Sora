// Live tool-health runner (Task 9). Public tools run against the candidate
// container server; provider checks run in-process from the same checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CANONICAL_TOOLS, HOTEL_TOOL, PROVIDER_CASES, TOOL_CASES, type ProviderCase } from './catalog.js';
import { mcpCall, mcpClose, mcpInitialize, mcpPost, type McpHttpSession } from './mcp_http.js';
import {
  collectKnownCaseIds, isGatePass, redact, registerSecrets, summarize, validateCasesJson, writeReports,
  type HealthReport,
} from './report.js';
import {
  LiveBlocked, LiveFail, LiveUnavailable, LiveUnverified,
  type CaseContext, type CaseResult, type HealthCase, type HealthStatus, type ObservedSource,
} from './types.js';

interface Args { live: boolean; image: string; out: string; enableHotel: boolean; }

export function parseArgs(argv: string[]): Args {
  const args: Args = { live: false, image: '', out: '', enableHotel: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') args.live = true;
    else if (argv[i] === '--image') args.image = argv[++i] ?? '';
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
    else if (argv[i] === '--enable-hotel') args.enableHotel = true;
  }
  return args;
}

const PASS_THROUGH_ENV = [
  'UPS_CLIENT_ID', 'UPS_CLIENT_SECRET',
  'FEDEX_API_KEY', 'FEDEX_CLIENT_ID', 'FEDEX_API_SECRET', 'FEDEX_CLIENT_SECRET',
  'DHL_EXPRESS_API_KEY', 'DHL_API_KEY',
];

function sh(cmd: string, args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { input, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
  return { code: r.status ?? 1, out: String(r.stdout ?? '') };
}

function claimFreePort(): number {
  // Claim an ephemeral port so parallel lanes never collide.
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  const port = probe.port ?? 0;
  if (!port) throw new Error('no free port available');
  probe.stop(true);
  return port;
}

function classifyRestStatus(status: number, body: string, what: string): never {
  if (status === 429 || status >= 500) throw new LiveUnavailable(`${what} HTTP ${status}: ${body.slice(0, 160)}`);
  if (status === 403) throw new LiveBlocked(`${what} HTTP 403: ${body.slice(0, 160)}`);
  throw new LiveFail(`${what} HTTP ${status}: ${body.slice(0, 300)}`);
}

async function withTimeout<T>(ms: number, label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new LiveUnavailable(label + ' exceeded case timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.live) {
    console.error('refusing to run live checks without --live');
    return 2;
  }
  if (!args.image) {
    console.error('refusing to run live checks without --image (candidate container required)');
    return 2;
  }
  if (!args.out) {
    console.error('missing --out directory');
    return 2;
  }
  const lane = args.enableHotel ? 'hotel' : 'standard';
  const startedAt = new Date().toISOString();
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {}

  const toolIds = TOOL_CASES.map((c) => c.id);
  let secrets: Record<string, Record<string, string>>;
  try {
    secrets = validateCasesJson(process.env.SORA_TOOL_HEALTH_CASES_JSON, collectKnownCaseIds(toolIds)).cases;
  } catch (e) {
    console.error('cases config error: ' + redact(String((e as Error)?.message ?? e)));
    return 2;
  }
  registerSecrets(Object.values(secrets).flatMap((c) => Object.values(c)));
  registerSecrets(PASS_THROUGH_ENV.map((k) => process.env[k]));

  const inspected = sh('docker', ['inspect', '--format', '{{.Id}}', args.image]);
  if (inspected.code !== 0 || !inspected.out.trim()) {
    console.error('cannot inspect image: ' + args.image);
    return 2;
  }
  const imageId = inspected.out.trim();

  const container = 'sora-tool-health-' + randomUUID().slice(0, 8);
  const hostPort = claimFreePort();
  const hostName = `127.0.0.1:${hostPort}`;
  const dockerArgs = [
    'run', '-d', '--rm', '--name', container,
    '-p', `127.0.0.1:${hostPort}:8000`,
    '-e', 'SORA_DB_PATH=/tmp/tool-health.db',
    '-e', `SORA_ALLOWED_HOSTS=${hostName},localhost:${hostPort}`,
    '-e', `SORA_ALLOWED_ORIGINS=http://${hostName},http://localhost:${hostPort}`,
    ...(args.enableHotel ? ['-e', 'SORA_RAKUTEN_TRAVEL_ENABLED=true'] : []),
    ...PASS_THROUGH_ENV.filter((k) => process.env[k]).flatMap((k) => ['-e', `${k}=${process.env[k]}`]),
    args.image,
  ];
  const started = sh('docker', dockerArgs);
  if (started.code !== 0) {
    console.error('docker run failed');
    return 2;
  }
  const cleanup = () => { sh('docker', ['rm', '-f', container]); };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    const baseUrl = `http://127.0.0.1:${hostPort}`;

    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(5000) });
        if (res.status === 200) { await res.json(); ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) throw new Error('server never became ready');

    const session: McpHttpSession = { baseUrl, extraHeaders: { Origin: baseUrl } };
    await mcpInitialize(session, 30000);
    for (const name of CANONICAL_TOOLS) {
      if (name === 'search_tools') continue;
      try {
        await mcpCall(session, 'search_tools', { query: name }, 15000);
      } catch {}
    }
    const mcp = {
      async callTool(name: string, toolArgs: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        return mcpCall(session, name, toolArgs, timeoutMs);
      },
      async listTools(timeoutMs: number): Promise<string[]> {
        const res = await mcpPost(session, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, timeoutMs);
        return (((res.body as any)?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
      },
    };
    const rest = {
      async call(method: string, path: string, body: unknown, timeoutMs: number) {
        let res: Response;
        try {
          res = await fetch(baseUrl + path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          throw new LiveUnavailable(`REST ${method} ${path} transport failed`);
        }
        const text = await res.text();
        if (res.status < 200 || res.status >= 300) classifyRestStatus(res.status, text, `REST ${method} ${path}`);
        try {
          return { status: res.status, json: JSON.parse(text) };
        } catch {
          throw new LiveFail(`REST ${method} ${path} returned non-JSON`);
        }
      },
    };
    const liveSecrets = {
      getCase: (id: string) => secrets[id],
      hasCase: (id: string) => id in secrets,
    };

    const results: CaseResult[] = [];
    const report = (overall: 'pass' | 'fail'): Parameters<typeof writeReports>[1] => ({
      meta: {
        startedAt, finishedAt: new Date().toISOString(), commit,
        image: args.image, imageId, lane,
        runner: `bun ${process.version} ${process.platform}/${process.arch}`, overall,
      },
      results: [...results],
      counts: summarize(results),
      missing: [],
    });

    const record = (partial: Omit<CaseResult, 'startedAt' | 'durationMs'> & { startedAt: string; durationMs: number }): void => {
      results.push(partial);
      const counts = summarize(results);
      writeReports(args.out, { ...report('fail'), counts, missing: [] });
    };

    const toolCases = TOOL_CASES.filter((c) => (args.enableHotel ? true : !c.hotelLaneOnly));
    for (const c of toolCases) {
      await runToolCase(c, { mcp, rest, secrets: liveSecrets, signal: AbortSignal.timeout(c.timeoutMs) }, record);
      await new Promise((r) => setTimeout(r, 1000));
    }
    for (const p of PROVIDER_CASES) {
      await runProviderCase(p, record);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await mcpClose(session, 5000).catch(() => {});

    const coveredTools = new Set(results.flatMap((r) => r.toolNames));
    const laneTools = args.enableHotel ? [...CANONICAL_TOOLS] : [...CANONICAL_TOOLS].filter((t) => t !== HOTEL_TOOL);
    const missing = laneTools.filter((t) => !coveredTools.has(t));
    const counts = summarize(results);
    const overall = isGatePass(counts, missing) ? 'pass' : 'fail';
    writeReports(args.out, { ...report(overall), counts, missing });
    console.log(`tool-health ${lane}: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') + (missing.length ? ` missing=${missing.join(',')}` : ''));
    return overall === 'pass' ? 0 : 1;
  } catch (e) {
    console.error('runner failed: ' + redact(String((e as Error)?.message ?? e)));
    return 1;
  } finally {
    cleanup();
  }
}

async function runToolCase(
  c: HealthCase,
  baseCtx: Omit<CaseContext, 'signal'> & { signal: AbortSignal },
  record: (r: CaseResult) => void,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let attempts = 0;
  let recovered = false;
  for (;;) {
    attempts += 1;
    try {
      const obs = await withTimeout(c.timeoutMs, c.id, (signal) => c.run({ ...baseCtx, signal }));
      const emptyOk = (obs as { emptyOk?: boolean }).emptyOk === true;
      record({ caseId: c.id, toolNames: c.toolNames, dependencyIds: c.dependencyIds, status: emptyOk ? 'pass_empty' : 'pass', reason: obs.detail ?? 'ok', startedAt, durationMs: Date.now() - started, attempts, recovered, observedSources: obs.sources });
      return;
    } catch (e) {
      const status: HealthStatus =
        e instanceof LiveUnavailable ? 'unavailable'
        : e instanceof LiveBlocked ? 'blocked'
        : e instanceof LiveUnverified ? 'unverified'
        : 'fail';
      if ((status === 'unavailable' || status === 'unverified') && attempts === 1 && c.externalRequired) {
        recovered = true;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const reason = e instanceof LiveFail || e instanceof LiveUnavailable || e instanceof LiveBlocked || e instanceof LiveUnverified
        ? (e.message as string)
        : 'unexpected: ' + String((e as Error)?.message ?? e).slice(0, 200);
      const sources: ObservedSource[] = [];
      record({ caseId: c.id, toolNames: c.toolNames, dependencyIds: c.dependencyIds, status, reason, startedAt, durationMs: Date.now() - started, attempts, recovered: false, observedSources: sources });
      return;
    }
  }
}

async function runProviderCase(p: ProviderCase, record: (r: CaseResult) => void): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const obs = await withTimeout(p.timeoutMs, p.id, (signal) => p.run(signal));
      const emptyOk = (obs as { emptyOk?: boolean }).emptyOk === true;
      record({ caseId: p.id, toolNames: [], dependencyIds: p.dependencyIds, status: emptyOk ? 'pass_empty' : 'pass', reason: obs.detail ?? 'ok', startedAt, durationMs: Date.now() - started, attempts, recovered: attempts > 1, observedSources: obs.sources });
      return;
    } catch (e) {
      const status: HealthStatus =
        e instanceof LiveUnavailable ? 'unavailable'
        : e instanceof LiveBlocked ? 'blocked'
        : e instanceof LiveUnverified ? 'unverified'
        : 'fail';
      if (status === 'unavailable' && attempts === 1) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const reason = e instanceof Error ? e.message : String(e).slice(0, 200);
      record({ caseId: p.id, toolNames: [], dependencyIds: p.dependencyIds, status, reason, startedAt, durationMs: Date.now() - started, attempts, recovered: false, observedSources: [] });
      return;
    }
  }
}

export { main as runToolHealth };

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
