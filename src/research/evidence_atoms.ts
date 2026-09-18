/**
 * Sora Evidence Compiler Research — Evidence Atomizer
 *
 * NOTE: This is a research-only module.
 *
 * Implements:
 * - Arm A: Baseline Section Candidate (production parity)
 * - Arm B: Structural Closure (Table header+row, Footnote closure, Hierarchical headings, Label-value lists)
 * - Arm C: Fine-grained Span Candidates (sentence/paragraph/list/table/code, with reconstruction closure)
 */

import { estimateTokens } from '../enrichment.js';
import { parseMarkdownSections, type ParsedSection } from '../rho_select.js';

export interface EvidenceSpan {
  start: number;
  end: number;
}

export type AtomKind =
  | 'section'
  | 'paragraph'
  | 'sentence'
  | 'list-item'
  | 'key-value'
  | 'table-row'
  | 'code-block'
  | 'footnote';

export interface EvidenceAtom {
  id: number;
  kind: AtomKind;
  spans: EvidenceSpan[];
  headingPath?: string;
  dependencies?: number[];
  text: string;
  metadata?: Record<string, any>;
}

export interface ResearchCandidateBlock {
  id: number;
  heading: string;
  body: string;
  snippetText: string;
  cost: number;
  isSupplemental: boolean;
  atomIds: number[];
  kind: AtomKind;
}

// -----------------------------------------------------------------------------
// Arm A: Baseline Section Candidate Construction
// Parity with production buildCandidateBlocks()
// -----------------------------------------------------------------------------

export function buildArmACandidates(
  markdown: string,
  supplementalEvidence?: string[],
): { atoms: EvidenceAtom[]; candidates: ResearchCandidateBlock[] } {
  const parsedSections = parseMarkdownSections(markdown);
  const atoms: EvidenceAtom[] = [];
  const candidates: ResearchCandidateBlock[] = [];
  let nextId = 0;

  for (const sec of parsedSections) {
    const heading = sec.heading.trim();
    const body = sec.fullText.trim();
    if (!body && !heading) continue;

    const id = nextId++;
    const atom: EvidenceAtom = {
      id,
      kind: 'section',
      spans: [{ start: sec.startIndex, end: sec.startIndex + sec.charLength }],
      headingPath: heading,
      text: body,
    };
    atoms.push(atom);

    const snippetText = heading ? `## ${heading}\n\n${body}` : body;
    const cost = Math.max(estimateTokens(snippetText), 1);

    candidates.push({
      id,
      heading,
      body,
      snippetText,
      cost,
      isSupplemental: false,
      atomIds: [id],
      kind: 'section',
    });
  }

  // Supplemental evidence handling (parity with production)
  if (supplementalEvidence && supplementalEvidence.length > 0) {
    for (const sup of supplementalEvidence) {
      const trimmed = (sup || '').trim();
      if (!trimmed) continue;

      const isDuplicate = candidates.some(
        (c) => c.body.includes(trimmed) || trimmed.includes(c.body),
      );
      if (isDuplicate) continue;

      const id = nextId++;
      const snippetText = `> 📌 **補完証拠 (スニペット)**: ${trimmed}`;
      const cost = Math.max(estimateTokens(snippetText), 1);

      const atom: EvidenceAtom = {
        id,
        kind: 'paragraph',
        spans: [],
        headingPath: '補完証拠',
        text: trimmed,
      };
      atoms.push(atom);

      candidates.push({
        id,
        heading: '補完証拠',
        body: trimmed,
        snippetText,
        cost,
        isSupplemental: true,
        atomIds: [id],
        kind: 'paragraph',
      });
    }
  }

  return { atoms, candidates };
}

// -----------------------------------------------------------------------------
// Arm B: Structural Closure
// - Table: Table header + row closure
// - Footnote: Reference-bearing text + Footnote definition closure
// - Repeated Headings: Parent > Leaf address hierarchy
// - Label-Value / Lists: Do not split labels from values across blank lines
// -----------------------------------------------------------------------------

interface ParsedTable {
  headerText: string;
  rows: string[];
  startIndex: number;
  endIndex: number;
}

interface FootnoteDefinition {
  id: string;
  text: string;
  span: EvidenceSpan;
}

export function buildArmBCandidates(
  markdown: string,
  supplementalEvidence?: string[],
): { atoms: EvidenceAtom[]; candidates: ResearchCandidateBlock[] } {
  if (!markdown) {
    return buildArmACandidates('', supplementalEvidence);
  }

  // Extract footnote definitions first: [^id]: text
  const footnoteDefs = new Map<string, FootnoteDefinition>();
  const footnoteRegex = /^\[\^([^\]]+)\]:\s*([\s\S]*?)(?=(?:\r?\n\[\^|$|\r?\n\r?\n[^\s]))/gm;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = footnoteRegex.exec(markdown)) !== null) {
    footnoteDefs.set(fnMatch[1], {
      id: fnMatch[1],
      text: fnMatch[2].trim(),
      span: { start: fnMatch.index, end: fnMatch.index + fnMatch[0].length },
    });
  }

  // Clean frontmatter & breadcrumb (same as production parseMarkdownSections)
  let cleaned = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
  let rootContext = '';
  const breadcrumbMatch = cleaned.match(/^>\s*📍\s*\*\*階層\*\*:\s*(?:.*?[>›\\]\s*)*([^\r\n>›\\]+)$/m);
  if (breadcrumbMatch) {
    rootContext = breadcrumbMatch[1].trim();
  }
  cleaned = cleaned.replace(/^>\s*(?:📍|📅)\s*\*\*.*?\*\*:.*$/gm, '');

  const lines = cleaned.split(/\r?\n/);
  const atoms: EvidenceAtom[] = [];
  const candidates: ResearchCandidateBlock[] = [];
  let nextId = 0;

  // Heading hierarchy stack: { level, title }
  const headingStack: { level: number; title: string }[] = [];

  const getHeadingPath = (): string => {
    let path = headingStack.map((h) => h.title).join(' > ');
    const hasH1 = headingStack.some((h) => h.level === 1);
    if (rootContext && !hasH1 && (!path || !path.includes(rootContext))) {
      path = path ? `${rootContext} > ${path}` : rootContext;
    }
    return path;
  };

  let inCodeBlock = false;
  let codeBlockBuffer: string[] = [];
  let codeBlockLang = '';

  let tableBuffer: string[] = [];
  let tableStartIndex = 0;

  let textBuffer: string[] = [];
  let runningIndex = 0;

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) return;
    const rawText = textBuffer.join('\n').trim();
    textBuffer = [];
    if (!rawText) return;

    // Check for footnote references inside this block: [^id]
    const referencedFootnotes: string[] = [];
    const refRegex = /\[\^([^\]]+)\]/g;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(rawText)) !== null) {
      if (footnoteDefs.has(refMatch[1]) && !referencedFootnotes.includes(refMatch[1])) {
        referencedFootnotes.push(refMatch[1]);
      }
    }

    let closedText = rawText;
    if (referencedFootnotes.length > 0) {
      // Append footnote definitions to ensure structural closure
      const fnTexts = referencedFootnotes
        .map((fnId) => `[^${fnId}]: ${footnoteDefs.get(fnId)?.text || ''}`)
        .join('\n');
      closedText = `${rawText}\n\n${fnTexts}`;
    }

    const heading = getHeadingPath();
    const id = nextId++;
    const atom: EvidenceAtom = {
      id,
      kind: 'paragraph',
      spans: [],
      headingPath: heading,
      text: closedText,
    };
    atoms.push(atom);

    const snippetText = heading ? `## ${heading}\n\n${closedText}` : closedText;
    const cost = Math.max(estimateTokens(snippetText), 1);

    candidates.push({
      id,
      heading,
      body: closedText,
      snippetText,
      cost,
      isSupplemental: false,
      atomIds: [id],
      kind: 'paragraph',
    });
  };

  const flushTableBuffer = () => {
    if (tableBuffer.length < 2) {
      // Not a real table, push back to text
      textBuffer.push(...tableBuffer);
      tableBuffer = [];
      return;
    }

    // Inspect table header and delimiter
    const headerRow = tableBuffer[0];
    const delimiterRow = tableBuffer[1];
    
    // Robust Markdown table delimiter validation
    const isDelimiter = (() => {
      const trimmed = delimiterRow.trim();
      if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
      const cells = trimmed.split('|').map((c) => c.trim()).filter((c, idx, arr) => {
        if ((idx === 0 || idx === arr.length - 1) && c === '') return false;
        return true;
      });
      return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
    })();

    if (!isDelimiter) {
      textBuffer.push(...tableBuffer);
      tableBuffer = [];
      return;
    }

    const header = `${headerRow}\n${delimiterRow}`;
    const dataRows = tableBuffer.slice(2);
    tableBuffer = [];

    const heading = getHeadingPath();

    if (dataRows.length === 0) {
      // Empty table, just header
      const id = nextId++;
      atoms.push({ id, kind: 'table-row', spans: [], headingPath: heading, text: header });
      const snippetText = heading ? `## ${heading}\n\n${header}` : header;
      candidates.push({
        id,
        heading,
        body: header,
        snippetText,
        cost: Math.max(estimateTokens(snippetText), 1),
        isSupplemental: false,
        atomIds: [id],
        kind: 'table-row',
      });
      return;
    }

    // Arm B Structural Closure: Table header + row as an individual closure atom
    for (const row of dataRows) {
      const trimmedRow = row.trim();
      if (!trimmedRow) continue;

      const tableUnit = `${header}\n${trimmedRow}`;
      const id = nextId++;
      atoms.push({
        id,
        kind: 'table-row',
        spans: [],
        headingPath: heading,
        text: tableUnit,
      });

      const snippetText = heading ? `## ${heading}\n\n${tableUnit}` : tableUnit;
      const cost = Math.max(estimateTokens(snippetText), 1);

      candidates.push({
        id,
        heading,
        body: tableUnit,
        snippetText,
        cost,
        isSupplemental: false,
        atomIds: [id],
        kind: 'table-row',
      });
    }
  };

  const flushCodeBlock = () => {
    if (codeBlockBuffer.length === 0) return;
    const body = codeBlockBuffer.join('\n');
    const closed = `\`\`\`${codeBlockLang}\n${body}\n\`\`\``;
    codeBlockBuffer = [];
    codeBlockLang = '';

    const heading = getHeadingPath();
    const id = nextId++;
    atoms.push({ id, kind: 'code-block', spans: [], headingPath: heading, text: closed });

    const snippetText = heading ? `## ${heading}\n\n${closed}` : closed;
    candidates.push({
      id,
      heading,
      body: closed,
      snippetText,
      cost: Math.max(estimateTokens(snippetText), 1),
      isSupplemental: false,
      atomIds: [id],
      kind: 'code-block',
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block toggle
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // Close code block
        inCodeBlock = false;
        flushCodeBlock();
      } else {
        // Open code block
        flushTableBuffer();
        flushTextBuffer();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      }
      runningIndex += line.length + 1;
      continue;
    }

    if (inCodeBlock) {
      codeBlockBuffer.push(line);
      runningIndex += line.length + 1;
      continue;
    }

    // Footnote definition lines are skipped in body stream (they are attached via closure)
    if (/^\[\^[^\]]+\]:/.test(trimmed)) {
      flushTableBuffer();
      flushTextBuffer();
      runningIndex += line.length + 1;
      continue;
    }

    // Headings (H1 to H6)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushTableBuffer();
      flushTextBuffer();

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      runningIndex += line.length + 1;
      continue;
    }

    // Table rows
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|')) {
      flushTextBuffer();
      tableBuffer.push(line);
      runningIndex += line.length + 1;
      continue;
    } else if (tableBuffer.length > 0) {
      flushTableBuffer();
    }

    // Label-value list handling:
    // e.g. "- 作詞者" followed by blank line and "内山優花"
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      // If previous line was an item and current line is blank or next is non-blank value, keep together
      textBuffer.push(line);
    } else {
      textBuffer.push(line);
    }

    runningIndex += line.length + 1;
  }

  if (inCodeBlock) {
    flushCodeBlock();
  }
  flushTableBuffer();
  flushTextBuffer();

  // Add supplemental evidence
  if (supplementalEvidence && supplementalEvidence.length > 0) {
    for (const sup of supplementalEvidence) {
      const trimmed = (sup || '').trim();
      if (!trimmed) continue;

      const isDuplicate = candidates.some(
        (c) => c.body.includes(trimmed) || trimmed.includes(c.body),
      );
      if (isDuplicate) continue;

      const id = nextId++;
      const snippetText = `> 📌 **補完証拠 (スニペット)**: ${trimmed}`;
      const cost = Math.max(estimateTokens(snippetText), 1);

      atoms.push({
        id,
        kind: 'paragraph',
        spans: [],
        headingPath: '補完証拠',
        text: trimmed,
      });

      candidates.push({
        id,
        heading: '補完証拠',
        body: trimmed,
        snippetText,
        cost,
        isSupplemental: true,
        atomIds: [id],
        kind: 'paragraph',
      });
    }
  }

  return { atoms, candidates };
}

// -----------------------------------------------------------------------------
// Arm C: Fine-Grained Span Candidates
// Sentence / Paragraph / List-Item / Table-Row / Code-Block fine granularity
// with verbatim reconstruction closure:
// - Adjacent sentences merged into cohesive paragraph
// - Code lines closed with fenced code block
// - Table rows reconstructed with table headers
// -----------------------------------------------------------------------------

/**
 * Splits paragraph text into fine-grained sentences while protecting decimals, abbreviations, etc.
 */
export function splitSentencesWithOffsets(
  text: string,
  baseOffset: number,
): { text: string; span: EvidenceSpan }[] {
  if (!text) return [];

  const results: { text: string; span: EvidenceSpan }[] = [];
  // Sentence split boundaries: Japanese punctuation (。！？) or English sentence end (.!?) followed by space/newline
  const regex = /([^。！？\n]*[。！？]+|[^.!?\n]+[.!?]+(?:\s+|$)|[^\n]+(?:\n+|$))/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const start = baseOffset + match.index;
    const end = start + raw.length;
    results.push({
      text: trimmed,
      span: { start, end },
    });
  }

  if (results.length === 0 && text.trim().length > 0) {
    results.push({
      text: text.trim(),
      span: { start: baseOffset, end: baseOffset + text.length },
    });
  }

  return results;
}

export function buildArmCCandidates(
  markdown: string,
  supplementalEvidence?: string[],
): { atoms: EvidenceAtom[]; candidates: ResearchCandidateBlock[] } {
  // First extract structural elements using Arm B approach to guarantee valid table/code boundaries
  const armB = buildArmBCandidates(markdown, supplementalEvidence);
  const atoms: EvidenceAtom[] = [];
  const candidates: ResearchCandidateBlock[] = [];
  let nextId = 0;

  for (const block of armB.candidates) {
    if (block.isSupplemental) {
      // Keep supplemental block as single atom
      const id = nextId++;
      atoms.push({ ...armB.atoms.find((a) => a.id === block.id)!, id });
      candidates.push({ ...block, id, atomIds: [id] });
      continue;
    }

    if (block.kind === 'table-row') {
      // Table rows are already atomic with header closure in Arm B
      const id = nextId++;
      atoms.push({
        id,
        kind: 'table-row',
        spans: [],
        headingPath: block.heading,
        text: block.body,
      });
      candidates.push({
        id,
        heading: block.heading,
        body: block.body,
        snippetText: block.snippetText,
        cost: block.cost,
        isSupplemental: false,
        atomIds: [id],
        kind: 'table-row',
      });
      continue;
    }

    if (block.kind === 'code-block') {
      // Code blocks kept cohesive
      const id = nextId++;
      atoms.push({
        id,
        kind: 'code-block',
        spans: [],
        headingPath: block.heading,
        text: block.body,
      });
      candidates.push({
        id,
        heading: block.heading,
        body: block.body,
        snippetText: block.snippetText,
        cost: block.cost,
        isSupplemental: false,
        atomIds: [id],
        kind: 'code-block',
      });
      continue;
    }

    // Paragraph/Section text: Split into fine-grained sentence/list-item atoms
    const lines = block.body.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('+ ')) {
        // List item atom
        const id = nextId++;
        atoms.push({
          id,
          kind: 'list-item',
          spans: [],
          headingPath: block.heading,
          text: trimmed,
        });

        const snippetText = block.heading ? `## ${block.heading}\n\n${trimmed}` : trimmed;
        candidates.push({
          id,
          heading: block.heading,
          body: trimmed,
          snippetText,
          cost: Math.max(estimateTokens(snippetText), 1),
          isSupplemental: false,
          atomIds: [id],
          kind: 'list-item',
        });
        continue;
      }

      // Sentence atoms
      const sentences = splitSentencesWithOffsets(trimmed, 0);
      for (const s of sentences) {
        const id = nextId++;
        atoms.push({
          id,
          kind: 'sentence',
          spans: [s.span],
          headingPath: block.heading,
          text: s.text,
        });

        const snippetText = block.heading ? `## ${block.heading}\n\n${s.text}` : s.text;
        candidates.push({
          id,
          heading: block.heading,
          body: s.text,
          snippetText,
          cost: Math.max(estimateTokens(snippetText), 1),
          isSupplemental: false,
          atomIds: [id],
          kind: 'sentence',
        });
      }
    }
  }

  return { atoms, candidates };
}

// -----------------------------------------------------------------------------
// Arm C Reconstruction & Merging
// Merges adjacent selected sentences or items under the same heading into cohesive snippets
// -----------------------------------------------------------------------------

export function reconstructArmCHighlights(
  selectedCandidates: ResearchCandidateBlock[],
): string[] {
  if (selectedCandidates.length === 0) return [];

  // Group selected items by heading
  const byHeading = new Map<string, ResearchCandidateBlock[]>();
  for (const cand of selectedCandidates) {
    const list = byHeading.get(cand.heading) || [];
    list.push(cand);
    byHeading.set(cand.heading, list);
  }

  const highlights: string[] = [];

  for (const [heading, items] of byHeading.entries()) {
    if (heading === '補完証拠') {
      for (const item of items) {
        highlights.push(item.snippetText);
      }
      continue;
    }

    // Merge sentences or list items
    const mergedBodies: string[] = [];
    let currentSentenceBuffer: string[] = [];

    const flushSentences = () => {
      if (currentSentenceBuffer.length > 0) {
        mergedBodies.push(currentSentenceBuffer.join(' '));
        currentSentenceBuffer = [];
      }
    };

    for (const it of items) {
      if (it.kind === 'sentence') {
        currentSentenceBuffer.push(it.body);
      } else {
        flushSentences();
        mergedBodies.push(it.body);
      }
    }
    flushSentences();

    const mergedBody = mergedBodies.join('\n\n');
    const snippet = heading ? `## ${heading}\n\n${mergedBody}` : mergedBody;
    highlights.push(snippet);
  }

  return highlights;
}
