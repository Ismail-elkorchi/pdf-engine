import type {
  PdfKnownLimitCode,
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfLayoutPage,
  PdfObjectRef,
  PdfPoint,
  PdfObservedDocument,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfWritingMode,
} from "./contracts.ts";

interface RepeatedBoundarySets {
  readonly headers: ReadonlySet<string>;
  readonly footers: ReadonlySet<string>;
}

interface GroupedBlockSeed {
  readonly id: string;
  readonly pageNumber: number;
  readonly readingOrder: number;
  readonly text: string;
  readonly startsParagraph: boolean;
  readonly runIds: readonly string[];
  readonly glyphIds: readonly string[];
  readonly writingMode?: PdfWritingMode;
  readonly resolutionMethod: PdfObservedPage["resolutionMethod"];
  readonly pageRef?: PdfObjectRef;
  readonly anchor?: PdfPoint;
  readonly fontSize?: number;
}

export function buildObservationParagraphText(observation: PdfObservedDocument): string {
  const groupedPages = observation.pages.map((page) => groupPageIntoBlocks(page));
  return serializeLayoutPages(groupedPages);
}

export function buildLayoutDocument(observation: PdfObservedDocument): PdfLayoutDocument {
  const groupedPages = observation.pages.map((page) => groupPageIntoBlocks(page));
  const repeatedBoundarySets = buildRepeatedBoundarySets(groupedPages);
  const pages = groupedPages.map((page) => ({
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks: page.blocks.map((block, blockIndex) => classifyLayoutBlock(block, blockIndex, repeatedBoundarySets, page.blocks)),
  }));

  return {
    kind: "shell-layout",
    strategy: "line-blocks",
    pages,
    extractedText: serializeLayoutPages(pages),
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      "layout-block-heuristic",
      "layout-role-heuristic",
      "layout-reading-order-heuristic",
    ]),
  };
}

function groupPageIntoBlocks(page: PdfObservedPage): PdfLayoutPage {
  const pageWritingMode = resolvePageWritingMode(page);
  const lineBlocks: GroupedBlockSeed[] = [];
  let currentRuns: PdfObservedTextRun[] = [];

  function flushCurrentRuns(): void {
    if (currentRuns.length === 0) {
      return;
    }

    const firstRun = currentRuns[0] as PdfObservedTextRun;
    const blockIndex = lineBlocks.length + 1;
    lineBlocks.push({
      id: `block-${page.pageNumber}-${blockIndex}`,
      pageNumber: page.pageNumber,
      readingOrder: blockIndex - 1,
      text: currentRuns.map((run) => run.text).join(" ").replaceAll(/\s+/g, " ").trim(),
      startsParagraph: blockIndex === 1,
      runIds: currentRuns.map((run) => run.id),
      glyphIds: currentRuns.flatMap((run) => run.glyphIds),
      ...(pageWritingMode !== undefined ? { writingMode: pageWritingMode } : {}),
      resolutionMethod: page.resolutionMethod,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      ...(firstRun.anchor !== undefined ? { anchor: firstRun.anchor } : {}),
      ...(firstRun.fontSize !== undefined ? { fontSize: firstRun.fontSize } : {}),
    });
    currentRuns = [];
  }

  for (const run of page.runs) {
    if (currentRuns.length === 0) {
      currentRuns.push(run);
      continue;
    }

    const previousRun = currentRuns[currentRuns.length - 1] as PdfObservedTextRun;
    if (shouldStartNewBlock(previousRun, run, pageWritingMode)) {
      flushCurrentRuns();
    }
    currentRuns.push(run);
  }

  flushCurrentRuns();
  const mergedBlocks = mergeAdjacentBlocks(lineBlocks, pageWritingMode);
  const orderedBlocks = orderPageBlocks(mergedBlocks, pageWritingMode);
  const paragraphBlocks = annotateParagraphStarts(orderedBlocks, pageWritingMode);

  return {
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks: paragraphBlocks.map((block) => ({
      ...block,
      ...(pageWritingMode !== undefined ? { writingMode: pageWritingMode } : {}),
      role: "unknown" as const,
      roleConfidence: 0.4,
    })),
  };
}

function shouldStartNewBlock(
  previousRun: PdfObservedTextRun,
  currentRun: PdfObservedTextRun,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (currentRun.startsNewLine) {
    return true;
  }

  if (previousRun.anchor && currentRun.anchor) {
    const fontSize = currentRun.fontSize ?? previousRun.fontSize ?? 12;
    if (writingMode === "vertical") {
      if (Math.abs(previousRun.anchor.x - currentRun.anchor.x) > Math.max(6, fontSize * 0.6)) {
        return true;
      }
      if (currentRun.anchor.y > previousRun.anchor.y + Math.max(8, fontSize * 0.75)) {
        return true;
      }
      return false;
    }

    if (Math.abs(previousRun.anchor.y - currentRun.anchor.y) > Math.max(3, fontSize * 0.5)) {
      return true;
    }
    if (currentRun.anchor.x < previousRun.anchor.x - Math.max(6, fontSize * 0.5)) {
      return true;
    }
  }

  return false;
}

function mergeAdjacentBlocks(
  blocks: readonly GroupedBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly GroupedBlockSeed[] {
  const mergedBlocks: GroupedBlockSeed[] = [];

  for (const block of blocks) {
    const previousBlock = mergedBlocks.at(-1);
    if (!previousBlock || !shouldMergeAdjacentBlocks(previousBlock, block, writingMode)) {
      mergedBlocks.push({
        ...block,
        readingOrder: mergedBlocks.length,
      });
      continue;
    }

    mergedBlocks[mergedBlocks.length - 1] = {
      ...previousBlock,
      text: joinBlockText(previousBlock.text, block.text, writingMode),
      startsParagraph: previousBlock.startsParagraph,
      runIds: [...previousBlock.runIds, ...block.runIds],
      glyphIds: [...previousBlock.glyphIds, ...block.glyphIds],
    };
  }

  return mergedBlocks;
}

function orderPageBlocks(
  blocks: readonly GroupedBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly GroupedBlockSeed[] {
  if (writingMode !== "vertical") {
    return blocks.map((block, blockIndex) => ({ ...block, readingOrder: blockIndex }));
  }

  const anchoredBlocks = blocks.filter((block) => block.anchor !== undefined);
  const unanchoredBlocks = blocks.filter((block) => block.anchor === undefined);
  if (anchoredBlocks.length < 2) {
    return blocks.map((block, blockIndex) => ({ ...block, readingOrder: blockIndex }));
  }

  const columns: GroupedBlockSeed[][] = [];
  const sortedBlocks = [...anchoredBlocks].sort((left, right) => {
    const leftAnchor = left.anchor as PdfPoint;
    const rightAnchor = right.anchor as PdfPoint;
    if (leftAnchor.x !== rightAnchor.x) {
      return rightAnchor.x - leftAnchor.x;
    }
    return rightAnchor.y - leftAnchor.y;
  });

  for (const block of sortedBlocks) {
    const anchor = block.anchor as PdfPoint;
    const fontSize = block.fontSize ?? 12;
    const threshold = Math.max(14, fontSize * 1.4);
    const column = columns.find((candidate) => {
      const candidateAnchor = candidate[0]?.anchor;
      return candidateAnchor !== undefined && Math.abs(candidateAnchor.x - anchor.x) <= threshold;
    });
    if (column) {
      column.push(block);
      continue;
    }
    columns.push([block]);
  }

  const orderedBlocks = columns
    .map((column) => [...column].sort((left, right) => (right.anchor as PdfPoint).y - (left.anchor as PdfPoint).y))
    .flat();
  orderedBlocks.push(...unanchoredBlocks);

  return orderedBlocks.map((block, blockIndex) => ({
    ...block,
    readingOrder: blockIndex,
  }));
}

function annotateParagraphStarts(
  blocks: readonly GroupedBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly GroupedBlockSeed[] {
  return blocks.map((block, blockIndex) => ({
    ...block,
    startsParagraph: blockIndex === 0 || shouldStartParagraph(blocks[blockIndex - 1] as GroupedBlockSeed, block, writingMode),
  }));
}

function shouldMergeAdjacentBlocks(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (/^(?:[-*•]\s+|\d+[.)]\s+)/u.test(currentBlock.text)) {
    return false;
  }

  const previousFontSize = previousBlock.fontSize ?? currentBlock.fontSize ?? 12;
  const currentFontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  if (Math.abs(previousFontSize - currentFontSize) > 1) {
    return false;
  }

  if (!previousBlock.anchor || !currentBlock.anchor) {
    return previousBlock.text.length < 40 && currentBlock.text.length < 40;
  }

  if (writingMode === "vertical") {
    const verticalGap = previousBlock.anchor.y - currentBlock.anchor.y;
    const horizontalGap = Math.abs(previousBlock.anchor.x - currentBlock.anchor.x);
    if (horizontalGap > Math.max(10, previousFontSize * 0.9)) {
      return false;
    }
    if (verticalGap < -Math.max(10, previousFontSize)) {
      return false;
    }
    if (verticalGap > Math.max(28, previousFontSize * 2.6)) {
      return false;
    }
    return previousBlock.text.length < 30 || !/[.!?:]$/.test(previousBlock.text);
  }

  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const horizontalDrift = Math.abs(previousBlock.anchor.x - currentBlock.anchor.x);
  if (verticalGap > Math.max(20, previousFontSize * 2.5)) {
    return false;
  }
  if (horizontalDrift > Math.max(14, previousFontSize)) {
    return false;
  }

  return previousBlock.text.length < 60 || !/[.!?:]$/.test(previousBlock.text);
}

function shouldStartParagraph(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  writingMode: PdfWritingMode | undefined,
): boolean {
  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(currentBlock.text);
  if (previousText.length === 0 || currentText.length === 0) {
    return true;
  }

  if (/^(?:[-*•]\s+|\d+[.)]\s+)/u.test(currentText)) {
    return true;
  }

  if (looksLikeHeading(currentText, currentBlock.fontSize)) {
    return true;
  }

  if (looksLikeHeading(previousText, previousBlock.fontSize)) {
    return true;
  }

  if (endsWithHyphenatedContinuation(previousText) || startsWithContinuation(currentText)) {
    return false;
  }

  const previousFontSize = previousBlock.fontSize ?? currentBlock.fontSize ?? 12;
  const currentFontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  if (writingMode === "vertical") {
    if (!previousBlock.anchor || !currentBlock.anchor) {
      return true;
    }

    const columnShift = Math.abs(previousBlock.anchor.x - currentBlock.anchor.x);
    if (columnShift > Math.max(10, currentFontSize)) {
      return true;
    }

    const verticalGap = previousBlock.anchor.y - currentBlock.anchor.y;
    return verticalGap > Math.max(36, currentFontSize * 3.5);
  }

  const endsSentence = /[.!?]["')\]]*$/u.test(previousText);
  const startsSentence = startsLikeSentence(currentText);
  const hasShortTail = previousText.length <= 8;

  if (!previousBlock.anchor || !currentBlock.anchor) {
    return endsSentence && startsSentence;
  }

  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const indentShift = currentBlock.anchor.x - previousBlock.anchor.x;
  const outdentShift = previousBlock.anchor.x - currentBlock.anchor.x;
  if (verticalGap > Math.max(20, Math.max(previousFontSize, currentFontSize) * 1.6)) {
    return true;
  }

  if (!endsSentence || !startsSentence) {
    return false;
  }

  if (indentShift > Math.max(10, currentFontSize * 0.9)) {
    return true;
  }
  if (outdentShift > Math.max(18, currentFontSize * 1.2)) {
    return true;
  }
  if (verticalGap > Math.max(8, currentFontSize * 0.55)) {
    return true;
  }

  return hasShortTail;
}

function resolvePageWritingMode(page: PdfObservedPage): PdfWritingMode | undefined {
  if (page.runs.some((run) => run.writingMode === "vertical")) {
    return "vertical";
  }

  return undefined;
}

function joinBlockText(
  previousText: string,
  currentText: string,
  writingMode: PdfWritingMode | undefined,
): string {
  const separator = writingMode === "vertical" ? "\n" : " ";
  return `${previousText}${separator}${currentText}`.replaceAll(/[ \t]+/g, " ").trim();
}

function buildRepeatedBoundarySets(pages: readonly PdfLayoutPage[]): RepeatedBoundarySets {
  const headerCounts = new Map<string, number>();
  const footerCounts = new Map<string, number>();

  for (const page of pages) {
    const firstBlock = page.blocks[0];
    const lastBlock = page.blocks.at(-1);
    if (firstBlock) {
      const key = boundaryKey(firstBlock.text);
      if (key) {
        headerCounts.set(key, (headerCounts.get(key) ?? 0) + 1);
      }
    }
    if (lastBlock) {
      const key = boundaryKey(lastBlock.text);
      if (key) {
        footerCounts.set(key, (footerCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    headers: new Set(Array.from(headerCounts.entries()).filter(([, count]) => count > 1).map(([key]) => key)),
    footers: new Set(Array.from(footerCounts.entries()).filter(([, count]) => count > 1).map(([key]) => key)),
  };
}

function boundaryKey(text: string): string | undefined {
  const normalized = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 80) {
    return undefined;
  }
  return normalized;
}

function classifyLayoutBlock(
  block: PdfLayoutBlock,
  blockIndex: number,
  repeatedBoundarySets: RepeatedBoundarySets,
  blocks: readonly PdfLayoutBlock[],
): PdfLayoutBlock {
  const key = boundaryKey(block.text);
  if (key && repeatedBoundarySets.headers.has(key) && blockIndex === 0) {
    return {
      ...block,
      role: "header",
      roleConfidence: 0.7,
    };
  }

  if (key && repeatedBoundarySets.footers.has(key) && blockIndex === blocks.length - 1) {
    return {
      ...block,
      role: "footer",
      roleConfidence: 0.7,
    };
  }

  if (/^(?:[-*•]\s+|\d+[.)]\s+)/u.test(block.text)) {
    return {
      ...block,
      role: "list",
      roleConfidence: 0.65,
    };
  }

  if (blockIndex === 0 && looksLikeHeading(block.text, block.fontSize)) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.58,
    };
  }

  if (block.text.length >= 8) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.55,
    };
  }

  return block;
}

function looksLikeHeading(text: string, fontSize: number | undefined): boolean {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > 100) {
    return false;
  }

  if (fontSize !== undefined && fontSize >= 16) {
    return true;
  }

  if (/[.!?]$/.test(normalized)) {
    return false;
  }

  const letters = Array.from(normalized).filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) {
    return false;
  }

  const uppercaseRatio = letters.filter((character) => character === character.toUpperCase()).length / letters.length;
  return uppercaseRatio > 0.6 || normalized === normalized.toUpperCase();
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return Array.from(new Set(values));
}

function serializeLayoutPages(pages: readonly PdfLayoutPage[]): string {
  return pages
    .map((page) => serializeLayoutBlocks(page.blocks))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function serializeLayoutBlocks(blocks: readonly PdfLayoutBlock[]): string {
  let text = "";

  for (const [blockIndex, block] of blocks.entries()) {
    const separator = blockIndex === 0 ? "" : (block.startsParagraph ? "\n\n" : "\n");
    text += `${separator}${block.text}`;
  }

  return text;
}

function normalizeBlockText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function endsWithHyphenatedContinuation(text: string): boolean {
  return /[-\u2010-\u2015]$/u.test(text);
}

function startsWithContinuation(text: string): boolean {
  return /^[\p{Ll}\p{Nd}(]/u.test(text);
}

function startsLikeSentence(text: string): boolean {
  return /^[\p{Lu}\p{Lt}\p{Lo}\p{N}\[]/u.test(text);
}
