/**
 * Yahoo provider pressure controller (Retrieval v2, spec section 3-15).
 *
 * Replaces the fixed `SORA_WEB_RETRY_WAIT_MS` wait plus request-local
 * `waitedOnce` flag with a provider-wide AIMD controller:
 * successes shrink the spacing, 429s grow it, and a sliding-window
 * circuit stops all Yahoo Web traffic while the provider is hot.
 * X Realtime has its own discipline and never shares this instance.
 */

export type ProviderPressureLevel = 'low' | 'medium' | 'high';

export type ProviderCircuit = 'closed' | 'open' | 'half-open';

export interface ProviderPressureSnapshot {
  level: ProviderPressureLevel;
  spacingMs: number;
  cooldownUntil: number;
  recentSuccesses: number;
  recentRateLimits: number;
  circuit: ProviderCircuit;
}

export interface ProviderPressureOptions {
  minSpacingMs: number;
  maxSpacingMs: number;
  initialSpacingMs: number;
  increaseStepMs: number;
  decreaseMultiplier: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  /** Sliding window for 429 counting. Old 429s must not linger forever. */
  windowMs?: number;
}

interface ProviderEvent {
  at: number;
  type: 'success' | 'rate_limit';
}

export function defaultYahooPressureOptions(): ProviderPressureOptions {
  // SORA_WEB_RETRY_WAIT_MS is deprecated: honored only as the initial
  // spacing override during migration, then removed.
  const legacy = Number(process.env.SORA_WEB_RETRY_WAIT_MS ?? '');
  const initialSpacingMs =
    Number.isFinite(legacy) && legacy >= 0 ? legacy : 400;
  return {
    minSpacingMs: 150,
    initialSpacingMs,
    maxSpacingMs: 5000,
    increaseStepMs: 50,
    decreaseMultiplier: 2,
    circuitThreshold: 3,
    circuitCooldownMs: 15_000,
    windowMs: 30_000,
  };
}

export class ProviderPressureController {
  private spacingMs: number;
  private cooldownUntil = 0;
  private circuit: ProviderCircuit = 'closed';
  private events: ProviderEvent[] = [];

  constructor(private readonly options: ProviderPressureOptions) {
    this.spacingMs = options.initialSpacingMs;
  }

  private prune(now: number): void {
    const windowMs = this.options.windowMs ?? 30_000;
    while (this.events.length > 0 && now - this.events[0].at > windowMs) {
      this.events.shift();
    }
  }

  private rateLimitsInWindow(): number {
    let n = 0;
    for (const e of this.events) if (e.type === 'rate_limit') n++;
    return n;
  }

  private successesInWindow(): number {
    let n = 0;
    for (const e of this.events) if (e.type === 'success') n++;
    return n;
  }

  onSuccess(now: number = Date.now()): void {
    this.prune(now);
    this.events.push({ at: now, type: 'success' });
    this.spacingMs = Math.max(
      this.options.minSpacingMs,
      this.spacingMs - this.options.increaseStepMs,
    );
    if (this.circuit === 'half-open') {
      this.circuit = 'closed';
      this.events = this.events.filter((e) => e.type !== 'rate_limit');
    }
  }

  onRateLimit(retryAfterMs?: number, now: number = Date.now()): void {
    this.prune(now);
    this.events.push({ at: now, type: 'rate_limit' });
    this.spacingMs = Math.min(
      this.options.maxSpacingMs,
      Math.ceil(this.spacingMs * this.options.decreaseMultiplier),
    );
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfterMs);
    }
    if (this.circuit === 'half-open' || this.rateLimitsInWindow() >= this.options.circuitThreshold) {
      this.circuit = 'open';
      this.cooldownUntil = Math.max(this.cooldownUntil, now + this.options.circuitCooldownMs);
    }
  }

  /** No long sleeps: callers check this before firing another request. */
  canRequest(now: number = Date.now()): boolean {
    if (this.circuit === 'open') {
      if (now < this.cooldownUntil) return false;
      // Cooldown expired: allow exactly one probe.
      this.circuit = 'half-open';
      return true;
    }
    return now >= this.cooldownUntil;
  }

  getLevel(now: number = Date.now()): ProviderPressureLevel {
    this.prune(now);
    if (this.circuit === 'open') return 'high';
    const recentRateLimits = this.rateLimitsInWindow();
    if (recentRateLimits >= 2 || this.spacingMs >= 1500) return 'high';
    if (recentRateLimits >= 1 || this.spacingMs >= 700) return 'medium';
    return 'low';
  }

  snapshot(now: number = Date.now()): ProviderPressureSnapshot {
    this.prune(now);
    return {
      level: this.getLevel(now),
      spacingMs: this.spacingMs,
      cooldownUntil: this.cooldownUntil,
      recentSuccesses: this.successesInWindow(),
      recentRateLimits: this.rateLimitsInWindow(),
      circuit: this.circuit,
    };
  }

  /** Test/support escape hatch: restore fresh state. */
  reset(): void {
    this.spacingMs = this.options.initialSpacingMs;
    this.cooldownUntil = 0;
    this.circuit = 'closed';
    this.events = [];
  }
}

/** Pressure-aware Yahoo Web query budget: provider health wins over flags. */
export function getYahooQueryBudget(pressure: ProviderPressureLevel): number {
  switch (pressure) {
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}
