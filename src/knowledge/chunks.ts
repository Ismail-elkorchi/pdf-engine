import {
  createKnowledgeSourceSpan,
  findSourceTextRange,
} from "./citations.ts";
import { serializeKnowledgeTable } from "./markdown.ts";

import type {
  PdfKnowledgeChunk,
  PdfKnowledgeChunkRole,
  PdfKnowledgeCitation,
  PdfKnowledgeTable,
  PdfLayoutBlock,
  PdfLayoutDocument,
} from "../contracts.ts";

const DEFAULT_CHUNK_TARGET = 420;
const FIELD_LABEL_MIN_ROWS = 4;
const STABLE_ID_SLUG_MAX_LENGTH = 56;

interface InlineKnowledgeTablePlan {
  readonly table: PdfKnowledgeTable;
  readonly pageNumber: number;
  readonly startReadingOrder: number;
}

export function buildKnowledgeChunks(
  layout: PdfLayoutDocument,
  tables: readonly PdfKnowledgeTable[],
): readonly PdfKnowledgeChunk[] {
  const chunks: PdfKnowledgeChunk[] = [];
  let currentBlocks: PdfLayoutBlock[] = [];
  const tablePlans = buildInlineKnowledgeTablePlans(layout, tables);
  const pagePlans = new Map<number, readonly InlineKnowledgeTablePlan[]>(
    dedupeNumbers(tablePlans.map((plan) => plan.pageNumber)).map((pageNumber) => [
      pageNumber,
      tablePlans
        .filter((plan) => plan.pageNumber === pageNumber)
        .sort((left, right) => left.startReadingOrder - right.startReadingOrder),
    ]),
  );

  function flushBlocks(): void {
    if (currentBlocks.length === 0) {
      return;
    }

    chunks.push(createChunk(currentBlocks));
    currentBlocks = [];
  }

  for (const page of layout.pages) {
    const pendingPlans = [...(pagePlans.get(page.pageNumber) ?? [])];

    function flushTablePlansBefore(readingOrder: number): void {
      while ((pendingPlans[0]?.startReadingOrder ?? Number.POSITIVE_INFINITY) <= readingOrder) {
        const plan = pendingPlans.shift();
        if (plan === undefined) {
          return;
        }
        flushBlocks();
        chunks.push(createProjectedTableChunk(plan.table));
      }
    }

    for (const block of page.blocks) {
      flushTablePlansBefore(block.readingOrder);

      if (block.role === "header" || block.role === "footer") {
        continue;
      }

      const projectedLength = currentBlocks.reduce((sum, currentBlock) => sum + currentBlock.text.length, 0) + block.text.length;
      if (shouldStartNewChunk(currentBlocks, block, projectedLength)) {
        flushBlocks();
      }

      currentBlocks.push(block);
    }
    flushBlocks();

    for (const plan of pendingPlans) {
      chunks.push(createProjectedTableChunk(plan.table));
    }
  }

  flushBlocks();

  return chunks;
}

function buildInlineKnowledgeTablePlans(
  layout: PdfLayoutDocument,
  tables: readonly PdfKnowledgeTable[],
): readonly InlineKnowledgeTablePlan[] {
  const pagesByNumber = new Map(layout.pages.map((page) => [page.pageNumber, page]));
  const plans: InlineKnowledgeTablePlan[] = [];

  for (const table of tables) {
    if (!shouldInlineKnowledgeTableChunk(table)) {
      continue;
    }

    const page = pagesByNumber.get(table.pageNumber);
    if (!page) {
      continue;
    }

    const tableBlockIds = new Set(table.blockIds);
    const startBlock = page.blocks
      .filter((block) => tableBlockIds.has(block.id))
      .sort((left, right) => left.readingOrder - right.readingOrder)[0];
    if (!startBlock) {
      continue;
    }

    plans.push({
      table,
      pageNumber: table.pageNumber,
      startReadingOrder: startBlock.readingOrder,
    });
  }

  return plans.sort((left, right) => {
    if (left.pageNumber !== right.pageNumber) {
      return left.pageNumber - right.pageNumber;
    }
    return left.startReadingOrder - right.startReadingOrder;
  });
}

function shouldInlineKnowledgeTableChunk(table: PdfKnowledgeTable): boolean {
  if (table.heuristic === "contract-award-sequence") {
    return true;
  }

  if (table.heuristic !== "field-label-form") {
    return false;
  }

  return looksLikeInlineFieldLabelTable(table);
}

function looksLikeInlineFieldLabelTable(table: PdfKnowledgeTable): boolean {
  const bodyCells = table.cells.filter((cell) => cell.rowIndex > 0 && cell.columnIndex === 0);
  if (bodyCells.length < FIELD_LABEL_MIN_ROWS) {
    return false;
  }

  const colonEndedCount = bodyCells.filter((cell) => normalizeCellText(cell.text).endsWith(":")).length;
  const compactLabelCount = bodyCells.filter((cell) => looksLikeInlineFieldLabelCell(cell.text)).length;
  return colonEndedCount / bodyCells.length >= 0.5 || compactLabelCount / bodyCells.length >= 0.75;
}

function looksLikeInlineFieldLabelCell(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 40) {
    return false;
  }

  if (/[.!?]$/.test(normalizedText)) {
    return false;
  }

  const words = normalizedText.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length >= 1 && words.length <= 4;
}

function shouldStartNewChunk(
  currentBlocks: readonly PdfLayoutBlock[],
  incomingBlock: PdfLayoutBlock,
  projectedLength: number,
): boolean {
  if (currentBlocks.length === 0) {
    return false;
  }

  if (incomingBlock.role === "heading") {
    return true;
  }
  if (currentBlocks.some((block) => block.role === "heading")) {
    return true;
  }

  return projectedLength > DEFAULT_CHUNK_TARGET;
}

function createChunk(blocks: readonly PdfLayoutBlock[]): PdfKnowledgeChunk {
  const text = serializeChunkBlocks(blocks);
  const id = createStableId(
    "chunk",
    ["layout", ...blocks.map(createBlockFingerprint), text],
    [blocks[0]?.role ?? "layout", blocks[0]?.pageNumber ?? 0, blocks[0]?.text ?? text],
  );
  const citations = blocks.map((block) => createCitation(id, block));
  return {
    id,
    text,
    role: summarizeChunkRole(blocks),
    pageNumbers: dedupeNumbers(blocks.map((block) => block.pageNumber)),
    blockIds: blocks.map((block) => block.id),
    runIds: blocks.flatMap((block) => block.runIds),
    citations,
  };
}

function createProjectedTableChunk(table: PdfKnowledgeTable): PdfKnowledgeChunk {
  const sourceCitations = dedupeKnowledgeCitations(table.cells.flatMap((cell) => cell.citations));
  const text = serializeKnowledgeTable(table);
  const id = createStableId(
    "chunk",
    ["projected-table", table.id, text],
    ["table", table.pageNumber, table.headers?.join(" ") ?? table.heuristic ?? table.id],
  );
  return {
    id,
    text,
    role: "mixed",
    pageNumbers:
      sourceCitations.length === 0
        ? [table.pageNumber]
        : dedupeNumbers(sourceCitations.map((citation) => citation.pageNumber)),
    blockIds: dedupeStrings(table.blockIds),
    runIds: dedupeStrings(sourceCitations.flatMap((citation) => citation.runIds)),
    citations: sourceCitations.map((citation) => ({
      ...citation,
      id: createStableId(
        "citation",
        ["projected-table-chunk", id, citation.id, citation.pageNumber, citation.blockId, citation.runIds.join(","), citation.text],
        ["table", citation.pageNumber, citation.blockId, citation.text],
      ),
    })),
  };
}

function createCitation(ownerId: string, block: PdfLayoutBlock): PdfKnowledgeCitation {
  const textRange = findSourceTextRange(block.text, block.text);
  return {
    id: createStableId(
      "citation",
      ["chunk", ownerId, createBlockFingerprint(block)],
      [block.pageNumber, block.id, block.text],
    ),
    pageNumber: block.pageNumber,
    blockId: block.id,
    runIds: block.runIds,
    text: block.text,
    ...(textRange === undefined ? {} : { sourceSpan: createKnowledgeSourceSpan(block, block.text, block.runIds, textRange) }),
    ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
  };
}

function dedupeKnowledgeCitations(citations: readonly PdfKnowledgeCitation[]): readonly PdfKnowledgeCitation[] {
  const deduped: PdfKnowledgeCitation[] = [];
  const seenKeys = new Set<string>();

  for (const citation of citations) {
    const key = `${citation.pageNumber}:${citation.blockId}:${citation.runIds.join(",")}:${citation.text}`;
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    deduped.push(citation);
  }

  return deduped;
}

function summarizeChunkRole(blocks: readonly PdfLayoutBlock[]): PdfKnowledgeChunkRole {
  const roles = Array.from(new Set(blocks.map((block) => block.role)));
  if (roles.length !== 1) {
    return "mixed";
  }

  return roles[0] as PdfKnowledgeChunkRole;
}

function createStableId(
  prefix: string,
  fingerprintParts: readonly unknown[],
  labelParts: readonly unknown[] = fingerprintParts,
): string {
  const fingerprint = fingerprintParts.map(canonicalizeStableIdPart).join("\u001f");
  const label = labelParts
    .map(canonicalizeStableIdPart)
    .map(slugifyStableIdPart)
    .filter((part) => part.length > 0)
    .join("-");
  const slug = truncateStableIdPart(label.length === 0 ? "source" : label, STABLE_ID_SLUG_MAX_LENGTH);
  return `${prefix}-${slug}-${hashStableIdFingerprint(fingerprint)}`;
}

function createBlockFingerprint(block: PdfLayoutBlock): string {
  return [
    block.pageNumber,
    block.pageRef === undefined ? "" : `${block.pageRef.objectNumber}:${block.pageRef.generationNumber}`,
    block.id,
    block.role,
    block.runIds.join(","),
    normalizeStableText(block.text),
    block.anchor === undefined ? "" : `${formatStableNumber(block.anchor.x)},${formatStableNumber(block.anchor.y)}`,
    block.bbox === undefined
      ? ""
      : [
          formatStableNumber(block.bbox.x),
          formatStableNumber(block.bbox.y),
          formatStableNumber(block.bbox.width),
          formatStableNumber(block.bbox.height),
        ].join(","),
  ].join("\u001e");
}

function canonicalizeStableIdPart(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return formatStableNumber(value);
  }
  if (typeof value === "string") {
    return normalizeStableText(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeStableIdPart).join("\u001d");
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return normalizeStableText(JSON.stringify(value) ?? "");
}

function normalizeStableText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function formatStableNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function slugifyStableIdPart(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

function truncateStableIdPart(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).replaceAll(/-+$/gu, "");
}

function hashStableIdFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, "0");
}

function normalizeCellText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values));
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function serializeChunkBlocks(blocks: readonly PdfLayoutBlock[]): string {
  let text = "";

  for (const [blockIndex, block] of blocks.entries()) {
    const normalizedBlockText = block.text.replaceAll(/\s+/g, " ").trim();
    if (normalizedBlockText.length === 0) {
      continue;
    }
    const separator = blockIndex === 0 ? "" : (block.startsParagraph ? "\n\n" : " ");
    text += `${separator}${normalizedBlockText}`;
  }

  return text.trim();
}
