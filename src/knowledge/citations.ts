import type {
  PdfKnowledgeCitation,
  PdfKnowledgeDocument,
  PdfKnowledgeSourceSpan,
  PdfLayoutBlock,
  PdfLayoutDocument,
} from "../contracts.ts";

export function assertKnowledgeCitationsResolvable(
  layout: PdfLayoutDocument,
  knowledge: Pick<PdfKnowledgeDocument, "chunks" | "tables">,
): void {
  const blocksById = new Map(
    layout.pages.flatMap((page) => page.blocks).map((block) => [block.id, block]),
  );
  for (const citation of knowledge.chunks.flatMap((chunk) => chunk.citations)) {
    validateKnowledgeCitation(blocksById, citation);
  }

  for (const table of knowledge.tables) {
    for (const cell of table.cells) {
      for (const citation of cell.citations) {
        validateKnowledgeCitation(blocksById, citation, cell.text);
      }
    }
  }
}

export function createKnowledgeSourceSpan(
  block: PdfLayoutBlock,
  text: string,
  runIds: readonly string[],
  blockRange: { readonly start: number; readonly end: number },
): PdfKnowledgeSourceSpan {
  return {
    text,
    blockRange,
    runSpans: runIds.map((runId) => ({
      runId,
      range: blockRange,
      text,
      ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
    })),
    ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
    ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
  };
}

export function findSourceTextRange(
  sourceText: string,
  targetText: string,
): { readonly start: number; readonly end: number } | undefined {
  const directIndex = sourceText.indexOf(targetText);
  if (directIndex >= 0) {
    return { start: directIndex, end: directIndex + targetText.length };
  }

  return undefined;
}

export function citationTextPresent(sourceText: string, targetText: string): boolean {
  if (sourceText.includes(targetText)) {
    return true;
  }
  const normalizedTarget = normalizeCitationText(targetText);
  return normalizedTarget.length > 0 && normalizeCitationText(sourceText).includes(normalizedTarget);
}

export function tableCellTextContainsCitation(cellText: string, citationText: string): boolean {
  const normalizedCellText = normalizeCitationText(cellText);
  const normalizedCitationText = normalizeCitationText(citationText);
  return normalizedCitationText.length > 0 && normalizedCellText.includes(normalizedCitationText);
}

function normalizeCitationText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function validateKnowledgeCitation(
  blocksById: ReadonlyMap<string, PdfLayoutBlock>,
  citation: PdfKnowledgeCitation,
  tableCellText?: string,
): void {
  const block = blocksById.get(citation.blockId);
  if (!block) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: missing layout block ${citation.blockId}.`);
  }
  if (block.pageNumber !== citation.pageNumber) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: page ${citation.pageNumber} does not match block ${block.id}.`);
  }
  for (const runId of citation.runIds) {
    if (!block.runIds.includes(runId)) {
      throw new Error(`Unresolvable knowledge citation ${citation.id}: run ${runId} is not part of block ${block.id}.`);
    }
  }
  if (!citationTextPresent(block.text, citation.text)) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: citation text is not present in block ${block.id}.`);
  }
  if (tableCellText !== undefined && !tableCellTextContainsCitation(tableCellText, citation.text)) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: table cell citation overreaches cell text.`);
  }
  if (citation.sourceSpan !== undefined) {
    validateKnowledgeSourceSpan(block, citation);
  }
}

function validateKnowledgeSourceSpan(block: PdfLayoutBlock, citation: PdfKnowledgeCitation): void {
  const sourceSpan = citation.sourceSpan;
  if (sourceSpan === undefined) {
    return;
  }
  validateKnowledgeTextRange(citation.id, block, sourceSpan.blockRange, "source span");
  if (block.text.slice(sourceSpan.blockRange.start, sourceSpan.blockRange.end) !== sourceSpan.text) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: source span text is stale for block ${block.id}.`);
  }
  if (sourceSpan.text !== citation.text) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: source span text does not match citation text.`);
  }
  if (sourceSpan.runSpans.length === 0) {
    throw new Error(`Unresolvable knowledge citation ${citation.id}: source span has no run spans.`);
  }
  const citationRunIds = new Set(citation.runIds);
  for (const runSpan of sourceSpan.runSpans) {
    if (!citationRunIds.has(runSpan.runId)) {
      throw new Error(`Unresolvable knowledge citation ${citation.id}: source span run ${runSpan.runId} is not cited.`);
    }
    validateKnowledgeTextRange(citation.id, block, runSpan.range, `run span ${runSpan.runId}`);
    if (block.text.slice(runSpan.range.start, runSpan.range.end) !== runSpan.text) {
      throw new Error(`Unresolvable knowledge citation ${citation.id}: run span ${runSpan.runId} text is stale.`);
    }
  }
}

function validateKnowledgeTextRange(
  citationId: string,
  block: PdfLayoutBlock,
  range: { readonly start: number; readonly end: number },
  label: string,
): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error(`Unresolvable knowledge citation ${citationId}: ${label} range is not integral.`);
  }
  if (range.start < 0 || range.end < range.start || range.end > block.text.length) {
    throw new Error(`Unresolvable knowledge citation ${citationId}: ${label} range is outside block ${block.id}.`);
  }
}
