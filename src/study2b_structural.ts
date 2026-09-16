import {
  parseMarkdownSections,
  tokenizeAndSelectTerms,
  type ParsedSection,
} from './rho_select.js';
import {
  selectEvidenceSetRhoV2,
  type RhoOptimizerCertificate,
} from './rho_select_v2.js';

export type Study2BGateReason =
  | 'markdown_table'
  | 'footnote_dependency'
  | 'repeated_leaf_across_parents';

export interface Study2BGate {
  activated: boolean;
  reliableStructuralAddress: boolean;
  reasons: Study2BGateReason[];
}

export interface Study2BBundle {
  id: string;
  address: string;
  heading: string;
  text: string;
  dependencyKind: 'table_header' | 'footnote' | 'hierarchical_sibling';
}

export interface Study2BHighlightItem {
  text: string;
  score: number;
  cost: number;
  evidenceScores: number[];
  heading?: string;
}

export interface Study2BResult {
  applied: boolean;
  gate: Study2BGate;
  highlights: string[];
  highlightItems: Study2BHighlightItem[];
  diagnostics: {
    engine: 'study2b-structural-rho-v2';
    gate: Study2BGate;
    bundleCount: number;
    requirementCount: number;
    selectedCount: number;
    selectedTokens: number;
    certificate?: RhoOptimizerCertificate;
  };
}

export interface Study2BOptions {
  overheadTokens?: number;
  maxTerms?: number;
}

interface TableBlock {
  heading: string;
  headerLine: string;
  separatorLine: string;
  rows: string[];
}

function estimateTokens(text: string): number {
  if (!text) return 1;
  const cjkChars = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const nonCjkChars = text.length - cjkChars;
  return Math.max(1, Math.ceil(cjkChars * 0.77 + nonCjkChars * 0.25));
}

function normalizeLeaf(heading: string): string {
  const parts = heading
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}

function parentPath(heading: string): string {
  const parts = heading
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, -1).join(' > ').toLowerCase();
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && splitTableCells(trimmed).length >= 2;
}

function isSeparatorLine(line: string): boolean {
  const cells = splitTableCells(line);
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function extractTableBlocks(markdown: string): TableBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: TableBlock[] = [];
  const stack: Array<{ level: number; title: string }> = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const headingMatch = lines[i].trim().match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: headingMatch[2].trim() });
      continue;
    }

    if (!isTableRow(lines[i]) || !isSeparatorLine(lines[i + 1])) continue;

    const rows: string[] = [];
    let j = i + 2;
    while (j < lines.length && isTableRow(lines[j]) && !isSeparatorLine(lines[j])) {
      rows.push(lines[j]);
      j++;
    }

    if (rows.length > 0) {
      blocks.push({
        heading: stack.map((entry) => entry.title).join(' > '),
        headerLine: lines[i],
        separatorLine: lines[i + 1],
        rows,
      });
    }
    i = Math.max(i, j - 1);
  }

  return blocks;
}

function extractFootnoteDefinitions(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\s*\[\^([^\]]+)\]:\s*(.+)$/);
    if (match) map.set(match[1].trim(), match[2].trim());
  }
  return map;
}

function buildRepeatedLeafBundles(sections: ParsedSection[]): Study2BBundle[] {
  const grouped = new Map<string, ParsedSection[]>();

  for (const section of sections) {
    if (!section.heading || !section.heading.includes('>')) continue;
    const leaf = normalizeLeaf(section.heading);
    if (!leaf) continue;
    const list = grouped.get(leaf) || [];
    list.push(section);
    grouped.set(leaf, list);
  }

  const bundles: Study2BBundle[] = [];
  for (const [leaf, group] of grouped) {
    const parents = new Set(group.map((section) => parentPath(section.heading)).filter(Boolean));
    if (parents.size < 2) continue;

    for (const section of group) {
      bundles.push({
        id: `heading:${section.startIndex}`,
        address: section.heading,
        heading: section.heading,
        text: `## ${section.heading}\n\n${section.fullText}`.trim(),
        dependencyKind: 'hierarchical_sibling',
      });
    }
  }
  return bundles;
}

function buildFootnoteBundles(
  sections: ParsedSection[],
  definitions: Map<string, string>,
): Study2BBundle[] {
  const bundles: Study2BBundle[] = [];

  for (const section of sections) {
    if (!section.heading) continue;
    const refs = Array.from(section.fullText.matchAll(/\[\^([^\]]+)\]/g))
      .map((match) => match[1].trim())
      .filter((id) => definitions.has(id));

    if (refs.length === 0) continue;

    const noteText = Array.from(new Set(refs))
      .map((id) => `[^${id}]: ${definitions.get(id)}`)
      .join('\n');

    bundles.push({
      id: `footnote:${section.startIndex}`,
      address: section.heading,
      heading: section.heading,
      text: `## ${section.heading}\n\n${section.fullText}\n\n${noteText}`.trim(),
      dependencyKind: 'footnote',
    });
  }

  return bundles;
}

function buildTableBundles(blocks: TableBlock[]): Study2BBundle[] {
  const bundles: Study2BBundle[] = [];

  blocks.forEach((block, blockIndex) => {
    const headers = splitTableCells(block.headerLine);
    block.rows.forEach((row, rowIndex) => {
      const cells = splitTableCells(row);
      const rowLabel = cells[0] || `row-${rowIndex + 1}`;
      const heading = block.heading || `table-${blockIndex + 1}`;
      const address = `${heading} > ${headers[0] || 'row'}=${rowLabel}`;

      bundles.push({
        id: `table:${blockIndex}:${rowIndex}`,
        address,
        heading,
        text: [
          `## ${address}`,
          '',
          block.headerLine,
          block.separatorLine,
          row,
        ].join('\n'),
        dependencyKind: 'table_header',
      });
    });
  });

  return bundles;
}

function dedupBundles(bundles: Study2BBundle[]): Study2BBundle[] {
  const seen = new Set<string>();
  const result: Study2BBundle[] = [];
  for (const bundle of bundles) {
    const key = `${bundle.address}\n${bundle.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(bundle);
  }
  return result;
}

export function detectStudy2BStructuralGate(markdown: string): Study2BGate {
  const sections = parseMarkdownSections(markdown);
  const tables = extractTableBlocks(markdown);
  const definitions = extractFootnoteDefinitions(markdown);
  const footnoteBundles = buildFootnoteBundles(sections, definitions);
  const repeatedBundles = buildRepeatedLeafBundles(sections);

  const reasons: Study2BGateReason[] = [];
  if (tables.length > 0) reasons.push('markdown_table');
  if (footnoteBundles.length > 0) reasons.push('footnote_dependency');
  if (repeatedBundles.length > 0) reasons.push('repeated_leaf_across_parents');

  const reliableStructuralAddress =
    tables.some((table) => splitTableCells(table.headerLine).length >= 2) ||
    footnoteBundles.some((bundle) => bundle.address.length > 0) ||
    repeatedBundles.some((bundle) => bundle.address.includes('>'));

  return {
    activated: reliableStructuralAddress && reasons.length > 0,
    reliableStructuralAddress,
    reasons,
  };
}

function countOccurrences(text: string, term: string): number {
  if (!text || !term) return 0;
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count++;
    cursor += Math.max(needle.length, 1);
  }
  return count;
}

export function selectStructuralEvidenceStudy2B(
  markdown: string,
  query: string,
  options: Study2BOptions = {},
): Study2BResult {
  const gate = detectStudy2BStructuralGate(markdown);
  const emptyDiagnostics = {
    engine: 'study2b-structural-rho-v2' as const,
    gate,
    bundleCount: 0,
    requirementCount: 0,
    selectedCount: 0,
    selectedTokens: 0,
  };

  if (!gate.activated) {
    return {
      applied: false,
      gate,
      highlights: [],
      highlightItems: [],
      diagnostics: emptyDiagnostics,
    };
  }

  const sections = parseMarkdownSections(markdown);
  const bundles = dedupBundles([
    ...buildTableBundles(extractTableBlocks(markdown)),
    ...buildFootnoteBundles(sections, extractFootnoteDefinitions(markdown)),
    ...buildRepeatedLeafBundles(sections),
  ]);

  if (bundles.length === 0) {
    return {
      applied: false,
      gate,
      highlights: [],
      highlightItems: [],
      diagnostics: emptyDiagnostics,
    };
  }

  const pseudoSections: ParsedSection[] = bundles.map((bundle, index) => ({
    rawHeading: bundle.heading,
    heading: bundle.address,
    headingLevel: 2,
    paragraphs: [bundle.text],
    fullText: bundle.text,
    charLength: bundle.text.length,
    startIndex: index,
  }));

  const requirements = tokenizeAndSelectTerms(
    query,
    pseudoSections,
    options.maxTerms ?? 6,
  ).terms;

  if (requirements.length === 0) {
    return {
      applied: false,
      gate,
      highlights: [],
      highlightItems: [],
      diagnostics: {
        ...emptyDiagnostics,
        bundleCount: bundles.length,
      },
    };
  }

  const rawScores = bundles.map((bundle) =>
    requirements.map((term) => {
      const headingHits = countOccurrences(bundle.address, term);
      const bodyHits = countOccurrences(bundle.text, term);
      return headingHits * 2 + bodyHits;
    }),
  );

  const maxima = requirements.map((_, reqIndex) =>
    Math.max(...rawScores.map((row) => row[reqIndex]), 0),
  );

  const scores = rawScores.map((row) =>
    row.map((value, reqIndex) => {
      const max = maxima[reqIndex];
      return max > 0 ? Math.min(1, value / max) : 0;
    }),
  );

  if (!scores.some((row) => row.some((value) => value > 0))) {
    return {
      applied: false,
      gate,
      highlights: [],
      highlightItems: [],
      diagnostics: {
        ...emptyDiagnostics,
        bundleCount: bundles.length,
        requirementCount: requirements.length,
      },
    };
  }

  const costs = bundles.map((bundle) => estimateTokens(bundle.text));
  const selection = selectEvidenceSetRhoV2(
    {
      scores,
      costs,
      tau: options.overheadTokens ?? 96,
      utility: {
        kind: 'weighted-sum',
        weights: requirements.map(() => 1),
      },
    },
    {
      epsilon: 0.05,
      exactSubsetThreshold: 50_000,
      dominancePreprocess: true,
      maxIterations: 100,
      maxStates: 500_000,
    },
  );

  // Preserve solver/certificate equivalence. Do not truncate the certified
  // atomic bundle set after low-level rho-select-v2 returns.
  const selectedIndices = selection.indices.slice();

  const highlightItems = selectedIndices.map((index) => ({
    text: bundles[index].text,
    score: Math.max(...scores[index], 0),
    cost: costs[index],
    evidenceScores: scores[index],
    heading: bundles[index].address,
  }));

  const highlights = highlightItems.map((item) => item.text);

  return {
    applied: highlights.length > 0,
    gate,
    highlights,
    highlightItems,
    diagnostics: {
      engine: 'study2b-structural-rho-v2',
      gate,
      bundleCount: bundles.length,
      requirementCount: requirements.length,
      selectedCount: highlights.length,
      selectedTokens: highlightItems.reduce((sum, item) => sum + item.cost, 0),
      certificate: selection.certificate,
    },
  };
}
