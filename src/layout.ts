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
  const structuredBlocks = splitStructuredBlocks(mergedBlocks, pageWritingMode);
  const orderedBlocks = orderPageBlocks(structuredBlocks, pageWritingMode);
  const filteredBlocks = filterPeripheralBlocks(orderedBlocks);
  const paragraphBlocks = annotateParagraphStarts(filteredBlocks, pageWritingMode);

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
  if (continuesRunOnSameLine(previousRun, currentRun, writingMode)) {
    return false;
  }

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

function continuesRunOnSameLine(
  previousRun: PdfObservedTextRun,
  currentRun: PdfObservedTextRun,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (writingMode === "vertical" || !previousRun.anchor || !currentRun.anchor) {
    return false;
  }

  const fontSize = currentRun.fontSize ?? previousRun.fontSize ?? 12;
  const baselineGap = Math.abs(previousRun.anchor.y - currentRun.anchor.y);
  const forwardAdvance = currentRun.anchor.x - previousRun.anchor.x;

  return baselineGap <= Math.max(1.5, fontSize * 0.18) && forwardAdvance > Math.max(3, fontSize * 0.35);
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
    return orderHorizontalBlocks(blocks);
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

function orderHorizontalBlocks(blocks: readonly GroupedBlockSeed[]): readonly GroupedBlockSeed[] {
  const firstReadableBlock = blocks.find((block) => block.anchor !== undefined && !looksLikeProductionMetadata(block.text));
  if (!firstReadableBlock?.anchor) {
    return blocks.map((block, blockIndex) => ({ ...block, readingOrder: blockIndex }));
  }

  const promotionThreshold = Math.max(24, (firstReadableBlock.fontSize ?? 12) * 2.2);
  const promotedBlocks = blocks.filter((block, blockIndex) =>
    blockIndex > 0 &&
    block.anchor !== undefined &&
    !looksLikeProductionMetadata(block.text) &&
    block.anchor.y > firstReadableBlock.anchor!.y + promotionThreshold &&
    (looksLikeHeading(block.text, block.fontSize) || looksLikeSectionHeading(block.text))
  );
  if (promotedBlocks.length === 0) {
    return blocks.map((block, blockIndex) => ({ ...block, readingOrder: blockIndex }));
  }

  const promotedBlockIds = new Set(promotedBlocks.map((block) => block.id));
  const orderedBlocks = [
    ...[...promotedBlocks].sort(compareHorizontalBlocks),
    ...blocks.filter((block) => !promotedBlockIds.has(block.id)),
  ];

  return orderedBlocks.map((block, blockIndex) => ({
    ...block,
    readingOrder: blockIndex,
  }));
}

function compareHorizontalBlocks(left: GroupedBlockSeed, right: GroupedBlockSeed): number {
  const leftAnchor = left.anchor;
  const rightAnchor = right.anchor;
  if (!leftAnchor || !rightAnchor) {
    return left.readingOrder - right.readingOrder;
  }

  const leftFontSize = left.fontSize ?? right.fontSize ?? 12;
  const rightFontSize = right.fontSize ?? left.fontSize ?? 12;
  const averageFontSize = (leftFontSize + rightFontSize) / 2;
  const sameLineThreshold = Math.max(6, averageFontSize * 0.8);
  if (Math.abs(leftAnchor.y - rightAnchor.y) <= sameLineThreshold) {
    return leftAnchor.x - rightAnchor.x;
  }

  return rightAnchor.y - leftAnchor.y;
}

function splitStructuredBlocks(
  blocks: readonly GroupedBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly GroupedBlockSeed[] {
  if (writingMode === "vertical") {
    return blocks;
  }

  return blocks.flatMap((block) => splitStructuredBlock(block));
}

function splitStructuredBlock(block: GroupedBlockSeed): readonly GroupedBlockSeed[] {
  const split = splitInlineHeadingAndBody(block.text);
  if (!split) {
    return [block];
  }

  const headingBlock: GroupedBlockSeed = {
    ...block,
    id: `${block.id}-heading`,
    text: split.heading,
  };
  const bodyBlock: GroupedBlockSeed = {
    ...block,
    id: `${block.id}-body`,
    text: split.body,
    startsParagraph: true,
  };

  return [headingBlock, bodyBlock];
}

function splitInlineHeadingAndBody(text: string): { readonly heading: string; readonly body: string } | undefined {
  const normalized = normalizeBlockText(text);
  if (normalized.length === 0) {
    return undefined;
  }

  const numberedPrefixMatch = normalized.match(/^\d+(?:\.\d+)*[.)]?\s+/u);
  if (!numberedPrefixMatch) {
    return undefined;
  }

  const questionIndex = normalized.indexOf("? ");
  if (questionIndex <= numberedPrefixMatch[0].length + 6) {
    return undefined;
  }

  const heading = normalized.slice(0, questionIndex + 1).trim();
  const body = normalized.slice(questionIndex + 2).trim();
  if (!startsLikeSentence(body)) {
    return undefined;
  }

  return { heading, body };
}

function filterPeripheralBlocks(blocks: readonly GroupedBlockSeed[]): readonly GroupedBlockSeed[] {
  const anchoredBlocks = blocks.filter((block) => block.anchor !== undefined);
  if (anchoredBlocks.length === 0) {
    return blocks;
  }

  const yValues = anchoredBlocks.map((block) => (block.anchor as PdfPoint).y);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const bandSize = Math.max(24, (maxY - minY) * 0.08);
  const filteredBlocks = blocks.filter((block) => {
    if (!block.anchor || !looksLikeProductionMetadata(block.text)) {
      return true;
    }

    return block.anchor.y < maxY - bandSize && block.anchor.y > minY + bandSize;
  });

  return filteredBlocks.length > 0 ? filteredBlocks : blocks;
}

function looksLikeProductionMetadata(text: string): boolean {
  const normalized = normalizeBlockText(text);
  if (normalized.length === 0) {
    return false;
  }

  const metadataSignals = [
    /\bwww\./iu,
    /\bemail\b/iu,
    /\btel\./iu,
    /\bartwork\b/iu,
    /\bsupplier\b/iu,
    /\bcomponent\b/iu,
    /\bdimension\b/iu,
    /\bbrand solutions\b/iu,
    /\brepro\b/iu,
    /\bnon printing colours\b/iu,
    /\bdiecut\b/iu,
    /\bpage:\b/iu,
    /\bdate:\b/iu,
    /\bpzn:\b/iu,
  ];
  const signalCount = metadataSignals.filter((pattern) => pattern.test(normalized)).length;
  if (signalCount >= 2) {
    return true;
  }

  const punctuationGroups = (normalized.match(/[/:|]/g) ?? []).length;
  return signalCount >= 1 && punctuationGroups >= 3;
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
  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(currentBlock.text);

  if (/^(?:[-*•]\s+|\d+[.)]\s+)/u.test(currentBlock.text)) {
    return false;
  }

  if (isSameLineBlockContinuation(previousBlock, currentBlock, writingMode)) {
    return true;
  }

  if (isHeadingContinuation(previousBlock, currentBlock, writingMode)) {
    return true;
  }

  if (writingMode !== "vertical" && endsWithHyphenatedContinuation(previousText) && startsWithContinuation(currentText)) {
    return true;
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

  if (/[.!?]["')\]]*$/u.test(previousText) && startsLikeSentence(currentText)) {
    return verticalGap <= Math.max(12, previousFontSize * 1.1);
  }

  return previousText.length < 60 || !/[.!?:]$/.test(previousText);
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

  if (looksLikeHeadingLikeText(currentText, currentBlock.fontSize)) {
    return true;
  }

  if (looksLikeHeadingLikeText(previousText, previousBlock.fontSize)) {
    return true;
  }

  if (isSameLineBlockContinuation(previousBlock, currentBlock, writingMode)) {
    return false;
  }

  if (isHeadingContinuation(previousBlock, currentBlock, writingMode)) {
    return false;
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
  if (writingMode !== "vertical" && endsWithHyphenatedContinuation(previousText) && startsWithContinuation(currentText)) {
    return `${previousText.replace(/[-\u2010-\u2015]$/u, "")}${currentText.trimStart()}`;
  }

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
    if (shouldTreatRepeatedHeaderAsHeading(block, blockIndex, blocks)) {
      return {
        ...block,
        role: "heading",
        roleConfidence: 0.66,
      };
    }

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

  if (looksLikeSectionHeading(block.text)) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.7,
    };
  }

  if (/^(?:[-*•]\s+|[a-z][.)]\s+)/u.test(block.text)) {
    return {
      ...block,
      role: "list",
      roleConfidence: 0.65,
    };
  }

  if (
    looksLikeHeading(block.text, block.fontSize) ||
    looksLikeStandaloneQuestionHeading(block.text) ||
    looksLikeFrontMatterHeading(block, blockIndex, blocks) ||
    continuesHeadingBlock(blocks, blockIndex)
  ) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.62,
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

  if (/^\d+(?:\.\d+)*\s+\p{Lu}/u.test(normalized)) {
    return true;
  }

  if (
    normalized.length >= 3 &&
    normalized.length <= 48 &&
    /\p{Lu}/u.test(normalized) &&
    /^[\p{Lu}\p{N}][\p{Lu}\p{N}\s&/'’().:-]*$/u.test(normalized)
  ) {
    return true;
  }

  if (fontSize !== undefined && fontSize >= 16) {
    return true;
  }

  if (looksLikeTitleCaseHeading(normalized)) {
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

function looksLikeHeadingLikeText(text: string, fontSize: number | undefined): boolean {
  return looksLikeHeading(text, fontSize) || looksLikeSectionHeading(text) || looksLikeStandaloneQuestionHeading(text);
}

function looksLikeSectionHeading(text: string): boolean {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > 160) {
    return false;
  }

  if (!/^\d+(?:\.\d+)*[.)]?\s+/u.test(normalized)) {
    return false;
  }

  if (/[?]$/.test(normalized)) {
    return true;
  }

  if (/^\d+(?:\.\d+)*[.)]?\s+\p{Lu}/u.test(normalized) && !/[.!?]$/.test(normalized)) {
    return true;
  }

  return false;
}

function looksLikeStandaloneQuestionHeading(text: string): boolean {
  const normalized = normalizeBlockText(text);
  if (normalized.length === 0 || normalized.length > 120 || !normalized.endsWith("?")) {
    return false;
  }

  const words = normalized.split(/\s+/u);
  const firstLetter = Array.from(normalized).find((character) => /\p{L}/u.test(character));
  return words.length <= 14 &&
    words.length >= 2 &&
    firstLetter !== undefined &&
    firstLetter === firstLetter.toUpperCase() &&
    !/[,;:]$/.test(normalized);
}

function looksLikeFrontMatterHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 120) {
    return false;
  }

  if (!isEarlyPageHeadingContext(blockIndex, blocks) && !hasHeadingNeighbor(blockIndex, blocks)) {
    return false;
  }

  if (looksLikeDateLine(normalized)) {
    return true;
  }

  if (looksLikeStandaloneQuestionHeading(normalized)) {
    return true;
  }

  if (looksLikeTitleCaseHeading(normalized)) {
    return true;
  }

  return /\b(?:abstract|acknowledg(?:e)?ments|appendix|chapter|contents|foreword|introduction|keywords?|part|preface)\b/iu.test(normalized) &&
    !/[.!]$/.test(normalized);
}

function shouldTreatRepeatedHeaderAsHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (blockIndex !== 0) {
    return false;
  }

  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 48) {
    return false;
  }

  const nextBlock = blocks[blockIndex + 1];
  return nextBlock !== undefined &&
    !looksLikeProductionMetadata(nextBlock.text) &&
    (
      looksLikeSectionHeading(normalized) ||
      looksLikeStandaloneQuestionHeading(normalized) ||
      /\b(?:abstract|acknowledg(?:e)?ments|appendix|contents|foreword|index|introduction|notes?|preface)\b/iu.test(normalized)
    );
}

function isEarlyPageHeadingContext(blockIndex: number, blocks: readonly PdfLayoutBlock[]): boolean {
  if (blockIndex <= 3) {
    return true;
  }

  const precedingBlocks = blocks.slice(0, blockIndex);
  return blockIndex <= 5 && precedingBlocks.every((block) => normalizeBlockText(block.text).length <= 120);
}

function hasHeadingNeighbor(blockIndex: number, blocks: readonly PdfLayoutBlock[]): boolean {
  const previousBlock = blockIndex > 0 ? blocks[blockIndex - 1] : undefined;
  const nextBlock = blockIndex + 1 < blocks.length ? blocks[blockIndex + 1] : undefined;

  return [previousBlock, nextBlock].some((candidate) =>
    candidate !== undefined &&
    looksLikeHeadingLikeText(candidate.text, candidate.fontSize)
  );
}

function looksLikeDateLine(text: string): boolean {
  return /^(?:\p{L}{3,12}\s+\d{1,2},\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/u.test(text);
}

function looksLikeTitleCaseHeading(text: string): boolean {
  if (text.length === 0 || text.length > 96 || /[.!]$/.test(text) || /\b(?:https?:\/\/|www\.|@)\b/iu.test(text)) {
    return false;
  }

  const words = text.split(/\s+/u);
  if (words.length === 0 || words.length > 14) {
    return false;
  }

  const lexicalWords = words.filter((word) => /\p{L}/u.test(word));
  if (lexicalWords.length === 0) {
    return false;
  }

  const titleLikeWords = lexicalWords.filter((word) => isTitleCaseWord(word) || isConnectorWord(word));
  return titleLikeWords.length / lexicalWords.length >= 0.8 && lexicalWords.some((word) => isTitleCaseWord(word));
}

function isTitleCaseWord(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  return normalized.length > 0 && /^[\p{Lu}\p{Lt}\p{N}][\p{L}\p{N}'’/-]*$/u.test(normalized);
}

function isConnectorWord(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  return /^(?:a|an|and|as|at|by|de|for|from|in|into|of|on|or|the|to|und|von|with)$/iu.test(normalized);
}

function isSameLineBlockContinuation(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (writingMode === "vertical" || !previousBlock.anchor || !currentBlock.anchor) {
    return false;
  }

  const fontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  const baselineGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const forwardAdvance = currentBlock.anchor.x - previousBlock.anchor.x;

  return baselineGap <= Math.max(1.5, fontSize * 0.18) && forwardAdvance > Math.max(6, fontSize * 0.55);
}

function isHeadingContinuation(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (writingMode === "vertical" || !previousBlock.anchor || !currentBlock.anchor) {
    return false;
  }

  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(currentBlock.text);
  const previousFontSize = previousBlock.fontSize ?? currentBlock.fontSize ?? 12;
  const currentFontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const horizontalShift = Math.abs(previousBlock.anchor.x - currentBlock.anchor.x);

  if (Math.abs(previousFontSize - currentFontSize) > 1) {
    return false;
  }

  if (verticalGap > Math.max(26, currentFontSize * 1.8)) {
    return false;
  }

  if (horizontalShift > Math.max(80, currentFontSize * 6)) {
    return false;
  }

  if (/[.!?]$/.test(previousText) || /[.!?]$/.test(currentText)) {
    return false;
  }

  if (previousText.length > 80 || currentText.length > 80) {
    return false;
  }

  return looksLikeHeading(previousText, previousBlock.fontSize) && currentText.length > 0;
}

function continuesHeadingBlock(
  blocks: readonly PdfLayoutBlock[],
  blockIndex: number,
): boolean {
  if (blockIndex === 0) {
    return false;
  }

  const previousBlock = blocks[blockIndex - 1];
  const currentBlock = blocks[blockIndex];
  if (!previousBlock || !currentBlock) {
    return false;
  }

  return isHeadingContinuation(previousBlock, currentBlock, currentBlock.writingMode) &&
    looksLikeHeading(previousBlock.text, previousBlock.fontSize);
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
