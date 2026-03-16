import type {
  PdfKnownLimitCode,
  PdfKnowledgeChunk,
  PdfKnowledgeChunkRole,
  PdfKnowledgeCitation,
  PdfKnowledgeDocument,
  PdfLayoutBlock,
  PdfLayoutDocument,
} from "./contracts.ts";

const DEFAULT_CHUNK_TARGET = 420;

export function buildKnowledgeDocument(layout: PdfLayoutDocument): PdfKnowledgeDocument {
  const chunks = buildKnowledgeChunks(layout);

  return {
    kind: "shell-knowledge",
    strategy: "layout-chunks",
    chunks,
    tables: [],
    extractedText: chunks.map((chunk) => chunk.text).join("\n\n"),
    knownLimits: dedupeKnownLimits([
      ...layout.knownLimits,
      "knowledge-chunk-heuristic",
      "table-projection-not-implemented",
    ]),
  };
}

function buildKnowledgeChunks(layout: PdfLayoutDocument): readonly PdfKnowledgeChunk[] {
  const chunks: PdfKnowledgeChunk[] = [];
  let chunkIndex = 0;
  let currentBlocks: PdfLayoutBlock[] = [];

  function flushBlocks(): void {
    if (currentBlocks.length === 0) {
      return;
    }

    chunkIndex += 1;
    chunks.push(createChunk(chunkIndex, currentBlocks));
    currentBlocks = [];
  }

  for (const page of layout.pages) {
    for (const block of page.blocks) {
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
  }

  flushBlocks();

  return chunks;
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

  return projectedLength > DEFAULT_CHUNK_TARGET;
}

function createChunk(chunkIndex: number, blocks: readonly PdfLayoutBlock[]): PdfKnowledgeChunk {
  const citations = blocks.map((block, blockIndex) => createCitation(chunkIndex, blockIndex, block));
  return {
    id: `chunk-${chunkIndex}`,
    text: blocks.map((block) => block.text).join("\n").trim(),
    role: summarizeChunkRole(blocks),
    pageNumbers: dedupeNumbers(blocks.map((block) => block.pageNumber)),
    blockIds: blocks.map((block) => block.id),
    runIds: blocks.flatMap((block) => block.runIds),
    citations,
  };
}

function createCitation(chunkIndex: number, blockIndex: number, block: PdfLayoutBlock): PdfKnowledgeCitation {
  return {
    id: `citation-${chunkIndex}-${blockIndex + 1}`,
    pageNumber: block.pageNumber,
    blockId: block.id,
    runIds: block.runIds,
    text: block.text,
    ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
  };
}

function summarizeChunkRole(blocks: readonly PdfLayoutBlock[]): PdfKnowledgeChunkRole {
  const roles = Array.from(new Set(blocks.map((block) => block.role)));
  if (roles.length !== 1) {
    return "mixed";
  }

  return roles[0] as PdfKnowledgeChunkRole;
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values));
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return Array.from(new Set(values));
}
