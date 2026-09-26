// In-memory security/retrieval counters (RFC observability).
// Process-local only; scraped via getSecurityMetrics().
const counters: Record<string, number> = {};

export function incrementSecurityCounter(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function getSecurityMetrics(): Record<string, number> {
  return { ...counters };
}

export function resetSecurityMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}
