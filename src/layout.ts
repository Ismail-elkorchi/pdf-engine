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
    if (shouldStartNewBlock(previousRun, run)) {
      flushCurrentRuns();
    }
    currentRuns.push(run);
  }

  flushCurrentRuns();
  const mergedBlocks = mergeAdjacentBlocks(lineBlocks);
  const paragraphBlocks = annotateParagraphStarts(mergedBlocks);

  return {
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks: paragraphBlocks.map((block) => ({
      ...block,
      role: "unknown" as const,
      roleConfidence: 0.4,
    })),
  };
}

function shouldStartNewBlock(previousRun: PdfObservedTextRun, currentRun: PdfObservedTextRun): boolean {
  if (currentRun.startsNewLine) {
    return true;
  }

  if (previousRun.anchor && currentRun.anchor) {
    const fontSize = currentRun.fontSize ?? previousRun.fontSize ?? 12;
    if (Math.abs(previousRun.anchor.y - currentRun.anchor.y) > Math.max(3, fontSize * 0.5)) {
      return true;
    }
    if (currentRun.anchor.x < previousRun.anchor.x - Math.max(6, fontSize * 0.5)) {
      return true;
    }
  }

  return false;
}

function mergeAdjacentBlocks(blocks: readonly GroupedBlockSeed[]): readonly GroupedBlockSeed[] {
  const mergedBlocks: GroupedBlockSeed[] = [];

  for (const block of blocks) {
    const previousBlock = mergedBlocks.at(-1);
    if (!previousBlock || !shouldMergeAdjacentBlocks(previousBlock, block)) {
      mergedBlocks.push({
        ...block,
        readingOrder: mergedBlocks.length,
      });
      continue;
    }

    mergedBlocks[mergedBlocks.length - 1] = {
      ...previousBlock,
      text: `${previousBlock.text} ${block.text}`.replaceAll(/\s+/g, " ").trim(),
      startsParagraph: previousBlock.startsParagraph,
      runIds: [...previousBlock.runIds, ...block.runIds],
      glyphIds: [...previousBlock.glyphIds, ...block.glyphIds],
    };
  }

  return mergedBlocks;
}

function annotateParagraphStarts(blocks: readonly GroupedBlockSeed[]): readonly GroupedBlockSeed[] {
  return blocks.map((block, blockIndex) => ({
    ...block,
    startsParagraph: blockIndex === 0 || shouldStartParagraph(blocks[blockIndex - 1] as GroupedBlockSeed, block),
  }));
}

function shouldMergeAdjacentBlocks(previousBlock: GroupedBlockSeed, currentBlock: GroupedBlockSeed): boolean {
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

function shouldStartParagraph(previousBlock: GroupedBlockSeed, currentBlock: GroupedBlockSeed): boolean {
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
