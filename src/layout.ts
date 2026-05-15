import type {
  PdfBoundingBox,
  PdfKnownLimitCode,
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfLayoutInferenceRecord,
  PdfLayoutRegion,
  PdfLayoutRole,
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
  readonly bbox?: PdfBoundingBox;
  readonly fontSize?: number;
  readonly inferences?: readonly PdfLayoutInferenceRecord[];
  readonly hasGeneratorPathTrace?: boolean;
}

interface GroupedLayoutBlock extends PdfLayoutBlock {
  readonly hasGeneratorPathTrace?: boolean;
}

interface GroupedLayoutPage {
  readonly pageNumber: number;
  readonly resolutionMethod: PdfObservedPage["resolutionMethod"];
  readonly pageRef?: PdfObjectRef;
  readonly blocks: readonly GroupedLayoutBlock[];
}

const FORM_OPTION_TEXTS = new Set(["female", "male", "non-binary", "verified"]);

export function buildObservationParagraphText(observation: PdfObservedDocument): string {
  const groupedPages = observation.pages.map((page) => groupPageIntoBlocks(page));
  return serializeObservationPages(groupedPages);
}

export function buildLayoutDocument(observation: PdfObservedDocument): PdfLayoutDocument {
  const groupedPages = observation.pages.map((page) => groupPageIntoBlocks(page));
  const publicGroupedPages = groupedPages.map((page) => ({
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks: page.blocks.map((block) => toPublicLayoutBlock(block)),
  }));
  const repeatedBoundarySets = buildRepeatedBoundarySets(publicGroupedPages);
  const pages = publicGroupedPages.map((page) => {
    const blocks = page.blocks.map((block, blockIndex) => classifyLayoutBlock(block, blockIndex, repeatedBoundarySets, page.blocks));
    return {
      pageNumber: page.pageNumber,
      resolutionMethod: page.resolutionMethod,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      blocks,
      regions: inferLayoutRegions(page.pageNumber, blocks),
    };
  });

  return {
    kind: "pdf-layout",
    strategy: "line-blocks",
    pages,
    extractedText: serializeLayoutPages(pages),
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      "layout-block-heuristic",
      "layout-role-heuristic",
      "layout-reading-order-heuristic",
      "layout-region-heuristic",
    ]),
  };
}

function toPublicLayoutBlock(block: GroupedLayoutBlock): PdfLayoutBlock {
  const { hasGeneratorPathTrace, ...publicBlock } = block;
  void hasGeneratorPathTrace;
  return publicBlock;
}

function mergeRunBoundingBoxes(runs: readonly PdfObservedTextRun[]): PdfBoundingBox | undefined {
  const boxes = runs.map((run) => run.bbox).filter((bbox): bbox is PdfBoundingBox => bbox !== undefined);
  if (boxes.length === 0) {
    return undefined;
  }

  const left = Math.min(...boxes.map((bbox) => bbox.x));
  const top = Math.min(...boxes.map((bbox) => bbox.y));
  const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
  const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function groupPageIntoBlocks(page: PdfObservedPage): GroupedLayoutPage {
  const pageWritingMode = resolvePageWritingMode(page);
  const hasGeneratorPathTrace = page.runs.some((run) => looksLikeGeneratorPathTraceText(normalizeBlockText(run.text)));
  const lineBlocks: GroupedBlockSeed[] = [];
  let currentRuns: PdfObservedTextRun[] = [];

  function flushCurrentRuns(): void {
    if (currentRuns.length === 0) {
      return;
    }

    const firstRun = currentRuns[0] as PdfObservedTextRun;
    const blockIndex = lineBlocks.length + 1;
    const bbox = mergeRunBoundingBoxes(currentRuns);
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
      ...(bbox !== undefined ? { bbox } : {}),
      ...(firstRun.fontSize !== undefined ? { fontSize: firstRun.fontSize } : {}),
      ...(hasGeneratorPathTrace ? { hasGeneratorPathTrace: true } : {}),
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
  if (hasLargeInlineGap(previousRun.anchor, currentRun.anchor, previousRun.bbox, fontSize)) {
    return false;
  }

  return baselineGap <= Math.max(1.5, fontSize * 0.18) && forwardAdvance > Math.max(3, fontSize * 0.35);
}

function hasLargeInlineGap(
  previousAnchor: PdfPoint,
  currentAnchor: PdfPoint,
  previousBox: PdfBoundingBox | undefined,
  fontSize: number,
): boolean {
  if (!previousBox) {
    return false;
  }

  const inlineGap = currentAnchor.x - (previousBox.x + previousBox.width);
  return inlineGap > Math.max(48, fontSize * 4);
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
      text: joinBlockText(previousBlock, block, writingMode),
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
  const columnOrderedBlocks = orderHorizontalColumnsWhenSupported(blocks);
  if (columnOrderedBlocks) {
    return assignReadingOrderInference(
      columnOrderedBlocks,
      "geometry-column-order",
      0.72,
      "Anchored text formed separated column groups with overlapping vertical ranges.",
      "inferred",
    );
  }

  const firstReadableBlock = blocks.find((block) => block.anchor !== undefined && !looksLikeProductionMetadata(block.text));
  if (!firstReadableBlock?.anchor) {
    return assignReadingOrderInference(
      blocks,
      "observed-content-order",
      0.28,
      "No stable text anchors were available, so observed content order was preserved.",
      "abstained",
    );
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
    return assignReadingOrderInference(
      blocks,
      "geometry-line-order",
      0.55,
      "Anchored text did not form separated column groups; observed line order was preserved.",
      "inferred",
    );
  }

  const promotedBlockIds = new Set(promotedBlocks.map((block) => block.id));
  const orderedBlocks = [
    ...[...promotedBlocks].sort(compareHorizontalBlocks),
    ...blocks.filter((block) => !promotedBlockIds.has(block.id)),
  ];

  return assignReadingOrderInference(
    orderedBlocks,
    "geometry-line-order",
    0.62,
    "A later anchored heading was promoted ahead of body text using page-space anchors.",
    "inferred",
  );
}

function orderHorizontalColumnsWhenSupported(
  blocks: readonly GroupedBlockSeed[],
): readonly GroupedBlockSeed[] | undefined {
  const anchoredBlocks = blocks.filter((block) => block.anchor !== undefined && !looksLikeProductionMetadata(block.text));
  if (anchoredBlocks.length < 4) {
    return undefined;
  }

  const fontSizes = anchoredBlocks.map((block) => block.fontSize ?? 12).sort((left, right) => left - right);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] ?? 12;
  const columnThreshold = Math.max(64, medianFontSize * 5.5);
  const xGapThreshold = Math.max(120, medianFontSize * 8);
  const clusters: GroupedBlockSeed[][] = [];

  for (const block of [...anchoredBlocks].sort(compareBlockAnchorX)) {
    const anchor = block.anchor as PdfPoint;
    const nearestCluster = clusters.find((cluster) => {
      const centerX = averageAnchorX(cluster);
      return Math.abs(centerX - anchor.x) <= columnThreshold;
    });
    if (nearestCluster) {
      nearestCluster.push(block);
      continue;
    }
    clusters.push([block]);
  }

  const columnClusters = clusters
    .filter((cluster) => cluster.length >= 2)
    .sort((left, right) => averageAnchorX(left) - averageAnchorX(right));
  if (columnClusters.length < 2) {
    return undefined;
  }

  for (let clusterIndex = 1; clusterIndex < columnClusters.length; clusterIndex += 1) {
    const previousCluster = columnClusters[clusterIndex - 1] as readonly GroupedBlockSeed[];
    const currentCluster = columnClusters[clusterIndex] as readonly GroupedBlockSeed[];
    if (averageAnchorX(currentCluster) - averageAnchorX(previousCluster) < xGapThreshold) {
      return undefined;
    }
  }

  if (!columnClustersHaveVerticalOverlap(columnClusters, medianFontSize)) {
    return undefined;
  }

  const columnBlockIds = new Set(columnClusters.flat().map((block) => block.id));
  const bodyAnchors = columnClusters.flat().map((block) => block.anchor as PdfPoint);
  const maxColumnY = Math.max(...bodyAnchors.map((anchor) => anchor.y));
  const minColumnY = Math.min(...bodyAnchors.map((anchor) => anchor.y));
  const boundaryBand = Math.max(18, medianFontSize * 1.5);
  const prefixBlocks: GroupedBlockSeed[] = [];
  const suffixBlocks: GroupedBlockSeed[] = [];
  const ambiguousBlocks: GroupedBlockSeed[] = [];

  for (const block of blocks) {
    if (columnBlockIds.has(block.id)) {
      continue;
    }

    if (!block.anchor) {
      suffixBlocks.push(block);
      continue;
    }

    if (block.anchor.y > maxColumnY + boundaryBand) {
      prefixBlocks.push(block);
      continue;
    }

    if (block.anchor.y < minColumnY - boundaryBand) {
      suffixBlocks.push(block);
      continue;
    }

    ambiguousBlocks.push(block);
  }

  if (ambiguousBlocks.length > 0) {
    return undefined;
  }

  return [
    ...prefixBlocks.sort(compareHorizontalBlocks),
    ...columnClusters.flatMap((cluster) => [...cluster].sort(compareHorizontalBlocks)),
    ...suffixBlocks.sort(compareHorizontalBlocks),
  ];
}

function compareBlockAnchorX(left: GroupedBlockSeed, right: GroupedBlockSeed): number {
  const leftAnchor = left.anchor as PdfPoint;
  const rightAnchor = right.anchor as PdfPoint;
  return leftAnchor.x - rightAnchor.x;
}

function averageAnchorX(blocks: readonly GroupedBlockSeed[]): number {
  return blocks.reduce((sum, block) => sum + (block.anchor?.x ?? 0), 0) / blocks.length;
}

function columnClustersHaveVerticalOverlap(
  clusters: readonly (readonly GroupedBlockSeed[])[],
  medianFontSize: number,
): boolean {
  const ranges = clusters.map((cluster) => {
    const yValues = cluster.map((block) => (block.anchor as PdfPoint).y);
    return {
      min: Math.min(...yValues),
      max: Math.max(...yValues),
    };
  });
  const sharedMin = Math.max(...ranges.map((range) => range.min));
  const sharedMax = Math.min(...ranges.map((range) => range.max));
  return sharedMax - sharedMin >= Math.max(8, medianFontSize * 0.5);
}

function assignReadingOrderInference(
  blocks: readonly GroupedBlockSeed[],
  method: string,
  confidence: number,
  reason: string,
  status: PdfLayoutInferenceRecord["status"],
): readonly GroupedBlockSeed[] {
  return blocks.map((block, blockIndex) => {
    const blockStatus = block.anchor ? status : "abstained";
    const blockReason = block.anchor
      ? reason
      : "No recovered text anchor was available for this block; observed content order was preserved.";
    return {
      ...block,
      readingOrder: blockIndex,
      inferences: [
        ...(block.inferences ?? []),
        {
          kind: "reading-order",
          status: blockStatus,
          method: block.anchor ? method : "observed-content-order",
          confidence: block.anchor ? confidence : 0.25,
          reason: blockReason,
          evidenceRunIds: block.runIds,
          evidenceBlockIds: [block.id],
        },
      ],
    };
  });
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

  const hasGeneratorPathTrace = blocks.some((block) => looksLikeGeneratorPathTraceText(normalizeBlockText(block.text)));
  return blocks.flatMap((block) => splitStructuredBlock(block, hasGeneratorPathTrace));
}

function splitStructuredBlock(
  block: GroupedBlockSeed,
  hasGeneratorPathTrace: boolean,
): readonly GroupedBlockSeed[] {
  const generatorNoiseSplit = hasGeneratorPathTrace ? splitLeadingGeneratorStatusAndBody(block.text) : undefined;
  if (generatorNoiseSplit) {
    const noiseBlock: GroupedBlockSeed = {
      ...block,
      id: `${block.id}-noise`,
      text: generatorNoiseSplit.noise,
    };
    const bodyBlock: GroupedBlockSeed = {
      ...block,
      id: `${block.id}-body`,
      text: generatorNoiseSplit.body,
      startsParagraph: true,
    };

    return [noiseBlock, bodyBlock];
  }

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

function splitLeadingGeneratorStatusAndBody(
  text: string,
): { readonly noise: string; readonly body: string } | undefined {
  const lines = text
    .split(/\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return undefined;
  }

  const [firstLine, ...remainingLines] = lines;
  if (!firstLine || !looksLikeStandaloneGeneratorStatusText(firstLine)) {
    return undefined;
  }

  const body = remainingLines.join("\n").trim();
  if (
    body.length === 0 ||
    (!looksLikeFieldLikeClusterText(normalizeBlockText(body), undefined) &&
      !/\b(?:gender|female|male|non-binary)\b/iu.test(body))
  ) {
    return undefined;
  }

  return {
    noise: firstLine,
    body,
  };
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
  const hasContentsContext = blocks.some((block, blockIndex) =>
    blockIndex <= 5 && /\bcontents\b/iu.test(normalizeBlockText(block.text))
  );
  const filteredBlocks = blocks.filter((block, blockIndex) => {
    if (shouldFilterInlineNoiseBlock(block, blockIndex, blocks, hasContentsContext)) {
      return false;
    }

    if (
      looksLikeGeneratorPathTraceText(normalizeBlockText(block.text)) ||
      looksLikeStandaloneGeneratorStatusText(normalizeBlockText(block.text))
    ) {
      return false;
    }

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
    /\bpr\.\s*name\b/iu,
    /\bprinting number\b/iu,
  ];
  const signalCount = metadataSignals.filter((pattern) => pattern.test(normalized)).length;
  if (signalCount >= 2) {
    return true;
  }

  const punctuationGroups = (normalized.match(/[/:|]/g) ?? []).length;
  if (signalCount >= 1 && punctuationGroups >= 3) {
    return true;
  }

  return looksLikeRevisionStamp(normalized);
}

function looksLikeBuildTraceText(text: string): boolean {
  return /\bpdfcpu\b/iu.test(text) ||
    /\bcreated:\b/iu.test(text) ||
    /\boptimized\s+for\b/iu.test(text) ||
    /(?:^|[\s(])(?:testdata|samples?|examples?)\/[^\s)]+/iu.test(text);
}

function looksLikeGeneratorPathTraceText(text: string): boolean {
  return /(?:^|[\s(])(?:testdata|samples?|examples?)\/[^\s)]+/iu.test(text);
}

function looksLikeStandaloneGeneratorStatusText(text: string): boolean {
  const normalized = normalizeBlockText(text).toLowerCase();
  return normalized === "verified" || normalized === "unchecked" || normalized === "selected";
}

function shouldFilterInlineNoiseBlock(
  block: GroupedBlockSeed,
  blockIndex: number,
  blocks: readonly GroupedBlockSeed[],
  hasContentsContext: boolean,
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0) {
    return true;
  }

  if (looksLikeStandaloneBulletText(normalized)) {
    return true;
  }

  return hasContentsContext && looksLikeContentsNoiseBlock(normalized, blockIndex, blocks);
}

function looksLikeStandaloneBulletText(text: string): boolean {
  return /^(?:[-*•]|â\s*¢)$/u.test(text);
}

function looksLikeRevisionStamp(text: string): boolean {
  return /\b\d{2,}-\d{2,}(?:-\d{2,})+\b/u.test(text) &&
    /\brev\.[\p{L}\p{N}]+\b/iu.test(text);
}

function looksLikeContentsNoiseBlock(
  text: string,
  blockIndex: number,
  blocks: readonly GroupedBlockSeed[],
): boolean {
  if (looksLikeDotLeaderNoise(text)) {
    return true;
  }

  if (!looksLikeStandalonePageReference(text)) {
    return false;
  }

  if (blockIndex <= 0) {
    return false;
  }

  return blocks
    .slice(Math.max(0, blockIndex - 2), blockIndex)
    .some((candidate) => looksLikeContentsEntryLabel(normalizeBlockText(candidate.text)));
}

function looksLikeDotLeaderNoise(text: string): boolean {
  return /^[.\s\u2024\u2027\u2219]{4,}$/u.test(text);
}

function looksLikeStandalonePageReference(text: string): boolean {
  return /^(?:\d{1,4}|[ivxlcdm]{1,8})$/iu.test(text);
}

function looksLikeContentsEntryLabel(text: string): boolean {
  if (text.length === 0 || text.length > 80 || /[.!?]$/.test(text) || countLabelMarkers(text) > 0) {
    return false;
  }

  const words = text.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length > 0 && words.length <= 8 && looksLikeTitleCaseHeading(text);
}

function annotateParagraphStarts(
  blocks: readonly GroupedBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly GroupedBlockSeed[] {
  return blocks.map((block, blockIndex) => {
    const startsParagraph = blockIndex === 0 || shouldStartParagraph(blocks, blockIndex, writingMode);
    const previousBlock = blocks[blockIndex - 1];
    const geometryAvailable = block.anchor !== undefined && (blockIndex === 0 || previousBlock?.anchor !== undefined);
    return {
      ...block,
      startsParagraph,
      inferences: [
        ...(block.inferences ?? []),
        {
          kind: "paragraph-flow",
          status: geometryAvailable ? "inferred" : "abstained",
          method: geometryAvailable ? "paragraph-geometry" : "observed-content-order",
          confidence: geometryAvailable ? (startsParagraph ? 0.6 : 0.66) : 0.28,
          reason: paragraphInferenceReason(startsParagraph, geometryAvailable, blockIndex),
          evidenceRunIds: block.runIds,
          evidenceBlockIds: previousBlock ? [previousBlock.id, block.id] : [block.id],
        },
      ],
    };
  });
}

function paragraphInferenceReason(
  startsParagraph: boolean,
  geometryAvailable: boolean,
  blockIndex: number,
): string {
  if (!geometryAvailable) {
    return "Paragraph flow could not rely on anchors for this boundary, so the observed content order was preserved.";
  }

  if (blockIndex === 0) {
    return "First block on the page starts a paragraph by construction.";
  }

  return startsParagraph
    ? "Text geometry and boundary cues indicate a new paragraph."
    : "Text geometry and continuation cues keep this block in the previous paragraph.";
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

  if (
    looksLikeStandaloneBulletText(previousText) ||
    looksLikeStandaloneBulletText(currentText)
  ) {
    return false;
  }

  if (
    looksLikeBuildTraceText(currentText) &&
    (looksLikePaginationLine(previousText) || looksLikeHeadingLikeText(previousText, previousBlock.fontSize))
  ) {
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
  blocks: readonly GroupedBlockSeed[],
  blockIndex: number,
  writingMode: PdfWritingMode | undefined,
): boolean {
  const previousBlock = blocks[blockIndex - 1] as GroupedBlockSeed;
  const currentBlock = blocks[blockIndex] as GroupedBlockSeed;
  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(currentBlock.text);
  if (previousText.length === 0 || currentText.length === 0) {
    return true;
  }

  if (/^(?:[-*•]\s+|\d+[.)]\s+)/u.test(currentText)) {
    return true;
  }

  if (
    looksLikeBuildTraceText(currentText) &&
    (looksLikePaginationLine(previousText) || looksLikeHeadingLikeText(previousText, previousBlock.fontSize))
  ) {
    return true;
  }

  if (looksLikeFieldChoiceParagraphStart(currentText)) {
    return true;
  }

  if (shouldKeepHeadingLeadInParagraph(previousBlock, currentBlock, previousText, currentText, writingMode)) {
    return false;
  }

  if (shouldKeepParagraphContinuation(previousBlock, currentBlock, previousText, currentText, writingMode)) {
    return false;
  }

  if (shouldKeepCompactBlocksInParagraph(previousBlock, currentBlock, previousText, currentText)) {
    return false;
  }

  if (
    looksLikeCompactLabelCluster(previousText, previousBlock.fontSize) ||
    looksLikeCompactLabelCluster(currentText, currentBlock.fontSize)
  ) {
    return true;
  }

  if (looksLikeExplicitParagraphBoundaryText(currentText, currentBlock.fontSize)) {
    return true;
  }

  if (looksLikeExplicitParagraphBoundaryText(previousText, previousBlock.fontSize)) {
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

    if (
      isSingleWordBlockText(previousText) &&
      isSingleWordBlockText(currentText) &&
      !previousText.includes(":") &&
      !currentText.includes(":")
    ) {
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

function shouldKeepHeadingLeadInParagraph(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  previousText: string,
  currentText: string,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (writingMode === "vertical" || !previousBlock.anchor || !currentBlock.anchor) {
    return false;
  }

  if (
    currentText.length < 24 ||
    !startsLikeSentence(currentText) ||
    looksLikeExplicitParagraphBoundaryText(currentText, currentBlock.fontSize) ||
    looksLikeExplicitParagraphBoundaryText(previousText, previousBlock.fontSize) ||
    /^(?:[-*•]\s+|\d+[.)]\s+)/u.test(currentText)
  ) {
    return false;
  }

  if (/guide$/iu.test(previousText) && /^this guide\b/iu.test(currentText)) {
    return true;
  }

  const looksLikeLeadHeading =
    looksLikeHeadingLikeText(previousText, previousBlock.fontSize) &&
    /\b(?:guide|summary|overview|background|introduction)\b/iu.test(previousText) &&
    previousText.length >= 6 &&
    previousText.length <= 40 &&
    !looksLikeSectionHeading(previousText) &&
    !looksLikeStandaloneQuestionHeading(previousText) &&
    !looksLikeNumberedQuestionHeading(previousText);
  if (!looksLikeLeadHeading) {
    return false;
  }

  const fontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const indentShift = Math.abs(currentBlock.anchor.x - previousBlock.anchor.x);
  return verticalGap <= Math.max(18, fontSize * 1.4) && indentShift <= Math.max(120, fontSize * 1.2);
}

function shouldKeepParagraphContinuation(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  previousText: string,
  currentText: string,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (writingMode === "vertical" || !previousBlock.anchor || !currentBlock.anchor) {
    return false;
  }

  if (previousText.length < 24 || currentText.length === 0) {
    return false;
  }

  if (/[.!?]["')\]]*$/u.test(previousText)) {
    return false;
  }

  if (looksLikeExplicitParagraphBoundaryText(currentText, currentBlock.fontSize)) {
    return false;
  }

  if (looksLikeExplicitParagraphBoundaryText(previousText, previousBlock.fontSize) && !looksLikeNumberedBodyParagraph(previousText)) {
    return false;
  }

  if (looksLikeHeadingLikeText(previousText, previousBlock.fontSize) && !looksLikeNumberedBodyParagraph(previousText)) {
    return false;
  }

  if (/^(?:[-*•]\s+|[a-z][.)]\s+)/u.test(currentText)) {
    return false;
  }

  if (/^\d+[.)]\s+/u.test(currentText) && !looksLikeNumberedBodyParagraph(currentText)) {
    return false;
  }

  if (countTextLines(previousBlock.text) > 4 || countTextLines(currentBlock.text) > 4) {
    return false;
  }

  const fontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const indentShift = currentBlock.anchor.x - previousBlock.anchor.x;
  if (indentShift < -Math.max(10, fontSize * 0.9)) {
    return false;
  }

  if (looksLikeNumberedBodyParagraph(previousText)) {
    return verticalGap <= Math.max(48, fontSize * 4) &&
      (startsWithContinuation(currentText) || startsLikeSentence(currentText));
  }

  return verticalGap <= Math.max(18, fontSize * 1.5) &&
    (startsWithContinuation(currentText) || startsLikeSentence(currentText));
}

function looksLikeFieldChoiceParagraphStart(text: string): boolean {
  const normalized = normalizeBlockText(text);
  return /\bgender:/iu.test(normalized) && /\b(?:female|male|non-binary)\b/iu.test(normalized);
}

function shouldKeepCompactBlocksInParagraph(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  previousText: string,
  currentText: string,
): boolean {
  if (!previousBlock.anchor || !currentBlock.anchor) {
    return false;
  }

  const fontSize = currentBlock.fontSize ?? previousBlock.fontSize ?? 12;
  const verticalGap = Math.abs(previousBlock.anchor.y - currentBlock.anchor.y);
  const horizontalShift = Math.abs(previousBlock.anchor.x - currentBlock.anchor.x);
  const previousLineCount = countTextLines(previousBlock.text);
  const currentLineCount = countTextLines(currentBlock.text);

  if (
    looksLikeFieldLikeClusterText(previousText, previousBlock.fontSize) &&
    looksLikeFieldLikeClusterText(currentText, currentBlock.fontSize) &&
    Math.abs((previousBlock.fontSize ?? fontSize) - (currentBlock.fontSize ?? fontSize)) <= 2 &&
    horizontalShift <= Math.max(22, fontSize * 1.8) &&
    verticalGap <= Math.max(48, fontSize * 4.2) &&
    !/[.!?]$/.test(previousText) &&
    !/[.!?]$/.test(currentText) &&
    !(countLabelMarkers(previousText) <= 2 && countLabelMarkers(currentText) >= 3)
  ) {
    return true;
  }

  if (
    looksLikeCompactLabelCluster(previousText, previousBlock.fontSize) &&
    looksLikeCompactLabelCluster(currentText, currentBlock.fontSize) &&
    !(countLabelMarkers(previousText) <= 2 && countLabelMarkers(currentText) >= 3) &&
    previousLineCount === currentLineCount &&
    verticalGap <= Math.max(24, fontSize * 2)
  ) {
    return true;
  }

  return false;
}

function looksLikeFieldLikeClusterText(text: string, fontSize: number | undefined): boolean {
  if (!looksLikeCompactLabelCluster(text, fontSize)) {
    return false;
  }

  const normalized = normalizeBlockText(text);
  if (countLabelMarkers(normalized) > 0) {
    return true;
  }

  if (looksLikeTitleCaseHeading(normalized)) {
    return true;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 6) {
    return false;
  }

  return words.every((word) => isTitleCaseWord(word) || isConnectorWord(word) || /^[\p{N}()/-]+$/u.test(word));
}

function looksLikeCompactLabelCluster(text: string, fontSize: number | undefined): boolean {
  if (text.length === 0 || text.length > 80) {
    return false;
  }

  if (
    /^(?:[-*•]\s+|\d+[.)]\s+)/u.test(text) ||
    /[.!?]$/.test(text) ||
    looksLikeSectionHeading(text) ||
    looksLikeStandaloneQuestionHeading(text)
  ) {
    return false;
  }

  const words = text.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 8 || countTextLines(text) > 3) {
    return false;
  }

  if (!text.includes(":") && words.length < 2) {
    return false;
  }

  return text.includes(":") || looksLikeTitleCaseHeading(text) || (fontSize !== undefined && fontSize <= 12);
}

function looksLikeExplicitParagraphBoundaryText(text: string, fontSize: number | undefined): boolean {
  return looksLikeSectionHeading(text) ||
    looksLikeStandaloneQuestionHeading(text) ||
    (fontSize !== undefined && fontSize >= 18 && looksLikeHeading(text, fontSize) && !text.includes(":"));
}

function countTextLines(text: string): number {
  return text
    .split(/\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .length;
}

function isSingleWordBlockText(text: string): boolean {
  const words = normalizeBlockText(text).split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length === 1;
}

function countLabelMarkers(text: string): number {
  return (text.match(/:/gu) ?? []).length;
}

function resolvePageWritingMode(page: PdfObservedPage): PdfWritingMode | undefined {
  if (page.runs.some((run) => run.writingMode === "vertical")) {
    return "vertical";
  }

  return undefined;
}

function joinBlockText(
  previousBlock: GroupedBlockSeed,
  currentBlock: GroupedBlockSeed,
  writingMode: PdfWritingMode | undefined,
): string {
  const previousText = previousBlock.text;
  const currentText = currentBlock.text;
  if (writingMode !== "vertical" && endsWithHyphenatedContinuation(previousText) && startsWithContinuation(currentText)) {
    return `${previousText.replace(/[-\u2010-\u2015]$/u, "")}${currentText.trimStart()}`;
  }

  const normalizedPreviousText = normalizeBlockText(previousText);
  const normalizedCurrentText = normalizeBlockText(currentText);
  const useInlineSeparator = shouldKeepCompactBlocksInParagraph(
    previousBlock,
    currentBlock,
    normalizedPreviousText,
    normalizedCurrentText,
  );
  const separator = writingMode === "vertical" && !useInlineSeparator ? "\n" : " ";
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

function withStructuralRoleInference(
  block: PdfLayoutBlock,
  role: PdfLayoutRole,
  confidence: number,
  method: string,
  reason: string,
): PdfLayoutBlock {
  return {
    ...block,
    role,
    roleConfidence: confidence,
    inferences: [
      ...(block.inferences ?? []),
      {
        kind: "structural-role",
        status: "inferred",
        method,
        confidence,
        reason,
        evidenceRunIds: block.runIds,
        evidenceBlockIds: [block.id],
      },
    ],
  };
}

function classifyLayoutBlock(
  block: PdfLayoutBlock,
  blockIndex: number,
  repeatedBoundarySets: RepeatedBoundarySets,
  blocks: readonly PdfLayoutBlock[],
): PdfLayoutBlock {
  const key = boundaryKey(block.text);
  if (key && repeatedBoundarySets.headers.has(key) && blockIndex === 0) {
    if (shouldTreatRepeatedBoundaryAsBody(block, blockIndex, blocks)) {
      return withStructuralRoleInference(
        block,
        "body",
        0.62,
        "repeated-boundary-body",
        "Repeated text aligned with body-like evidence, so it was not treated as a header.",
      );
    }

    if (shouldTreatRepeatedHeaderAsHeading(block, blockIndex, blocks)) {
      return withStructuralRoleInference(
        block,
        "heading",
        0.66,
        "repeated-boundary-heading",
        "Repeated top text also matched heading evidence, so it was kept as a heading.",
      );
    }

    return withStructuralRoleInference(
      block,
      "header",
      0.7,
      "repeated-boundary",
      "The same short top-of-page text recurred across pages.",
    );
  }

  if (key && repeatedBoundarySets.footers.has(key) && blockIndex === blocks.length - 1) {
    if (shouldTreatRepeatedBoundaryAsBody(block, blockIndex, blocks)) {
      return withStructuralRoleInference(
        block,
        "body",
        0.62,
        "repeated-boundary-body",
        "Repeated text aligned with body-like evidence, so it was not treated as a footer.",
      );
    }

    return withStructuralRoleInference(
      block,
      "footer",
      0.7,
      "repeated-boundary",
      "The same short bottom-of-page text recurred across pages.",
    );
  }

  if (looksLikeLeadingMetadataLabel(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.64,
    };
  }

  if (looksLikeNumberedListPrompt(block.text)) {
    return {
      ...block,
      role: "list",
      roleConfidence: 0.66,
    };
  }

  if (looksLikeNumberedBodyParagraph(block.text)) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.62,
    };
  }

  if (looksLikeSimpleFieldLabelBody(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.6,
    };
  }

  if (looksLikePromotedHeading(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.65,
    };
  }

  if (looksLikeTableRowDescriptor(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.6,
    };
  }

  if (looksLikeFieldValueBody(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.58,
    };
  }

  if (looksLikeFieldLabelBody(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "body",
      roleConfidence: 0.6,
    };
  }

  if (looksLikeCoverTitleHeading(block, blockIndex, blocks)) {
    return {
      ...block,
      role: "heading",
      roleConfidence: 0.64,
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

function inferLayoutRegions(pageNumber: number, blocks: readonly PdfLayoutBlock[]): readonly PdfLayoutRegion[] {
  const regions: PdfLayoutRegion[] = [];
  const tableRegion = inferTableLayoutRegion(pageNumber, blocks);
  if (tableRegion) {
    regions.push(tableRegion);
  }

  const tableBlockIds = new Set(tableRegion?.blockIds ?? []);
  const formLikeRegion = inferFormLikeLayoutRegion(pageNumber, blocks, tableBlockIds);
  if (formLikeRegion) {
    regions.push(formLikeRegion);
  }

  return regions;
}

type TableRegionProfile = "measurement-table" | "contract-award-table" | "anchored-grid-table";

function inferTableLayoutRegion(
  pageNumber: number,
  blocks: readonly PdfLayoutBlock[],
): PdfLayoutRegion | undefined {
  const profile = resolveTableRegionProfile(blocks);
  if (!profile) {
    return undefined;
  }

  const candidateBlocks = selectTableRegionBlocks(blocks, profile);
  if (!hasEnoughTableRegionEvidence(candidateBlocks, profile)) {
    return undefined;
  }

  const confidence = tableRegionConfidence(candidateBlocks, profile);
  const reason =
    profile === "measurement-table"
      ? "Repeated measurement headers and compatible value rows formed one table-like region."
      : profile === "contract-award-table"
        ? "Contract-award headers and compatible row evidence formed one table-like region."
        : "Anchored header and data rows formed one table-like region.";
  return buildLayoutRegion(
    `layout-region-${pageNumber}-table-1`,
    pageNumber,
    "table",
    profile,
    confidence,
    reason,
    candidateBlocks,
  );
}

function resolveTableRegionProfile(blocks: readonly PdfLayoutBlock[]): TableRegionProfile | undefined {
  const pageText = normalizeBlockText(blocks.map((block) => block.text).join(" ")).toLowerCase();
  const measurementSignals = [
    /\bspecimen\b/u,
    /\bnominal\s+width\b/u,
    /\bmeasured\s+width\b/u,
    /\bresult\b/u,
  ].filter((pattern) => pattern.test(pageText)).length;
  if (measurementSignals >= 4 && blocks.some((block) => looksLikeMeasurementTableBlock(block.text))) {
    return "measurement-table";
  }

  const contractSignals = [
    /\bserial\s+no\.?\b/u,
    /\bcontract\s+description\b/u,
    /\bcontract(?:or|ors|\/suppliers?| no\.?| amount)\b/u,
    /\bamount\b/u,
    /\bremarks\b/u,
  ].filter((pattern) => pattern.test(pageText)).length;
  if (contractSignals >= 4 && blocks.some((block) => looksLikeContractAwardDataBlock(block.text))) {
    return "contract-award-table";
  }

  const headerLikeCount = blocks.filter((block) => looksLikeTableHeaderLabel(block, blocks)).length;
  const dataLikeCount = blocks.filter((block, blockIndex) =>
    looksLikeTableRowDescriptor(block, blockIndex, blocks) || looksLikeTabularDataText(block.text)
  ).length;
  return headerLikeCount >= 3 && dataLikeCount >= 2 ? "anchored-grid-table" : undefined;
}

function selectTableRegionBlocks(
  blocks: readonly PdfLayoutBlock[],
  profile: TableRegionProfile,
): readonly PdfLayoutBlock[] {
  const selectedBlocks = blocks.filter((block, blockIndex) => {
    const text = normalizeBlockText(block.text);
    if (text.length === 0) {
      return false;
    }

    if (profile === "measurement-table") {
      return looksLikeMeasurementTableBlock(text) ||
        looksLikeMeasurementTableHeaderSignalText(text) ||
        looksLikeTableRowDescriptor(block, blockIndex, blocks);
    }

    if (profile === "contract-award-table") {
      return looksLikeContractAwardHeaderText(text) ||
        looksLikeContractAwardDataBlock(text) ||
        looksLikeTableRowDescriptor(block, blockIndex, blocks);
    }

    return looksLikeTableHeaderLabel(block, blocks) ||
      looksLikeTableRowDescriptor(block, blockIndex, blocks) ||
      looksLikeTabularDataText(text);
  });

  return [...dedupeByBlockId(selectedBlocks)].sort((left, right) => left.readingOrder - right.readingOrder);
}

function hasEnoughTableRegionEvidence(
  blocks: readonly PdfLayoutBlock[],
  profile: TableRegionProfile,
): boolean {
  if (profile === "measurement-table") {
    return countMeasurementHeaderSignals(blocks.map((block) => block.text).join(" ")) >= 4 &&
      blocks.some((block) => looksLikeMeasurementTableBlock(block.text));
  }

  if (profile === "contract-award-table") {
    const headerSignalCount = countContractAwardHeaderSignals(blocks.map((block) => block.text).join(" "));
    return headerSignalCount >= 4 && blocks.filter((block) => looksLikeContractAwardDataBlock(block.text)).length >= 2;
  }

  const headerCount = blocks.filter((block) => looksLikeTableHeaderLabel(block, blocks)).length;
  const dataCount = blocks.filter((block, blockIndex) =>
    looksLikeTableRowDescriptor(block, blockIndex, blocks) || looksLikeTabularDataText(block.text)
  ).length;
  return headerCount >= 3 && dataCount >= 2;
}

function tableRegionConfidence(
  blocks: readonly PdfLayoutBlock[],
  profile: TableRegionProfile,
): number {
  const headerBonus =
    profile === "contract-award-table"
      ? countContractAwardHeaderSignals(blocks.map((block) => block.text).join(" ")) * 0.035
      : countMeasurementHeaderSignals(blocks.map((block) => block.text).join(" ")) * 0.035;
  const dataBonus = blocks.filter((block) => looksLikeTabularDataText(block.text) || looksLikeContractAwardDataBlock(block.text)).length * 0.012;
  return Number(Math.min(0.84, 0.58 + headerBonus + dataBonus).toFixed(2));
}

function looksLikeMeasurementTableHeaderText(text: string): boolean {
  const normalized = normalizeBlockText(text).toLowerCase();
  return countMeasurementHeaderSignals(normalized) >= 4;
}

function looksLikeMeasurementTableHeaderSignalText(text: string): boolean {
  return countMeasurementHeaderSignals(text) >= 1;
}

function countMeasurementHeaderSignals(text: string): number {
  const normalized = normalizeBlockText(text).toLowerCase();
  return [
    /\bspecimen\b/u,
    /\bnominal\s+width\b/u,
    /\bmeasured\s+width\b/u,
    /\bresult\b/u,
  ].filter((pattern) => pattern.test(normalized)).length;
}

function looksLikeMeasurementTableBlock(text: string): boolean {
  const normalized = normalizeBlockText(text).toLowerCase();
  return looksLikeMeasurementTableHeaderText(normalized) ||
    (/\b(?:pass|review|fail|failed)\b/u.test(normalized) && /\b\d+(?:\.\d+)?\s*mm\b/u.test(normalized)) ||
    (/\b(?:alpha|beta|gamma|delta|sample|specimen)\b/u.test(normalized) && /\b\d+(?:\.\d+)?\s*mm\b/u.test(normalized));
}

function looksLikeContractAwardHeaderText(text: string): boolean {
  return countContractAwardHeaderSignals(text) >= 1;
}

function countContractAwardHeaderSignals(text: string): number {
  const normalized = normalizeBlockText(text).toLowerCase();
  return [
    /\bserial\s+no\.?\b/u,
    /\bcontract\s+description\b/u,
    /\bcontract\s+no\.?\b/u,
    /\bcontractor(?:s)?(?:\/suppliers?)?\b/u,
    /\bconsultant\b/u,
    /\bcontract\s+amount\b/u,
    /\bamount\b/u,
    /\bremarks\b/u,
  ].filter((pattern) => pattern.test(normalized)).length;
}

function looksLikeContractAwardDataBlock(text: string): boolean {
  const normalized = normalizeBlockText(text);
  return /\b(?:procurement|consultancy|services|supply|rehabilitation|construction|maintenance)\b/iu.test(normalized) ||
    /\b(?:completed|pending|ongoing|awarded|terminated)\b/iu.test(normalized) ||
    /[$€£¥]?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s*(?:ghs|usd|eur|gbp)?\b/iu.test(normalized) ||
    /\b(?:ghs|usd|eur|gbp)\b/iu.test(normalized);
}

function inferFormLikeLayoutRegion(
  pageNumber: number,
  blocks: readonly PdfLayoutBlock[],
  excludedBlockIds: ReadonlySet<string>,
): PdfLayoutRegion | undefined {
  const pageText = normalizeBlockText(blocks.map((block) => block.text).join(" ")).toLowerCase();
  if (!/\b(?:application|applicant|claimant|consent|form|gender|patient|signature|signed|authorized)\b/u.test(pageText)) {
    return undefined;
  }

  const candidateBlocks = blocks.filter((block, blockIndex) => {
    if (excludedBlockIds.has(block.id)) {
      return false;
    }

    const text = normalizeBlockText(block.text);
    return looksLikeFieldChoiceParagraphStart(text) ||
      looksLikeShortFieldLabel(text, block.fontSize) ||
      looksLikeFieldLikeClusterText(text, block.fontSize) ||
      looksLikeFieldLabelBody(block, blockIndex, blocks) ||
      looksLikeFieldValueBody(block, blockIndex, blocks);
  });
  const fieldLikeCount = candidateBlocks.filter((block) =>
    looksLikeShortFieldLabel(block.text, block.fontSize) || looksLikeFieldLikeClusterText(block.text, block.fontSize)
  ).length;
  if (candidateBlocks.length < 4 || fieldLikeCount < 3) {
    return undefined;
  }

  const confidence = Number(Math.min(0.74, 0.5 + fieldLikeCount * 0.035 + candidateBlocks.length * 0.01).toFixed(2));
  return buildLayoutRegion(
    `layout-region-${pageNumber}-form-like-1`,
    pageNumber,
    "form-like",
    "field-cluster",
    confidence,
    "Field labels and nearby values formed one form-like region.",
    [...dedupeByBlockId(candidateBlocks)].sort((left, right) => left.readingOrder - right.readingOrder),
  );
}

function buildLayoutRegion(
  id: string,
  pageNumber: number,
  kind: PdfLayoutRegion["kind"],
  method: string,
  confidence: number,
  reason: string,
  blocks: readonly PdfLayoutBlock[],
): PdfLayoutRegion {
  const blockIds = blocks.map((block) => block.id);
  const runIds = dedupeStrings(blocks.flatMap((block) => block.runIds));
  const bbox = mergeBlockBoundingBoxes(blocks);
  return {
    id,
    pageNumber,
    kind,
    blockIds,
    confidence,
    ...(bbox !== undefined ? { bbox } : {}),
    inferences: [
      {
        kind: "region",
        status: "inferred",
        method,
        confidence,
        reason,
        evidenceRunIds: runIds,
        evidenceBlockIds: blockIds,
      },
    ],
  };
}

function mergeBlockBoundingBoxes(blocks: readonly PdfLayoutBlock[]): PdfBoundingBox | undefined {
  const boxes = blocks.map((block) => block.bbox).filter((bbox): bbox is PdfBoundingBox => bbox !== undefined);
  if (boxes.length === 0) {
    return undefined;
  }

  const left = Math.min(...boxes.map((bbox) => bbox.x));
  const top = Math.min(...boxes.map((bbox) => bbox.y));
  const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
  const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function dedupeByBlockId(blocks: readonly PdfLayoutBlock[]): readonly PdfLayoutBlock[] {
  const seenIds = new Set<string>();
  const dedupedBlocks: PdfLayoutBlock[] = [];
  for (const block of blocks) {
    if (seenIds.has(block.id)) {
      continue;
    }

    seenIds.add(block.id);
    dedupedBlocks.push(block);
  }
  return dedupedBlocks;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function looksLikeNumberedListPrompt(text: string): boolean {
  const normalized = normalizeBlockText(text);
  return /^\d+[)]\s+/u.test(normalized) && normalized.endsWith(":") && normalized.length <= 160;
}

function looksLikeNumberedBodyParagraph(text: string): boolean {
  const normalized = normalizeBlockText(text);
  const numberedPrefixMatch = normalized.match(/^\d+[.)]\s+/u);
  if (!numberedPrefixMatch || /^\d+\.\d+/u.test(normalized)) {
    return false;
  }

  if (normalized.endsWith(":") || looksLikeNumberedQuestionHeading(normalized)) {
    return false;
  }

  const bodyText = normalized.slice(numberedPrefixMatch[0].length);
  if (bodyText.length < 24 || !/[\p{Ll}]/u.test(bodyText)) {
    return false;
  }

  return startsLikeSentence(bodyText) || /[.!?]["')\]]*$/u.test(normalized);
}

function looksLikeNumberedQuestionHeading(text: string): boolean {
  const normalized = normalizeBlockText(text);
  if (!normalized.endsWith("?")) {
    return false;
  }

  const numberedPrefixMatch = normalized.match(/^\d+(?:\.\d+)*[.)]\s+/u);
  if (!numberedPrefixMatch) {
    return false;
  }

  const words = normalized
    .slice(numberedPrefixMatch[0].length)
    .split(/\s+/u)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length >= 2 && words.length <= 18;
}

function looksLikePromotedHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  return looksLikeContentsEntryHeading(block, blockIndex, blocks) ||
    looksLikeInlineNarrativeHeading(block, blockIndex, blocks) ||
    looksLikeLegalMetadataHeading(block, blockIndex, blocks) ||
    looksLikeFormPromptHeading(block, blockIndex, blocks) ||
    looksLikeLeafletTitleHeading(block, blockIndex, blocks) ||
    looksLikeMetricSectionHeading(block, blockIndex, blocks) ||
    looksLikeRepeatedFieldGroupHeading(block, blockIndex, blocks) ||
    looksLikeTableHeaderLabel(block, blocks);
}

function looksLikeContentsEntryHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 80 || countLabelMarkers(normalized) > 0 || /[.!?]$/.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 6 || !looksLikeTitleCaseHeading(normalized)) {
    return false;
  }

  return blocks
    .slice(Math.max(0, blockIndex - 8), blockIndex)
    .some((candidate) => /\bcontents\b/iu.test(normalizeBlockText(candidate.text)));
}

function looksLikeInlineNarrativeHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (blockIndex === 0 || blockIndex >= blocks.length - 1) {
    return false;
  }

  const normalized = normalizeBlockText(block.text);
  if (
    normalized.length === 0 ||
    normalized.length > 48 ||
    looksLikeDateLine(normalized) ||
    looksLikePaginationLine(normalized) ||
    looksLikeProductionMetadata(normalized) ||
    looksLikeNumberedBodyParagraph(normalized) ||
    looksLikeStandaloneQuestionHeading(normalized)
  ) {
    return false;
  }

  if (
    !/^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){1,4}[.:]$/u.test(normalized) &&
    !/^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){1,4}\.$/u.test(normalized)
  ) {
    return false;
  }

  const previousBlock = blocks[blockIndex - 1];
  const nextBlock = blocks[blockIndex + 1];
  if (!previousBlock || !nextBlock) {
    return false;
  }

  const previousText = normalizeBlockText(previousBlock.text);
  const nextText = normalizeBlockText(nextBlock.text);
  if (
    previousText.length < 24 ||
    nextText.length < 24 ||
    looksLikeHeadingLikeText(previousText, previousBlock.fontSize) ||
    looksLikeHeadingLikeText(nextText, nextBlock.fontSize) ||
    !startsLikeSentence(nextText)
  ) {
    return false;
  }

  return true;
}

function looksLikeLegalMetadataHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 160 || /[.!?]$/.test(normalized)) {
    return false;
  }

  const compact = normalized.toLowerCase().replaceAll(/\s+/g, "");
  const hasLegalMetadataLabel = /\b(?:citation number|neutral citation|claim number|claim no\.?|case number|case no\.?)\b/iu.test(
    normalized,
  ) ||
    compact.includes("neutralcitationnumber") ||
    compact.includes("claimnumber") ||
    compact.includes("casenumber");
  if (!hasLegalMetadataLabel) {
    return false;
  }

  return hasHeadingNeighbor(blockIndex, blocks) || /\[\d{4}\]/u.test(normalized);
}

function looksLikeFormPromptHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 96) {
    return false;
  }

  const trimmedPrompt = normalized.replace(/^[*•]\s*/u, "");
  if (!trimmedPrompt.endsWith(":") || /[.!?]$/.test(trimmedPrompt.slice(0, -1)) || countLabelMarkers(trimmedPrompt) !== 1) {
    return false;
  }

  if (looksLikeDateLine(trimmedPrompt) || looksLikePaginationLine(trimmedPrompt) || looksLikeProductionMetadata(trimmedPrompt)) {
    return false;
  }

  const promptText = trimmedPrompt.slice(0, -1).trim();
  const words = promptText.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 10) {
    return false;
  }

  const hasPromptCue = normalized.startsWith("*") || normalized.startsWith("•") || promptText.includes("(") ||
    /^\d+(?:\.\d+)*[.)]?\s+/u.test(promptText);
  const hasHeadingContext = hasHeadingNeighbor(blockIndex, blocks);
  if (!hasPromptCue && !hasHeadingContext) {
    return false;
  }

  if (!hasPromptCue && !looksLikeTitleCaseHeading(promptText) && !looksLikeSectionHeading(promptText)) {
    return false;
  }

  return hasHeadingContext || (hasPromptCue && isEarlyPageHeadingContext(blockIndex, blocks));
}

function looksLikeMetricSectionHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 64 || /[.!?]$/.test(normalized)) {
    return false;
  }

  if (!/^\d{4}\s+/u.test(normalized) || !looksLikeTitleCaseHeading(normalized)) {
    return false;
  }

  return blocks
    .slice(Math.max(0, blockIndex - 2), Math.min(blocks.length, blockIndex + 3))
    .some((candidate, candidateIndex) => {
      const originalIndex = Math.max(0, blockIndex - 2) + candidateIndex;
      if (originalIndex === blockIndex) {
        return false;
      }

      return looksLikeMetricValueText(candidate.text) || looksLikeHeadingLikeText(candidate.text, candidate.fontSize);
    });
}

function looksLikeMetricValueText(text: string): boolean {
  const normalized = normalizeBlockText(text);
  return /\d/u.test(normalized) && /(?:[%$€£¥]|(?:\b(?:kw|mw|gw|kwh|mwh|gwh|twh)\b))/iu.test(normalized);
}

function looksLikeRepeatedFieldGroupHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 120 || countLabelMarkers(normalized) < 2 || /[.!?]$/.test(normalized)) {
    return false;
  }

  if (!looksLikeTitleCaseHeading(normalized)) {
    return false;
  }

  const stem = normalizeHeadingStem(normalized);
  if (stem.length === 0) {
    return false;
  }

  return blocks
    .slice(Math.max(0, blockIndex - 2), Math.min(blocks.length, blockIndex + 3))
    .some((candidate, candidateIndex) => {
      const originalIndex = Math.max(0, blockIndex - 2) + candidateIndex;
      if (originalIndex === blockIndex) {
        return false;
      }

      const candidateText = normalizeBlockText(candidate.text);
      return normalizeHeadingStem(candidateText) === stem &&
        (looksLikeSectionHeading(candidateText) || looksLikeHeadingLikeText(candidateText, candidate.fontSize));
    });
}

function normalizeHeadingStem(text: string): string {
  return normalizeBlockText(text)
    .toLowerCase()
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/u, "")
    .replace(/\b\d+\b/gu, " ")
    .replace(/[:*]/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function looksLikeLeafletTitleHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length < 24 || normalized.length > 160 || !isEarlyPageHeadingContext(blockIndex, blocks)) {
    return false;
  }

  if (!normalized.includes(":") || looksLikeProductionMetadata(normalized) || looksLikeDateLine(normalized)) {
    return false;
  }

  const labelText = normalized.slice(0, normalized.indexOf(":")).trim();
  if (/\./u.test(labelText) || labelText.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word)).length > 3) {
    return false;
  }

  const hasDosePattern = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml)(?:\/(?:ml|l|g))?\b/iu.test(normalized);
  const hasInstructionTitle = /^[\p{Lu}\s&/'’().-]+:/u.test(normalized) && /[\p{Ll}]/u.test(normalized);
  return hasDosePattern && hasInstructionTitle;
}

function looksLikeSimpleFieldLabelBody(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (
    normalized.length === 0 ||
    normalized.length > 48 ||
    looksLikeDateLine(normalized) ||
    looksLikePaginationLine(normalized) ||
    looksLikeProductionMetadata(normalized)
  ) {
    return false;
  }

  const trimmedLabel = normalized.replace(/^[*•]\s*/u, "");
  if (
    countLabelMarkers(trimmedLabel) !== 1 ||
    /[.!?]$/u.test(trimmedLabel.slice(0, -1)) ||
    /^\d+(?:\.\d+)*[.)]?\s+/u.test(trimmedLabel)
  ) {
    return false;
  }

  const labelText = trimmedLabel.slice(0, -1).trim();
  const words = labelText.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 3) {
    return false;
  }

  return blocks
    .slice(Math.max(0, blockIndex - 2), Math.min(blocks.length, blockIndex + 3))
    .some((candidate, candidateIndex) => {
      const originalIndex = Math.max(0, blockIndex - 2) + candidateIndex;
      if (originalIndex === blockIndex) {
        return false;
      }

      return looksLikeShortFieldLabel(candidate.text, candidate.fontSize);
    });
}

function looksLikeFieldLabelBody(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 120 || /[.!?]$/.test(normalized)) {
    return false;
  }

  if (looksLikeSectionHeading(normalized) || looksLikeStandaloneQuestionHeading(normalized)) {
    return false;
  }

  if (looksLikeDateLine(normalized) || looksLikePaginationLine(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  const colonCount = countLabelMarkers(normalized);
  const containsLowercase = /[\p{Ll}]/u.test(normalized);
  const hasFieldContext = blocks
    .slice(Math.max(0, blockIndex - 2), Math.min(blocks.length, blockIndex + 3))
    .some((candidate, candidateIndex) => {
      const originalIndex = Math.max(0, blockIndex - 2) + candidateIndex;
      if (originalIndex === blockIndex) {
        return false;
      }
      const candidateText = normalizeBlockText(candidate.text);
      return looksLikeShortFieldLabel(candidateText, candidate.fontSize);
    });

  if (!containsLowercase && !hasFieldContext) {
    return false;
  }

  const hasTitleContext = blocks
    .slice(Math.max(0, blockIndex - 2), blockIndex)
    .some((candidate) => (candidate.fontSize ?? 0) >= 18 || looksLikeHeading(candidate.text, candidate.fontSize));
  const isBodyLabelZone = blockIndex > 4 || hasTitleContext;
  if (!isBodyLabelZone) {
    return false;
  }

  if (/^[-*•]\s+/u.test(normalized) && words.length <= 4) {
    return false;
  }

  if (colonCount >= 2) {
    return true;
  }

  if (colonCount === 1) {
    return words.length <= 8 && (block.fontSize ?? 12) <= 12;
  }

  if ((block.fontSize ?? 12) > 12 || words.length < 2 || words.length > 8) {
    return false;
  }

  if (/\d/u.test(normalized)) {
    return false;
  }

  return hasFieldContext && words.every((word) => isTitleCaseWord(word) || isConnectorWord(word));
}

function looksLikeFieldValueBody(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 160 || /^[*•-]\s*/u.test(normalized)) {
    return false;
  }

  if (
    looksLikeSectionHeading(normalized) ||
    looksLikeStandaloneQuestionHeading(normalized) ||
    looksLikeDateLine(normalized) ||
    looksLikePaginationLine(normalized)
  ) {
    return false;
  }

  if (looksLikeProductionMetadata(normalized)) {
    return false;
  }

  if (countLabelMarkers(normalized) > 0) {
    return false;
  }

  const labelNeighbor = findNearbyFieldLabelNeighbor(block, blockIndex, blocks);
  if (!labelNeighbor) {
    return false;
  }

  const fontSize = block.fontSize ?? labelNeighbor.fontSize ?? 12;
  if (fontSize > 14) {
    return false;
  }

  if (block.anchor && labelNeighbor.anchor) {
    const verticalGap = Math.abs(block.anchor.y - labelNeighbor.anchor.y);
    if (verticalGap > Math.max(36, fontSize * 3.2)) {
      return false;
    }
  }

  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return false;
  }

  return !looksLikeHeading(normalized, block.fontSize) || /[:]/u.test(normalizeBlockText(labelNeighbor.text)) || /[\p{Ll}\p{Nd}-]/u.test(normalized);
}

function findNearbyFieldLabelNeighbor(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): PdfLayoutBlock | undefined {
  const fontSize = block.fontSize ?? 12;
  const labelCandidates = blocks.filter((candidate, candidateIndex) => {
    if (candidateIndex === blockIndex) {
      return false;
    }

    const candidateText = normalizeBlockText(candidate.text);
    if (!(looksLikeShortFieldLabel(candidateText, candidate.fontSize) || looksLikeFieldLikeClusterText(candidateText, candidate.fontSize))) {
      return false;
    }

    if (!block.anchor || !candidate.anchor) {
      return Math.abs(candidateIndex - blockIndex) <= 2;
    }

    const verticalGap = Math.abs(block.anchor.y - candidate.anchor.y);
    if (verticalGap > Math.max(36, fontSize * 3.2)) {
      return false;
    }

    if (candidate.anchor.x > block.anchor.x + Math.max(28, fontSize * 2.4)) {
      return false;
    }

    return true;
  });
  if (labelCandidates.length === 0) {
    return undefined;
  }

  return [...labelCandidates].sort((left, right) => compareFieldLabelCandidates(block, left, right))[0];
}

function compareFieldLabelCandidates(
  block: PdfLayoutBlock,
  left: PdfLayoutBlock,
  right: PdfLayoutBlock,
): number {
  if (!block.anchor || !left.anchor || !right.anchor) {
    return 0;
  }

  const leftVerticalGap = Math.abs(block.anchor.y - left.anchor.y);
  const rightVerticalGap = Math.abs(block.anchor.y - right.anchor.y);
  if (leftVerticalGap !== rightVerticalGap) {
    return leftVerticalGap - rightVerticalGap;
  }

  return Math.abs(block.anchor.x - left.anchor.x) - Math.abs(block.anchor.x - right.anchor.x);
}

function looksLikeLeadingMetadataLabel(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (blockIndex > 1) {
    return false;
  }

  const normalized = normalizeBlockText(block.text);
  if (!normalized.endsWith(":") || countLabelMarkers(normalized) !== 1) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 2) {
    return false;
  }

  return blocks
    .slice(blockIndex + 1, blockIndex + 4)
    .some((candidate) => (candidate.fontSize ?? 0) >= 18 || looksLikeHeading(candidate.text, candidate.fontSize));
}

function looksLikeCoverTitleHeading(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 140 || !isEarlyPageHeadingContext(blockIndex, blocks)) {
    return false;
  }

  if (
    /^[-*•]\s+/u.test(normalized) ||
    looksLikeDateLine(normalized) ||
    looksLikeProductionMetadata(normalized) ||
    looksLikeNumberedBodyParagraph(normalized)
  ) {
    return false;
  }

  if (countLabelMarkers(normalized) >= 2) {
    return false;
  }

  if (countLabelMarkers(normalized) === 1 && normalized.split(/\s+/u).length <= 2) {
    return false;
  }

  if (looksLikeTitleCaseHeading(normalized)) {
    return true;
  }

  if (/^[\p{Lu}\p{N}\s&/'’().:-]+$/u.test(normalized) && normalized.length <= 120) {
    return true;
  }

  return normalized.includes(":") && !/[.!?]$/.test(normalized) && normalized.length <= 96;
}

function looksLikeTableRowDescriptor(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  const normalized = normalizeBlockText(block.text);
  if (normalized.length === 0 || normalized.length > 220 || !block.anchor) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  const looksLikeRowLabel =
    (/^\d+\s+/u.test(normalized) && !/^\d+\.\d+/u.test(normalized)) ||
    (words.length === 1 && /[\p{Ll}]/u.test(normalized));
  if (!looksLikeRowLabel) {
    return false;
  }

  const fontSize = block.fontSize ?? 12;
  const rowTolerance = Math.max(10, fontSize * 0.9);
  const dataNeighbor = blocks.some((candidate, candidateIndex) => {
    if (candidateIndex === blockIndex || candidate.anchor === undefined) {
      return false;
    }

    if (Math.abs(candidate.anchor.y - block.anchor!.y) > rowTolerance) {
      return false;
    }

    if (Math.abs(candidate.anchor.x - block.anchor!.x) < Math.max(12, fontSize * 1.2)) {
      return false;
    }

    return looksLikeTabularDataText(candidate.text);
  });

  return dataNeighbor;
}

function looksLikeTableHeaderLabel(
  block: PdfLayoutBlock,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (!block.anchor) {
    return false;
  }

  const anchor = block.anchor;
  const normalized = normalizeBlockText(block.text);
  if (!looksLikeShortTabularHeaderText(normalized)) {
    return false;
  }

  const fontSize = block.fontSize ?? 12;
  const rowTolerance = Math.max(10, fontSize * 0.9);
  const columnTolerance = Math.max(16, fontSize * 1.8);
  const sameRowHeaderCount = blocks.filter((candidate) => {
    if (!candidate.anchor || candidate.id === block.id) {
      return false;
    }

    return Math.abs(candidate.anchor.y - anchor.y) <= rowTolerance &&
      Math.abs(candidate.anchor.x - anchor.x) >= columnTolerance &&
      looksLikeShortTabularHeaderText(normalizeBlockText(candidate.text));
  }).length;
  if (sameRowHeaderCount < 2) {
    return false;
  }

  return blocks.some((candidate) => {
    if (!candidate.anchor || candidate.id === block.id) {
      return false;
    }

    const verticalGap = Math.abs(candidate.anchor.y - anchor.y);
    if (verticalGap <= rowTolerance || verticalGap > Math.max(84, fontSize * 10)) {
      return false;
    }

    return looksLikeTabularDataText(candidate.text);
  });
}

function looksLikeShortTabularHeaderText(text: string): boolean {
  const normalized = normalizeBlockText(text);
  if (normalized.length === 0 || normalized.length > 48 || countLabelMarkers(normalized) > 0) {
    return false;
  }

  if (looksLikeDateLine(normalized) || looksLikePaginationLine(normalized) || /[.!?]$/.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 4) {
    return false;
  }

  return /^[\p{Lu}\p{Lt}\p{N}][\p{L}\p{N}\s/'’().-]*$/u.test(normalized);
}

function looksLikeTabularDataText(text: string): boolean {
  const normalized = normalizeBlockText(text);
  if (normalized.length === 0) {
    return false;
  }

  return /[$€£¥]?\d/u.test(normalized) ||
    /\b(?:completed|failed|paid|pending|received|rejected|total)\b/iu.test(normalized) ||
    /\b[A-Z]{3}\b/u.test(normalized) ||
    /\d{1,2}[-/]\p{L}{3,9}[-/]\d{2,4}/u.test(normalized);
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

  if (looksLikeNumberedQuestionHeading(normalized)) {
    return true;
  }

  if (looksLikeNumberedBodyParagraph(normalized)) {
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

function shouldTreatRepeatedBoundaryAsBody(
  block: PdfLayoutBlock,
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (!hasCompactFormBoundaryContext(blockIndex, blocks)) {
    return false;
  }

  const normalized = normalizeBlockText(block.text);
  if (blockIndex === 0) {
    return looksLikeFormBoundaryMetadata(normalized) ||
      looksLikeShortFieldLabel(normalized, block.fontSize) ||
      looksLikeFieldLikeClusterText(normalized, block.fontSize);
  }

  if (blockIndex === blocks.length - 1) {
    return looksLikeFormFooterFieldClusterText(normalized) ||
      looksLikeShortFieldLabel(normalized, block.fontSize) ||
      looksLikeFieldLikeClusterText(normalized, block.fontSize);
  }

  return false;
}

function hasCompactFormBoundaryContext(
  blockIndex: number,
  blocks: readonly PdfLayoutBlock[],
): boolean {
  if (blockIndex !== 0 && blockIndex !== blocks.length - 1) {
    return false;
  }

  let fieldLabelCount = 0;
  let promptCount = 0;
  for (const block of blocks) {
    const normalized = normalizeBlockText(block.text);
    if (looksLikeShortFieldLabel(normalized, block.fontSize) || looksLikeFieldLikeClusterText(normalized, block.fontSize)) {
      fieldLabelCount += 1;
    }

    if (looksLikeNumberedListPrompt(normalized)) {
      promptCount += 1;
    }
  }

  const firstBlock = blocks[0];
  const lastBlock = blocks.at(-1);
  const hasBoundaryMetadata = firstBlock !== undefined && looksLikeFormBoundaryMetadata(normalizeBlockText(firstBlock.text));
  const hasFooterFieldCluster = lastBlock !== undefined && looksLikeFormFooterFieldClusterText(normalizeBlockText(lastBlock.text));

  return fieldLabelCount >= 1 && (promptCount >= 1 || hasBoundaryMetadata || hasFooterFieldCluster);
}

function looksLikeFormBoundaryMetadata(text: string): boolean {
  return /^(?:source:|created:|optimized\b|pdfcpu:|pr\. name:|testdata\/)/iu.test(text);
}

function looksLikeFormFooterFieldClusterText(text: string): boolean {
  if (countLabelMarkers(text) === 0 || /[.!?]$/u.test(text)) {
    return false;
  }

  const normalized = text.toLowerCase();
  const hasOption = [...FORM_OPTION_TEXTS].some((option) => normalized.includes(option));
  if (!hasOption) {
    return false;
  }

  return /[\p{L}\p{N}][\p{L}\p{N}\s&/'’().-]{0,32}:/u.test(text);
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

function looksLikePaginationLine(text: string): boolean {
  return /\bpage\s+\d+\s+of\s+\d+\b/iu.test(text);
}

function looksLikeShortFieldLabel(text: string, fontSize: number | undefined): boolean {
  const normalized = normalizeBlockText(text);
  if (countLabelMarkers(normalized) === 0) {
    return false;
  }

  if (looksLikeDateLine(normalized) || looksLikePaginationLine(normalized) || /[.!?]$/.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0 || words.length > 4) {
    return false;
  }

  return (fontSize ?? 12) <= 12;
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
  if (hasLargeInlineGap(previousBlock.anchor, currentBlock.anchor, previousBlock.bbox, fontSize)) {
    return false;
  }

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

function serializeObservationPages(pages: readonly GroupedLayoutPage[]): string {
  return pages
    .map((page) => serializeObservationBlocks(page.blocks))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function serializeObservationBlocks(blocks: readonly GroupedLayoutBlock[]): string {
  let text = "";
  let previousBlock: GroupedLayoutBlock | undefined;

  for (const block of blocks) {
    const normalizedBlockText = formatObservationBlockText(previousBlock, block);
    if (normalizedBlockText.length === 0) {
      continue;
    }

    const separator = previousBlock === undefined
      ? ""
      : (shouldOmitObservationSeparator(previousBlock, block)
          ? ""
          : (shouldSplitObservationAfterHeading(previousBlock, block) || block.startsParagraph ? "\n\n" : " "));
    text += `${separator}${normalizedBlockText}`;
    previousBlock = block;
  }

  return text;
}

function serializeLayoutBlocks(blocks: readonly PdfLayoutBlock[]): string {
  let text = "";
  let emittedBlockCount = 0;

  for (const block of blocks) {
    if (block.role === "header" || block.role === "footer") {
      continue;
    }

    const normalizedBlockText = normalizeBlockText(block.text);
    if (normalizedBlockText.length === 0) {
      continue;
    }
    const separator = emittedBlockCount === 0 ? "" : (block.startsParagraph ? "\n\n" : " ");
    text += `${separator}${normalizedBlockText}`;
    emittedBlockCount += 1;
  }

  return text;
}

function formatObservationBlockText(
  previousBlock: GroupedLayoutBlock | undefined,
  block: GroupedLayoutBlock,
): string {
  const normalizedBlockText = normalizeObservationBlockText(block.text, block.hasGeneratorPathTrace === true);
  if (
    previousBlock !== undefined &&
    looksLikeHeadingLikeText(normalizeBlockText(previousBlock.text), previousBlock.fontSize) &&
    /^\d+[.)]\s+/u.test(normalizedBlockText) &&
    !looksLikeNumberedQuestionHeading(normalizedBlockText) &&
    !looksLikeNumberedListPrompt(normalizedBlockText)
  ) {
    return normalizedBlockText.replace(/^(?<label>\d+[.)])\s+/u, "$<label>\n\n");
  }

  return normalizedBlockText;
}

function shouldOmitObservationSeparator(previousBlock: GroupedLayoutBlock, block: GroupedLayoutBlock): boolean {
  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(block.text);
  return /guide$/iu.test(previousText) && /^this guide\b/iu.test(currentText);
}

function normalizeObservationBlockText(text: string, hasGeneratorPathTrace: boolean): string {
  void hasGeneratorPathTrace;
  return normalizeBlockText(text);
}

function shouldSplitObservationAfterHeading(previousBlock: PdfLayoutBlock, block: PdfLayoutBlock): boolean {
  const previousText = normalizeBlockText(previousBlock.text);
  const currentText = normalizeBlockText(block.text);
  if (shouldKeepHeadingLeadInParagraph(previousBlock, block, previousText, currentText, block.writingMode)) {
    return false;
  }

  return block.startsParagraph === false &&
    looksLikeHeadingLikeText(previousText, previousBlock.fontSize) &&
    looksLikeHeadingLikeText(currentText, block.fontSize) === false &&
    previousText.length >= 8 &&
    previousText.length <= 40 &&
    currentText.length >= 80 &&
    /[:.]$/u.test(previousText) === false;
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
