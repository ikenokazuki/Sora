// Tool-health live harness shared contracts (Tasks 8-9).
export type HealthStatus =
  | 'pass'
  | 'pass_empty'
  | 'fail'
  | 'unavailable'
  | 'blocked'
  | 'unverified'
  | 'not_applicable';

export class LiveFail extends Error { readonly kind = 'fail' as const; }
export class LiveUnavailable extends Error { readonly kind = 'unavailable' as const; }
export class LiveBlocked extends Error { readonly kind = 'blocked' as const; }
export class LiveUnverified extends Error { readonly kind = 'unverified' as const; }

export interface ObservedSource {
  source: string;
  count?: number;
  format?: string;
  upstreamStatus?: number | 'unknown';
  cached?: boolean;
  note?: string;
}

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  listTools(timeoutMs: number): Promise<string[]>;
}

export interface RestCaller {
  call(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }>;
}

export interface LiveSecrets {
  getCase(caseId: string): Record<string, string> | undefined;
  hasCase(caseId: string): boolean;
}

export interface CaseContext {
  mcp: McpCaller;
  rest: RestCaller;
  secrets: LiveSecrets;
  signal: AbortSignal;
}

export interface CaseObservation {
  detail?: string;
  sources: ObservedSource[];
}

export interface HealthCase {
  id: string;
  toolNames: string[];
  dependencyIds: string[];
  externalRequired: boolean;
  timeoutMs: number;
  run(ctx: CaseContext): Promise<CaseObservation>;
}

export interface CaseResult {
  caseId: string;
  toolNames: string[];
  dependencyIds: string[];
  status: HealthStatus;
  reason: string;
  startedAt: string;
  durationMs: number;
  attempts: number;
  recovered: boolean;
  observedSources: ObservedSource[];
}
