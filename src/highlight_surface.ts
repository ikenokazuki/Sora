export interface HighlightTextItem {
  text?: unknown;
}

export function canonicalHighlightTexts(
  highlights?: readonly string[] | null,
  highlightItems?: readonly HighlightTextItem[] | null,
): string[] | undefined {
  const direct = (highlights ?? []).filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (direct.length > 0) return [...direct];

  const fallback = (highlightItems ?? [])
    .map((item) => item?.text)
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );

  return fallback.length > 0 ? fallback : undefined;
}

export function stripHighlightInternals(
  record: Record<string, any>,
): Record<string, any> {
  const clean = { ...record };
  const canonical = canonicalHighlightTexts(
    Array.isArray(clean.highlights) ? clean.highlights : undefined,
    Array.isArray(clean.highlightItems) ? clean.highlightItems : undefined,
  );

  if (canonical?.length) clean.highlights = canonical;
  else delete clean.highlights;

  delete clean.highlightItems;
  delete clean.highlightDiagnostics;
  return clean;
}
