import type {
  PdfBoundingBox,
  PdfKnownLimitCode,
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfLayoutInferenceRecord,
  PdfLayoutPage,
  PdfLayoutRegion,
  PdfLayoutRole,
  PdfObjectRef,
  PdfObservedDocument,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfPoint,
  PdfWritingMode,
} from "./contracts.ts";

interface LayoutBlockSeed {
  readonly id: string;
  readonly pageNumber: number;
  readonly text: string;
  readonly runIds: readonly string[];
  readonly glyphIds: readonly string[];
  readonly resolutionMethod: PdfObservedPage["resolutionMethod"];
  readonly pageRef?: PdfObjectRef;
  readonly anchor?: PdfPoint;
  readonly bbox?: PdfBoundingBox;
  readonly fontSize?: number;
  readonly writingMode?: PdfWritingMode;
  readonly paragraphContinuation?: boolean;
  readonly paragraphBoundary?: boolean;
  readonly inferences: readonly PdfLayoutInferenceRecord[];
}

interface OrderedLayoutBlock extends LayoutBlockSeed {
  readonly readingOrder: number;
}

interface GroupedLayoutPage {
  readonly pageNumber: number;
  readonly resolutionMethod: PdfObservedPage["resolutionMethod"];
  readonly pageRef?: PdfObjectRef;
  readonly blocks: readonly OrderedLayoutBlock[];
}

interface RepeatedBoundaryEvidence {
  readonly keys: ReadonlySet<string>;
}

interface TableEvidence {
  readonly blockIds: ReadonlySet<string>;
  readonly headerBlockIds: ReadonlySet<string>;
  readonly region?: PdfLayoutRegion;
}

interface FormEvidence {
  readonly region?: PdfLayoutRegion;
}

interface PeripheralBands {
  readonly headers: ReadonlySet<string>;
  readonly footers: ReadonlySet<string>;
}

interface VisualRow {
  readonly blocks: readonly OrderedLayoutBlock[];
  readonly y: number;
}

const groupedPagesByObservation = new WeakMap<PdfObservedDocument, readonly GroupedLayoutPage[]>();

export function buildObservationParagraphText(observation: PdfObservedDocument): string {
  const groupedPages = getGroupedPages(observation);
  const repeated = collectRepeatedBoundaryEvidence(groupedPages);
  return serializePages(classifyPages(groupedPages, repeated));
}

export function buildLayoutDocument(observation: PdfObservedDocument): PdfLayoutDocument {
  const groupedPages = getGroupedPages(observation);
  const repeated = collectRepeatedBoundaryEvidence(groupedPages);
  const pages = classifyPages(groupedPages, repeated);
  return {
    kind: "pdf-layout",
    strategy: "line-blocks",
    pages,
    extractedText: serializePages(pages),
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      "layout-block-heuristic",
      "layout-role-heuristic",
      "layout-reading-order-heuristic",
      "layout-region-heuristic",
    ]),
  };
}

function getGroupedPages(observation: PdfObservedDocument): readonly GroupedLayoutPage[] {
  const cached = groupedPagesByObservation.get(observation);
  if (cached !== undefined) {
    return cached;
  }
  const grouped = observation.pages.map(groupPage);
  groupedPagesByObservation.set(observation, grouped);
  return grouped;
}

function groupPage(page: PdfObservedPage): GroupedLayoutPage {
  const writingMode = pageWritingMode(page);
  const seeds = groupRuns(page, writingMode);
  const ordered = orderBlocks(seeds, writingMode);
  const split = splitLeadingSentenceTails(ordered, writingMode).map((block, index) => ({
    ...block,
    readingOrder: index,
  }));
  return {
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks: split,
  };
}

function groupRuns(
  page: PdfObservedPage,
  writingMode: PdfWritingMode | undefined,
): readonly LayoutBlockSeed[] {
  const groups: PdfObservedTextRun[][] = [];
  let current: PdfObservedTextRun[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const run of page.runs) {
    const previous = current.at(-1);
    if (previous !== undefined && startsVisualLine(previous, run, writingMode)) {
      flush();
    }
    current.push(run);
  }
  flush();

  return groups.flatMap((runs, index) => {
    const text = joinRunText(runs);
    if (text.length === 0) {
      return [];
    }
    const first = runs[0] as PdfObservedTextRun;
    const bbox = mergeRunBoundingBoxes(runs);
    const fontSize = dominantFontSize(runs);
    return [{
      id: `block-${String(page.pageNumber)}-${String(index + 1)}`,
      pageNumber: page.pageNumber,
      text,
      runIds: runs.map((run) => run.id),
      glyphIds: runs.flatMap((run) => run.glyphIds),
      resolutionMethod: page.resolutionMethod,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      ...(first.anchor !== undefined ? { anchor: first.anchor } : {}),
      ...(bbox !== undefined ? { bbox } : {}),
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(writingMode !== undefined ? { writingMode } : {}),
      inferences: [],
    }];
  });
}

function startsVisualLine(
  previous: PdfObservedTextRun,
  current: PdfObservedTextRun,
  writingMode: PdfWritingMode | undefined,
): boolean {
  if (!previous.anchor || !current.anchor) {
    return current.startsNewLine === true;
  }
  const fontSize = Math.max(previous.fontSize ?? 12, current.fontSize ?? 12);
  if (writingMode === "vertical") {
    const columnChanged = Math.abs(previous.anchor.x - current.anchor.x) > Math.max(3, fontSize * 0.4);
    const movedBack = current.anchor.y > previous.anchor.y + Math.max(4, fontSize * 0.5);
    return columnChanged || movedBack || current.startsNewLine === true;
  }
  const rowChanged = Math.abs(previous.anchor.y - current.anchor.y) > Math.max(2.5, fontSize * 0.3);
  const movedBack = current.anchor.x < previous.anchor.x - Math.max(4, fontSize * 0.4);
  if (rowChanged || movedBack || (isShortSentenceTail(previous.text) && beginsSentence(current.text))) {
    return true;
  }
  const previousRight = previous.bbox === undefined
    ? previous.anchor.x + normalizeText(previous.text).length * fontSize * 0.45
    : previous.bbox.x + previous.bbox.width;
  const horizontalGap = current.anchor.x - previousRight;
  return horizontalGap > Math.max(20, fontSize * 2);
}

function joinRunText(runs: readonly PdfObservedTextRun[]): string {
  let text = "";
  for (const run of runs) {
    const current = normalizeText(run.text);
    if (current.length === 0) {
      continue;
    }
    if (text.length === 0) {
      text = current;
      continue;
    }
    text += shouldJoinWithoutSpace(text, current) ? current : ` ${current}`;
  }
  return text.trim();
}

function shouldJoinWithoutSpace(previous: string, current: string): boolean {
  return previous.endsWith("-") || /^[,.;:!?%)\]}]/u.test(current) || /[(\[{/]$/u.test(previous);
}

function mergeRunBoundingBoxes(runs: readonly PdfObservedTextRun[]): PdfBoundingBox | undefined {
  return mergeBoundingBoxes(runs.flatMap((run) => run.bbox === undefined ? [] : [run.bbox]));
}

function dominantFontSize(runs: readonly PdfObservedTextRun[]): number | undefined {
  const sizes = runs.flatMap((run) => run.fontSize === undefined ? [] : [run.fontSize]);
  if (sizes.length === 0) {
    return undefined;
  }
  const counts = new Map<number, number>();
  for (const size of sizes) {
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted(([leftSize, leftCount], [rightSize, rightCount]) => rightCount - leftCount || rightSize - leftSize)[0]?.[0];
}

function orderBlocks(
  blocks: readonly LayoutBlockSeed[],
  writingMode: PdfWritingMode | undefined,
): readonly OrderedLayoutBlock[] {
  if (blocks.length <= 1) {
    return blocks.map((block, readingOrder) => withReadingOrder(block, readingOrder, "content-order", 0.72));
  }
  if (writingMode === "vertical") {
    return [...blocks]
      .toSorted(compareVerticalBlocks)
      .map((block, readingOrder) => withReadingOrder(block, readingOrder, "geometry-line-order", 0.78));
  }

  const anchored = blocks.filter(hasAnchor);
  if (anchored.length < Math.max(2, Math.ceil(blocks.length * 0.6))) {
    return blocks.map((block, readingOrder) => withReadingOrder(block, readingOrder, "content-order", 0.62));
  }

  const visualRows = clusterVisualRows(anchored);
  const ordinalGrid = hasOrdinalGridEvidence(visualRows);
  const grid = (
    rowsFormGrid(visualRows) && gridRegionCoverage(visualRows, anchored.length) >= 0.4
  ) || (ordinalGrid && ordinalGridCoverage(visualRows) >= 0.5);
  const rowMajorFields = rowsFormCompactFieldGrid(visualRows);
  const columns = grid || rowMajorFields || ordinalGrid ? undefined : detectTextColumns(anchored);
  const orderedAnchored = grid
    ? orderLogicalGridRows(visualRows)
    : ordinalGrid
      ? orderPartialOrdinalGrid(visualRows)
      : rowMajorFields
        ? visualRows.flatMap((row) => row.blocks)
    : columns === undefined
      ? [...anchored].toSorted(compareLineOrder)
      : columns.flatMap((column) => [...column].toSorted(compareLineOrder));
  const anchoredIds = new Set(orderedAnchored.map((block) => block.id));
  const unanchored = blocks.filter((block) => !anchoredIds.has(block.id));
  const ordered = [...orderedAnchored, ...unanchored];
  const method = columns === undefined ? "geometry-line-order" : "geometry-column-order";
  const confidence = grid ? 0.86 : columns === undefined ? 0.8 : 0.84;
  return ordered.map((block, readingOrder) => withReadingOrder(block, readingOrder, method, confidence));
}

function orderLogicalGridRows(rows: readonly VisualRow[]): readonly OrderedLayoutBlock[] {
  const ordinalRows = repeatedOrdinalRowIndexes(rows);
  const primaryIndexes = ordinalRows.length >= 2
    ? ordinalRows
    : rows.flatMap((row, index) => row.blocks.length >= 3 ? [index] : []);
  if (primaryIndexes.length < 2) {
    return rows.flatMap((row) => row.blocks);
  }
  const firstPrimaryIndex = primaryIndexes[0];
  if (firstPrimaryIndex === undefined) return rows.flatMap((row) => row.blocks);
  const primaryIndexSet = new Set(primaryIndexes);
  const headerStart = ordinalRows.length >= 2
    ? logicalHeaderStart(rows, firstPrimaryIndex)
    : firstPrimaryIndex;
  const headerIndexes = new Set(
    ordinalRows.length >= 2
      ? Array.from({ length: firstPrimaryIndex - headerStart }, (_, index) => headerStart + index)
      : [],
  );
  const logicalRows: { readonly startIndex: number; blocks: OrderedLayoutBlock[] }[] = [];
  const extras: { readonly rowIndex: number; readonly blocks: readonly OrderedLayoutBlock[] }[] = [];
  let current: { readonly startIndex: number; blocks: OrderedLayoutBlock[] } | undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] as VisualRow;
    if (headerIndexes.has(rowIndex)) {
      if (rowIndex === headerStart) {
        const headerBlocks = [...headerIndexes].flatMap((index) => rows[index]?.blocks ?? []);
        extras.push({ rowIndex, blocks: orderLogicalRowCells(headerBlocks) });
      }
      continue;
    }
    if (primaryIndexSet.has(rowIndex)) {
      current = { startIndex: rowIndex, blocks: [...row.blocks] };
      logicalRows.push(current);
      continue;
    }
    if (current === undefined) {
      extras.push({ rowIndex, blocks: row.blocks });
      continue;
    }
    const previousVisualRow = rows[rowIndex - 1];
    const gap = previousVisualRow === undefined ? 0 : previousVisualRow.y - row.y;
    const fontSize = median(row.blocks.flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
    if (gap > Math.max(30, fontSize * 3) || !rowOverlapsLogicalColumns(row, current.blocks)) {
      extras.push({ rowIndex, blocks: row.blocks });
      current = undefined;
      continue;
    }
    current.blocks.push(...row.blocks);
  }

  const orderedByRow = new Map<number, readonly OrderedLayoutBlock[]>();
  for (const logical of logicalRows) {
    orderedByRow.set(logical.startIndex, orderLogicalRowCells(logical.blocks));
  }
  for (const extra of extras) {
    orderedByRow.set(extra.rowIndex, extra.blocks);
  }
  return [...orderedByRow.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, blocks]) => blocks);
}

function logicalHeaderStart(rows: readonly VisualRow[], firstPrimaryIndex: number): number {
  let start = firstPrimaryIndex;
  for (let index = firstPrimaryIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const below = rows[index + 1];
    if (row === undefined || below === undefined) break;
    const fontSize = median(row.blocks.flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
    const gap = row.y - below.y;
    const compact = row.blocks.every((block) =>
      normalizeText(block.text).length <= 40 && !looksLikeSentence(block.text)
    );
    if (!compact || gap > Math.max(24, fontSize * 3)) break;
    start = index;
  }
  return start;
}

function repeatedOrdinalRowIndexes(rows: readonly VisualRow[]): readonly number[] {
  const candidates = rows.flatMap((row, rowIndex) => {
    const leftmost = Math.min(...row.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.x]));
    return row.blocks.flatMap((block) => {
      const text = normalizeText(block.text);
      const anchor = block.anchor;
      const match = /^(\d{1,8})(?:[.)]|\s)/u.exec(text);
      return anchor !== undefined && anchor.x <= leftmost + 12 && match?.[1] !== undefined
        ? [{ rowIndex, x: anchor.x, value: Number(match[1]) }]
        : [];
    });
  });
  const clusters: { x: number; entries: { readonly rowIndex: number; readonly value: number }[] }[] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((value) => Math.abs(value.x - candidate.x) <= 12);
    if (cluster === undefined) {
      clusters.push({ x: candidate.x, entries: [{ rowIndex: candidate.rowIndex, value: candidate.value }] });
    } else {
      cluster.entries.push({ rowIndex: candidate.rowIndex, value: candidate.value });
      cluster.x = average([cluster.x, candidate.x]);
    }
  }
  const strongest = clusters
    .filter((cluster) => ordinalValuesIdentifyRows(cluster.entries))
    .toSorted((left, right) => right.entries.length - left.entries.length)[0];
  return strongest === undefined
    ? []
    : [...new Set(strongest.entries.map((entry) => entry.rowIndex))].toSorted((left, right) => left - right);
}

function ordinalValuesIdentifyRows(entries: readonly { readonly rowIndex: number; readonly value: number }[]): boolean {
  return entries.length >= 3 && new Set(entries.map((entry) => entry.value)).size >= 3;
}

function rowOverlapsLogicalColumns(row: VisualRow, logicalBlocks: readonly OrderedLayoutBlock[]): boolean {
  const logicalLeft = Math.min(...logicalBlocks.map((block) => horizontalInterval(block).left));
  const logicalRight = Math.max(...logicalBlocks.map((block) => horizontalInterval(block).right));
  return row.blocks.some((block) => {
    const interval = horizontalInterval(block);
    return interval.right >= logicalLeft && interval.left <= logicalRight;
  });
}

function orderLogicalRowCells(blocks: readonly OrderedLayoutBlock[]): readonly OrderedLayoutBlock[] {
  const clusters: OrderedLayoutBlock[][] = [];
  for (const block of [...blocks].toSorted(compareX)) {
    const cluster = clusters.find((candidate) => candidate.some((member) =>
      horizontalIntervalsOverlap(member, block) ||
      Math.abs((member.anchor?.x ?? 0) - (block.anchor?.x ?? 0)) <= Math.max(12, (block.fontSize ?? 12) * 2)
    ));
    if (cluster === undefined) clusters.push([block]);
    else cluster.push(block);
  }
  return clusters
    .toSorted((left, right) => compareX(left[0] as OrderedLayoutBlock, right[0] as OrderedLayoutBlock))
    .flatMap((cluster) => cluster.toSorted((left, right) =>
      (right.anchor?.y ?? 0) - (left.anchor?.y ?? 0) || compareX(left, right)
    ));
}

function withReadingOrder(
  block: LayoutBlockSeed,
  readingOrder: number,
  method: string,
  confidence: number,
): OrderedLayoutBlock {
  return {
    ...block,
    readingOrder,
    inferences: [
      ...block.inferences,
      {
        kind: "reading-order",
        status: "inferred",
        method,
        confidence,
        reason: method === "geometry-column-order"
          ? "Repeated horizontal bands with vertical overlap support column-major reading order."
          : method === "geometry-line-order"
            ? "Page-space anchors support top-to-bottom, left-to-right reading order."
            : "Geometry was insufficient, so source content order was retained.",
        evidenceRunIds: block.runIds,
      },
    ],
  };
}

function compareVerticalBlocks(left: LayoutBlockSeed, right: LayoutBlockSeed): number {
  const leftAnchor = left.anchor;
  const rightAnchor = right.anchor;
  if (!leftAnchor || !rightAnchor) {
    return leftAnchor ? -1 : rightAnchor ? 1 : 0;
  }
  return rightAnchor.x - leftAnchor.x || rightAnchor.y - leftAnchor.y;
}

function compareLineOrder(left: LayoutBlockSeed, right: LayoutBlockSeed): number {
  const leftAnchor = left.anchor;
  const rightAnchor = right.anchor;
  if (!leftAnchor || !rightAnchor) {
    return leftAnchor ? -1 : rightAnchor ? 1 : 0;
  }
  const tolerance = Math.max(4, Math.min(9, Math.min(left.fontSize ?? 12, right.fontSize ?? 12) * 1.2));
  if (Math.abs(leftAnchor.y - rightAnchor.y) <= tolerance) {
    return leftAnchor.x - rightAnchor.x;
  }
  return rightAnchor.y - leftAnchor.y;
}

function compareX(left: LayoutBlockSeed, right: LayoutBlockSeed): number {
  return (left.anchor?.x ?? Number.POSITIVE_INFINITY) - (right.anchor?.x ?? Number.POSITIVE_INFINITY);
}

function clusterVisualRows(blocks: readonly OrderedLayoutBlock[] | readonly LayoutBlockSeed[]): readonly VisualRow[] {
  const sorted = [...blocks].filter(hasAnchor).toSorted((left, right) =>
    (right.anchor?.y ?? 0) - (left.anchor?.y ?? 0) || compareX(left, right)
  );
  const rows: { blocks: OrderedLayoutBlock[]; y: number }[] = [];
  for (const block of sorted) {
    const y = block.anchor?.y ?? 0;
    const tolerance = Math.max(3, (block.fontSize ?? 12) * 0.38);
    const row = rows.find((candidate) =>
      Math.abs(candidate.y - y) <= tolerance || candidate.blocks.some((member) =>
        verticalIntervalsOverlap(member, block) || sameCompactRowBand(member, block)
      )
    );
    const orderedBlock = "readingOrder" in block ? block : { ...block, readingOrder: 0 };
    if (row === undefined) {
      rows.push({ blocks: [orderedBlock], y });
    } else {
      row.blocks.push(orderedBlock);
      row.y = (row.y * (row.blocks.length - 1) + y) / row.blocks.length;
    }
  }
  return rows
    .toSorted((left, right) => right.y - left.y)
    .map((row) => ({ blocks: orderVisualRowBlocks(row.blocks), y: row.y }));
}

function sameCompactRowBand(left: LayoutBlockSeed, right: LayoutBlockSeed): boolean {
  if (!left.anchor || !right.anchor) return false;
  if (normalizeText(left.text).length > 40 || normalizeText(right.text).length > 40) return false;
  const tolerance = Math.max(5, Math.max(left.fontSize ?? 12, right.fontSize ?? 12) * 0.9);
  return Math.abs(left.anchor.y - right.anchor.y) <= tolerance;
}

function verticalIntervalsOverlap(left: LayoutBlockSeed, right: LayoutBlockSeed): boolean {
  if (!left.bbox || !right.bbox) return false;
  const top = Math.max(left.bbox.y, right.bbox.y);
  const bottom = Math.min(left.bbox.y + left.bbox.height, right.bbox.y + right.bbox.height);
  return bottom >= top;
}

function orderVisualRowBlocks(blocks: readonly OrderedLayoutBlock[]): readonly OrderedLayoutBlock[] {
  const clusters: OrderedLayoutBlock[][] = [];
  for (const block of [...blocks].toSorted(compareX)) {
    const cluster = clusters.find((candidate) => candidate.some((member) =>
      horizontalIntervalsOverlap(member, block) ||
      Math.abs((member.anchor?.x ?? 0) - (block.anchor?.x ?? 0)) <= Math.max(10, (block.fontSize ?? 12) * 1.5)
    ));
    if (cluster === undefined) clusters.push([block]);
    else cluster.push(block);
  }
  return clusters
    .toSorted((left, right) => compareX(left[0] as OrderedLayoutBlock, right[0] as OrderedLayoutBlock))
    .flatMap((cluster) => cluster.toSorted((left, right) =>
      (right.anchor?.y ?? 0) - (left.anchor?.y ?? 0) || compareX(left, right)
    ));
}

function horizontalIntervalsOverlap(left: LayoutBlockSeed, right: LayoutBlockSeed): boolean {
  const leftInterval = horizontalInterval(left);
  const rightInterval = horizontalInterval(right);
  return Math.min(leftInterval.right, rightInterval.right) >= Math.max(leftInterval.left, rightInterval.left);
}

function horizontalInterval(block: LayoutBlockSeed): { readonly left: number; readonly right: number } {
  if (block.bbox !== undefined) {
    return { left: block.bbox.x, right: block.bbox.x + block.bbox.width };
  }
  const left = block.anchor?.x ?? 0;
  return {
    left,
    right: left + normalizeText(block.text).length * (block.fontSize ?? 12) * 0.45,
  };
}

function rowsFormGrid(rows: readonly VisualRow[]): boolean {
  const multiCellRows = rows.filter((row) => row.blocks.length >= 2);
  if (multiCellRows.length < 2) {
    return false;
  }
  const numericRows = multiCellRows.filter((row) => row.blocks.some((block) => containsNumericEvidence(block.text)));
  const cells = multiCellRows.flatMap((row) => row.blocks);
  const longCellCount = cells.filter((block) => normalizeText(block.text).length > 36).length;
  const numericCellCount = cells.filter((block) => containsNumericEvidence(block.text)).length;
  const widestRow = Math.max(...multiCellRows.map((row) => row.blocks.length));
  if (widestRow < 3 && numericRows.length === 0) {
    return false;
  }
  if (
    numericRows.length === 0 &&
    multiCellRows.flatMap((row) => row.blocks).filter((block) => normalizeText(block.text).length <= 24).length <
      Math.ceil(multiCellRows.flatMap((row) => row.blocks).length * 0.8)
  ) {
    return false;
  }
  if (
    longCellCount >= Math.ceil(cells.length * 0.3) &&
    (widestRow <= 2 || numericCellCount < Math.ceil(cells.length * 0.4))
  ) {
    return false;
  }
  const reference = multiCellRows.toSorted((left, right) => right.blocks.length - left.blocks.length)[0];
  if (reference === undefined) {
    return false;
  }
  const referenceXs = reference.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.x]);
  return multiCellRows.filter((row) => row.blocks.every((block) => {
    const anchor = block.anchor;
    return anchor !== undefined && referenceXs.some((x) =>
      Math.abs(x - anchor.x) <= Math.max(10, (block.fontSize ?? 12) * 1.5)
    );
  })).length >= 2;
}

function gridRegionCoverage(rows: readonly VisualRow[], blockCount: number): number {
  if (blockCount === 0) return 0;
  const multiCellRows = rows.filter((row) => row.blocks.length >= 2);
  const reference = multiCellRows.toSorted((left, right) => right.blocks.length - left.blocks.length)[0];
  if (reference === undefined) return 0;
  const referenceXs = reference.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.x]);
  const minimumCells = Math.max(2, reference.blocks.length - 1);
  const aligned = multiCellRows.filter((row) => row.blocks.length >= minimumCells && row.blocks.every((block) => {
    const anchor = block.anchor;
    return anchor !== undefined && referenceXs.some((x) =>
      Math.abs(x - anchor.x) <= Math.max(10, (block.fontSize ?? 12) * 1.5)
    );
  }));
  if (aligned.length < 2) return 0;
  return aligned.reduce((count, row) => count + row.blocks.length, 0) / blockCount;
}

function hasOrdinalGridEvidence(rows: readonly VisualRow[]): boolean {
  const ordinalIndexes = repeatedOrdinalRowIndexes(rows);
  if (ordinalIndexes.length < 3) return false;
  const ordinalRows = ordinalIndexes.flatMap((index) => rows[index] === undefined ? [] : [rows[index]]);
  if (ordinalRows.filter((row) => row.blocks.length >= 3).length < Math.ceil(ordinalRows.length * 0.7)) {
    return false;
  }
  return true;
}

function ordinalGridCoverage(rows: readonly VisualRow[]): number {
  const ordinalIndexes = repeatedOrdinalRowIndexes(rows);
  const ordinalRows = ordinalIndexes.flatMap((index) => rows[index] === undefined ? [] : [rows[index]]);
  const upper = ordinalRows[0]?.y;
  const lower = ordinalRows.at(-1)?.y;
  if (upper === undefined || lower === undefined) return 0;
  const coveredBlocks = rows
    .filter((row) => row.y <= upper && row.y >= lower)
    .reduce((count, row) => count + row.blocks.length, 0);
  const totalBlocks = rows.reduce((count, row) => count + row.blocks.length, 0);
  return totalBlocks > 0 ? coveredBlocks / totalBlocks : 0;
}

function rowsFormCompactFieldGrid(rows: readonly VisualRow[]): boolean {
  const multiCellRows = rows.filter((row) =>
    row.blocks.length >= 2 && row.blocks.every((block) => normalizeText(block.text).length <= 40)
  );
  if (multiCellRows.length < 2) return false;
  const blocks = rows.flatMap((row) => row.blocks);
  const labels = blocks.filter((block) => normalizeText(block.text).endsWith(":"));
  const numeric = multiCellRows.flatMap((row) => row.blocks).filter((block) => containsNumericEvidence(block.text));
  return labels.length >= 2 &&
    numeric.length < Math.ceil(multiCellRows.flatMap((row) => row.blocks).length * 0.25);
}

function orderPartialOrdinalGrid(rows: readonly VisualRow[]): readonly OrderedLayoutBlock[] {
  const ordinalIndexes = repeatedOrdinalRowIndexes(rows);
  const first = ordinalIndexes[0];
  if (first === undefined) return rows.flatMap((row) => row.blocks);
  const headerStart = logicalHeaderStart(rows, first);
  return [
    ...rows.slice(0, headerStart).flatMap((row) => row.blocks),
    ...orderLogicalGridRows(rows.slice(headerStart)),
  ];
}

function detectTextColumns(blocks: readonly LayoutBlockSeed[]): readonly (readonly LayoutBlockSeed[])[] | undefined {
  const sorted = [...blocks].filter(hasAnchor).toSorted(compareX);
  const medianFontSize = median(sorted.flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
  const clusters: LayoutBlockSeed[][] = [];
  for (const block of sorted) {
    const x = block.anchor?.x ?? 0;
    const cluster = clusters.find((candidate) =>
      Math.abs(average(candidate.map((item) => item.anchor?.x ?? 0)) - x) <= Math.max(24, medianFontSize * 3)
    );
    if (cluster === undefined) {
      clusters.push([block]);
    } else {
      cluster.push(block);
    }
  }
  let repeated = clusters.filter((cluster) => cluster.length >= 2).toSorted((left, right) =>
    average(left.map((block) => block.anchor?.x ?? 0)) - average(right.map((block) => block.anchor?.x ?? 0))
  );
  let merged = true;
  while (merged) {
    merged = false;
    for (let index = 0; index < repeated.length - 1; index += 1) {
      const left = repeated[index];
      const right = repeated[index + 1];
      if (left === undefined || right === undefined || !columnBandsOverlap(left, right)) continue;
      repeated = [
        ...repeated.slice(0, index),
        [...left, ...right],
        ...repeated.slice(index + 2),
      ];
      merged = true;
      break;
    }
  }
  if (repeated.length < 2 || !columnsOverlapVertically(repeated)) {
    return detectBalancedColumnSplit(blocks, medianFontSize);
  }
  if (repeated.some((column) => !columnHasVerticalContinuity(column))) {
    return detectBalancedColumnSplit(blocks, medianFontSize);
  }
  const assigned = new Set(repeated.flatMap((cluster) => cluster.map((block) => block.id)));
  if (assigned.size < Math.ceil(blocks.length * 0.65)) {
    return detectBalancedColumnSplit(blocks, medianFontSize);
  }
  const extras = blocks.filter((block) => !assigned.has(block.id));
  for (const extra of extras) {
    const x = extra.anchor?.x;
    if (x === undefined) {
      repeated[repeated.length - 1]?.push(extra);
      continue;
    }
    const nearest = repeated.toSorted((left, right) =>
      Math.abs(average(left.map((block) => block.anchor?.x ?? 0)) - x) -
      Math.abs(average(right.map((block) => block.anchor?.x ?? 0)) - x)
    )[0];
    nearest?.push(extra);
  }
  return repeated;
}

function detectBalancedColumnSplit(
  blocks: readonly LayoutBlockSeed[],
  fontSize: number,
): readonly (readonly LayoutBlockSeed[])[] | undefined {
  const anchored = blocks.filter(hasAnchor).toSorted(compareX);
  const minimumSide = Math.max(2, Math.ceil(anchored.length * 0.2));
  let splitIndex: number | undefined;
  let splitGap = 0;
  for (let index = minimumSide; index <= anchored.length - minimumSide; index += 1) {
    const left = anchored[index - 1];
    const right = anchored[index];
    if (left === undefined || right === undefined) continue;
    const gap = right.anchor.x - left.anchor.x;
    if (gap > splitGap) {
      splitGap = gap;
      splitIndex = index;
    }
  }
  if (splitIndex === undefined || splitGap < Math.max(36, fontSize * 4)) return undefined;
  const columns = [anchored.slice(0, splitIndex), anchored.slice(splitIndex)];
  return columns.every(columnHasVerticalContinuity) && columnsOverlapVertically(columns)
    ? columns
    : undefined;
}

function columnHasVerticalContinuity(column: readonly LayoutBlockSeed[]): boolean {
  const ys = column.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.y]);
  const uniqueYs = [...new Set(ys.map((y) => Math.round(y * 10) / 10))];
  if (uniqueYs.length < 2) return false;
  if (uniqueYs.length === 2) return true;
  const minimum = Math.min(...ys);
  const maximum = Math.max(...ys);
  const span = maximum - minimum;
  if (span <= 0) return false;
  if (uniqueYs.length === 3) {
    const sorted = uniqueYs.toSorted((left, right) => left - right);
    const gaps = sorted.slice(1).map((value, index) => value - (sorted[index] ?? value));
    return Math.max(...gaps) <= span * 0.75;
  }
  const occupiedBands = new Set(ys.map((y) => Math.min(5, Math.floor(((y - minimum) / span) * 6))));
  return occupiedBands.size >= 4;
}

function columnBandsOverlap(
  left: readonly LayoutBlockSeed[],
  right: readonly LayoutBlockSeed[],
): boolean {
  const leftBand = medianHorizontalBand(left);
  const rightBand = medianHorizontalBand(right);
  const fontSize = median([...left, ...right].flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
  const leftAnchor = average(left.map((block) => block.anchor?.x ?? 0));
  const rightAnchor = average(right.map((block) => block.anchor?.x ?? 0));
  return Math.abs(rightAnchor - leftAnchor) <= Math.max(60, fontSize * 6) &&
    leftBand.right > rightBand.left - Math.max(4, fontSize * 0.5) &&
    rightBand.right > leftBand.left + Math.max(4, fontSize * 0.5);
}

function medianHorizontalBand(blocks: readonly LayoutBlockSeed[]): { readonly left: number; readonly right: number } {
  const intervals = blocks.map(horizontalInterval);
  return {
    left: median(intervals.map((interval) => interval.left)) ?? 0,
    right: median(intervals.map((interval) => interval.right)) ?? 0,
  };
}

function columnsOverlapVertically(columns: readonly (readonly LayoutBlockSeed[])[]): boolean {
  const ranges = columns.map((column) => {
    const ys = column.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.y]);
    return { minimum: Math.min(...ys), maximum: Math.max(...ys) };
  });
  const sharedMinimum = Math.max(...ranges.map((range) => range.minimum));
  const sharedMaximum = Math.min(...ranges.map((range) => range.maximum));
  const spans = ranges.map((range) => range.maximum - range.minimum);
  return sharedMaximum >= sharedMinimum && Math.max(...spans) <= Math.max(80, Math.min(...spans) * 4);
}

function splitLeadingSentenceTails(
  blocks: readonly OrderedLayoutBlock[],
  writingMode: PdfWritingMode | undefined,
): readonly OrderedLayoutBlock[] {
  if (writingMode === "vertical") {
    return blocks;
  }
  const output: OrderedLayoutBlock[] = [];
  for (const block of blocks) {
    const previous = output.at(-1);
    if (previous === undefined) {
      output.push(block);
      continue;
    }
    const split = leadingSentenceTail(block.text);
    if (
      split === undefined ||
      !sameTextColumn(previous, block) ||
      verticalGap(previous, block) > Math.max(48, (block.fontSize ?? 12) * 4.2) ||
      endsSentence(previous.text)
    ) {
      output.push(block);
      continue;
    }
    output.push(
      { ...block, id: `${block.id}-tail`, text: split.tail, paragraphContinuation: true },
      { ...block, id: `${block.id}-body`, text: split.body, paragraphBoundary: true },
    );
  }
  return output;
}

function leadingSentenceTail(text: string): { readonly tail: string; readonly body: string } | undefined {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(.{2,24}?[.!?])\s+([\p{Lu}\p{Lt}][\s\S]+)$/u);
  if (!match) {
    return undefined;
  }
  const tail = match[1]?.trim() ?? "";
  const body = match[2]?.trim() ?? "";
  if (tail.split(/\s+/u).length > 3 || /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|No|Fig|Eq|Sec|Ch|vs|e\.g|i\.e)\.$/iu.test(tail)) {
    return undefined;
  }
  return tail.length > 0 && body.length > 0 ? { tail, body } : undefined;
}

function classifyPages(
  pages: readonly GroupedLayoutPage[],
  repeated: RepeatedBoundaryEvidence,
): readonly PdfLayoutPage[] {
  return pages.map((page) => classifyPage(page, repeated));
}

function classifyPage(page: GroupedLayoutPage, repeated: RepeatedBoundaryEvidence): PdfLayoutPage {
  const table = inferTableEvidence(page);
  const form = inferFormEvidence(page, table.blockIds);
  const structuralBlockIds = new Set([
    ...table.blockIds,
    ...(form.region?.blockIds ?? []),
  ]);
  const peripheral = inferPeripheralBands(page.blocks, structuralBlockIds);
  const medianFontSize = inferBodyFontSize(page.blocks);
  const initialRoles = page.blocks.map((block, index) => inferRole(
    block,
    index,
    page.blocks,
    medianFontSize,
    repeated,
    peripheral,
    table,
  ));
  const paragraphStarts = inferParagraphStarts(page.blocks, initialRoles, table.blockIds);
  const blocks = page.blocks.map((block, index): PdfLayoutBlock => {
    const roleEvidence = initialRoles[index] as { readonly role: PdfLayoutRole; readonly confidence: number; readonly method: string; readonly reason: string };
    const paragraph = paragraphStarts[index] as { readonly startsParagraph: boolean; readonly confidence: number; readonly reason: string };
    return {
      id: block.id,
      pageNumber: block.pageNumber,
      readingOrder: index,
      text: block.text,
      role: roleEvidence.role,
      roleConfidence: roleEvidence.confidence,
      startsParagraph: paragraph.startsParagraph,
      runIds: block.runIds,
      glyphIds: block.glyphIds,
      ...(block.writingMode !== undefined ? { writingMode: block.writingMode } : {}),
      resolutionMethod: block.resolutionMethod,
      ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
      ...(block.anchor !== undefined ? { anchor: block.anchor } : {}),
      ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
      ...(block.fontSize !== undefined ? { fontSize: block.fontSize } : {}),
      inferences: [
        ...block.inferences,
        {
          kind: "paragraph-flow",
          status: "inferred",
          method: "paragraph-geometry",
          confidence: paragraph.confidence,
          reason: paragraph.reason,
          evidenceRunIds: block.runIds,
        },
        {
          kind: "structural-role",
          status: "inferred",
          method: roleEvidence.method,
          confidence: roleEvidence.confidence,
          reason: roleEvidence.reason,
          evidenceRunIds: block.runIds,
        },
      ],
    };
  });
  const regions = [table.region, form.region].filter((region): region is PdfLayoutRegion => region !== undefined);
  return {
    pageNumber: page.pageNumber,
    resolutionMethod: page.resolutionMethod,
    ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
    blocks,
    regions,
  };
}

function collectRepeatedBoundaryEvidence(pages: readonly GroupedLayoutPage[]): RepeatedBoundaryEvidence {
  const pageKeys = pages.map((page) => new Set([
    ...page.blocks.slice(0, 2),
    ...page.blocks.slice(-2),
  ].flatMap((block) => {
    const key = boundaryKey(block.text);
    return key === undefined ? [] : [key];
  })));
  const counts = new Map<string, number>();
  for (const keys of pageKeys) {
    for (const key of keys) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return { keys: new Set([...counts].flatMap(([key, count]) => count >= 2 ? [key] : [])) };
}

function boundaryKey(text: string): string | undefined {
  const normalized = normalizeText(text).toLowerCase().replaceAll(/\d+/g, "#");
  return normalized.length >= 3 && normalized.length <= 180 ? normalized : undefined;
}

function inferRole(
  block: OrderedLayoutBlock,
  blockIndex: number,
  blocks: readonly OrderedLayoutBlock[],
  medianFontSize: number,
  repeated: RepeatedBoundaryEvidence,
  peripheral: PeripheralBands,
  table: TableEvidence,
): { readonly role: PdfLayoutRole; readonly confidence: number; readonly method: string; readonly reason: string } {
  const text = normalizeText(block.text);
  if (table.headerBlockIds.has(block.id)) {
    return role("heading", 0.88, "table-header", "The block occupies the header band of a repeated row-and-column structure.");
  }
  if (table.blockIds.has(block.id)) {
    return role("body", 0.9, "table-body", "The block is aligned with non-header rows in a repeated table structure.");
  }
  if (looksLikeListItem(text)) {
    return role("list", 0.86, "list-prefix", "A conventional list prefix is present.");
  }

  const key = boundaryKey(text);
  const isRepeated = key !== undefined && repeated.keys.has(key);
  const fontRatio = medianFontSize <= 0 ? 1 : (block.fontSize ?? medianFontSize) / medianFontSize;
  if (isRepeated && fontRatio >= 1.25 && looksLikeHeadingCandidate(text, fontRatio, blockIndex, blocks)) {
    return role("heading", 0.86, "repeated-boundary-heading", "Repeated text is typographically stronger than the page body.");
  }
  if (isRepeated && looksLikeRepeatedTableBoundary(block, blocks)) {
    return role("heading", 0.86, "repeated-boundary-table-heading", "A repeated compact label borders multiple structured data rows.");
  }
  if (isRepeated || peripheral.headers.has(block.id) || peripheral.footers.has(block.id)) {
    const boundaryRole = peripheral.footers.has(block.id) || blockIndex >= blocks.length - Math.max(1, Math.ceil(blocks.length * 0.2))
      ? "footer"
      : "header";
    return role(boundaryRole, isRepeated ? 0.9 : 0.74, isRepeated ? "repeated-boundary" : "page-band",
      isRepeated ? "Normalized text repeats in a consistent page-boundary position." : "Typography and an isolated page-edge band separate this block from body flow.");
  }
  if (looksLikeHeadingCandidate(text, fontRatio, blockIndex, blocks)) {
    return role("heading", Math.min(0.94, 0.72 + Math.max(0, fontRatio - 1) * 0.18), "typographic-heading",
      "Relative font size, compactness, casing, and neighboring body evidence support a heading role.");
  }
  return role("body", 0.72, "body-flow", "The block participates in ordinary page text flow without stronger structural evidence.");
}

function role(
  value: PdfLayoutRole,
  confidence: number,
  method: string,
  reason: string,
): { readonly role: PdfLayoutRole; readonly confidence: number; readonly method: string; readonly reason: string } {
  return { role: value, confidence, method, reason };
}

function looksLikeHeadingCandidate(
  text: string,
  fontRatio: number,
  blockIndex: number,
  blocks: readonly OrderedLayoutBlock[],
): boolean {
  if (text.length === 0 || text.length > 180 || looksLikeSentence(text)) {
    return false;
  }
  const words = text.split(/\s+/u).filter(hasLetterOrNumber);
  if (words.length === 0 || words.length > 18) {
    return false;
  }
  if (words.length <= 2 && /[.!?]["')\]]*$/u.test(text)) {
    return false;
  }
  if (fontRatio >= 1.2) {
    return true;
  }
  if (/^\d+(?:\.\d+)*[.)]?\s+[\p{Lu}\p{Lt}]/u.test(text) && words.length <= 14) {
    return true;
  }
  const letters = Array.from(text).filter((character) => /\p{L}/u.test(character));
  const uppercase = letters.filter((character) => character === character.toUpperCase()).length;
  if (letters.length > 0 && uppercase / letters.length >= 0.82 && text.length <= 90) {
    return true;
  }
  const titleCaseRatio = words.filter((word) => /^[\p{Lu}\p{Lt}\d]/u.test(word)).length / words.length;
  const next = blocks[blockIndex + 1];
  const nextLooksBody = next !== undefined && looksLikeSentence(next.text);
  return titleCaseRatio >= 0.72 && words.length <= 10 && (blockIndex <= 2 || nextLooksBody || fontRatio > 1.05);
}

function inferPeripheralBands(
  blocks: readonly OrderedLayoutBlock[],
  structuralBlockIds: ReadonlySet<string>,
): PeripheralBands {
  const anchored = blocks.filter(hasAnchor).toSorted((left, right) => (right.anchor?.y ?? 0) - (left.anchor?.y ?? 0));
  if (anchored.length < 4) {
    return { headers: new Set(), footers: new Set() };
  }
  const medianFontSize = median(anchored.flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
  const threshold = Math.max(22, medianFontSize * 2.1);
  const headers = new Set<string>();
  const footers = new Set<string>();
  const topSearchLimit = Math.min(2, anchored.length - 1);
  for (let index = 0; index < topSearchLimit; index += 1) {
    const current = anchored[index];
    const next = anchored[index + 1];
    if (!current || !next) continue;
    if ((current.anchor?.y ?? 0) - (next.anchor?.y ?? 0) > threshold) {
      for (const candidate of anchored.slice(0, index + 1)) {
        if (!structuralBlockIds.has(candidate.id) && (candidate.fontSize ?? medianFontSize) <= medianFontSize * 1.12) {
          headers.add(candidate.id);
        }
      }
      break;
    }
  }
  const bottomStart = Math.max(0, anchored.length - 3);
  for (let index = anchored.length - 2; index >= bottomStart; index -= 1) {
    const current = anchored[index];
    const next = anchored[index + 1];
    if (!current || !next) continue;
    if ((current.anchor?.y ?? 0) - (next.anchor?.y ?? 0) > threshold) {
      for (const candidate of anchored.slice(index + 1)) {
        if (!structuralBlockIds.has(candidate.id) && (candidate.fontSize ?? medianFontSize) <= medianFontSize * 1.12) {
          footers.add(candidate.id);
        }
      }
      break;
    }
  }
  return { headers, footers };
}

function inferParagraphStarts(
  blocks: readonly OrderedLayoutBlock[],
  roles: readonly { readonly role: PdfLayoutRole }[],
  tableBlockIds: ReadonlySet<string>,
): readonly { readonly startsParagraph: boolean; readonly confidence: number; readonly reason: string }[] {
  const compactSequenceIds = collectCompactSequenceIds(blocks);
  return blocks.map((block, index) => {
    const previous = blocks[index - 1];
    const currentRole = roles[index]?.role ?? "body";
    const previousRole = roles[index - 1]?.role;
    if (index === 0 || previous === undefined) {
      return paragraph(true, 0.98, "The first block on a page begins a paragraph.");
    }
    if (block.paragraphContinuation === true) {
      return paragraph(false, 0.96, "The block is an isolated sentence tail carried over from the preceding line.");
    }
    if (block.paragraphBoundary === true) {
      return paragraph(true, 0.96, "The block follows an isolated carry-over tail and begins a new paragraph.");
    }
    if (currentRole !== "body" || previousRole !== "body" || tableBlockIds.has(block.id)) {
      return paragraph(true, 0.9, "A structural role or table-row boundary starts a new paragraph.");
    }
    if (compactSequenceIds.has(block.id)) {
      return paragraph(true, 0.84, "A repeated sequence of compact aligned entries preserves distinct row boundaries.");
    }
    if (!sameTextColumn(previous, block)) {
      return paragraph(true, 0.88, "A horizontal column or indentation change starts a new paragraph.");
    }
    const fontSize = Math.max(previous.fontSize ?? 12, block.fontSize ?? 12);
    const gap = verticalGap(previous, block);
    if (gap > Math.max(18, fontSize * 1.75)) {
      return paragraph(true, 0.86, "The vertical gap exceeds ordinary line spacing.");
    }
    if (isShortSentenceTail(previous.text) && beginsSentence(block.text)) {
      return paragraph(true, 0.84, "A short sentence-ending tail is followed by a new sentence.");
    }
    return paragraph(false, 0.78, "Alignment and line spacing support continuation of the current paragraph.");
  });
}

function collectCompactSequenceIds(blocks: readonly OrderedLayoutBlock[]): ReadonlySet<string> {
  const result = new Set<string>();
  let sequence: OrderedLayoutBlock[] = [];
  const flush = (): void => {
    if (sequence.length >= 3) sequence.forEach((block) => result.add(block.id));
    sequence = [];
  };
  for (const block of blocks) {
    const previous = sequence.at(-1);
    const compact = normalizeText(block.text).length <= 32 && !looksLikeSentence(block.text);
    const continues = previous === undefined || (
      sameTextColumn(previous, block) &&
      verticalGap(previous, block) <= Math.max(24, Math.max(previous.fontSize ?? 12, block.fontSize ?? 12) * 2)
    );
    if (!compact || !continues) {
      flush();
      if (!compact) continue;
    }
    sequence.push(block);
  }
  flush();
  return result;
}

function looksLikeRepeatedTableBoundary(
  block: OrderedLayoutBlock,
  blocks: readonly OrderedLayoutBlock[],
): boolean {
  return looksLikeCompactHeaderText(block.text) &&
    blocks.filter((candidate) => candidate.id !== block.id && containsNumericEvidence(candidate.text)).length >= 2;
}

function paragraph(
  startsParagraph: boolean,
  confidence: number,
  reason: string,
): { readonly startsParagraph: boolean; readonly confidence: number; readonly reason: string } {
  return { startsParagraph, confidence, reason };
}

function inferTableEvidence(page: GroupedLayoutPage): TableEvidence {
  const rows = clusterVisualRows(page.blocks);
  const multiCellRows = rows.filter((row) => row.blocks.length >= 2);
  const tableBlocks = new Set<string>();
  const headerBlocks = new Set<string>();
  let selectedBlocks: readonly OrderedLayoutBlock[] = [];

  if (multiCellRows.length >= 2 && rowsFormGrid(rows)) {
    const referenceColumns = Math.max(...multiCellRows.map((row) => row.blocks.length));
    const alignedRows = multiCellRows.filter((row) => row.blocks.length >= Math.max(2, referenceColumns - 1));
    if (alignedRows.length >= 2) {
      const header = alignedRows[0] as VisualRow;
      const numericBodyRows = alignedRows.slice(1).filter((row) => row.blocks.some((block) => containsNumericEvidence(block.text)));
      const compactBodyRows = alignedRows.slice(1).filter((row) => row.blocks.every((block) => normalizeText(block.text).length <= 80));
      const rowGaps = alignedRows.slice(1).map((row, index) => Math.abs((alignedRows[index]?.y ?? row.y) - row.y));
      const compactSpacing = median(rowGaps) !== undefined && (median(rowGaps) ?? Number.POSITIVE_INFINITY) <= 36;
      if (numericBodyRows.length > 0 || (compactBodyRows.length >= 2 && compactSpacing)) {
        selectedBlocks = alignedRows.flatMap((row) => row.blocks);
        header.blocks.forEach((block) => headerBlocks.add(block.id));
      }
    }
  }

  if (selectedBlocks.length === 0) {
    const sequential = inferSequentialTableBlocks(page.blocks, rows);
    if (sequential !== undefined) {
      selectedBlocks = sequential.blocks;
      sequential.headers.forEach((block) => headerBlocks.add(block.id));
    }
  }

  if (selectedBlocks.length === 0) {
    return { blockIds: tableBlocks, headerBlockIds: headerBlocks };
  }
  selectedBlocks.forEach((block) => tableBlocks.add(block.id));
  const blockIds = selectedBlocks.map((block) => block.id);
  const runIds = dedupeStrings(selectedBlocks.flatMap((block) => block.runIds));
  const bbox = mergeBoundingBoxes(selectedBlocks.flatMap((block) => block.bbox === undefined ? [] : [block.bbox]));
  const confidence = Math.min(0.93, 0.68 + Math.min(0.2, selectedBlocks.length * 0.015));
  return {
    blockIds: tableBlocks,
    headerBlockIds: headerBlocks,
    region: {
      id: `region-table-${String(page.pageNumber)}-${blockIds[0] ?? "1"}`,
      pageNumber: page.pageNumber,
      kind: "table",
      blockIds,
      confidence,
      ...(bbox !== undefined ? { bbox } : {}),
      inferences: [{
        kind: "region",
        status: "inferred",
        method: "geometry-table",
        confidence,
        reason: "Repeated row bands, aligned columns, and compact numeric or categorical cells support a table region.",
        evidenceRunIds: runIds,
        evidenceBlockIds: blockIds,
      }],
    },
  };
}

function inferSequentialTableBlocks(
  blocks: readonly OrderedLayoutBlock[],
  rows: readonly VisualRow[],
): { readonly blocks: readonly OrderedLayoutBlock[]; readonly headers: readonly OrderedLayoutBlock[] } | undefined {
  for (const row of rows) {
    if (row.blocks.length < 2 || !rowLooksLikeHeader(row)) {
      continue;
    }
    const headerBottom = Math.min(...row.blocks.map((block) => block.anchor?.y ?? 0));
    const below = blocks
      .filter((block) => (block.anchor?.y ?? Number.POSITIVE_INFINITY) < headerBottom - 2)
      .toSorted(compareLineOrder);
    const selected: OrderedLayoutBlock[] = [];
    let evidenceCount = 0;
    for (const block of below) {
      if (looksLikeSentence(block.text) && evidenceCount >= 2) {
        break;
      }
      const structured = containsNumericEvidence(block.text) || looksLikeCompactCellText(block.text);
      if (structured) {
        selected.push(block);
        if (containsNumericEvidence(block.text)) evidenceCount += 1;
      } else if (selected.length > 0 && evidenceCount > 0) {
        selected.push(block);
      }
    }
    if (evidenceCount >= 2) {
      return { blocks: [...row.blocks, ...selected], headers: row.blocks };
    }
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const candidate = blocks[index];
    if (!candidate || !looksLikeCompactHeaderText(candidate.text)) {
      continue;
    }
    const following = blocks.slice(index + 1, Math.min(blocks.length, index + 20));
    const data = following.filter((block) => containsNumericEvidence(block.text));
    if (data.length < 2) {
      continue;
    }
    const lastIndex = blocks.indexOf(data.at(-1) as OrderedLayoutBlock);
    return { blocks: blocks.slice(index, lastIndex + 1), headers: [candidate] };
  }
  return undefined;
}

function rowLooksLikeHeader(row: VisualRow): boolean {
  return row.blocks.length >= 2 &&
    row.blocks.every((block) => !looksLikeSentence(block.text) && normalizeText(block.text).length <= 100) &&
    row.blocks.filter((block) => !containsNumericEvidence(block.text)).length >= Math.ceil(row.blocks.length * 0.6);
}

function looksLikeCompactHeaderText(text: string): boolean {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/u).filter(hasLetterOrNumber);
  return normalized.length >= 8 && normalized.length <= 120 && words.length >= 3 && words.length <= 12 &&
    !looksLikeSentence(normalized) && !containsNumericEvidence(normalized);
}

function looksLikeCompactCellText(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length > 0 && normalized.length <= 100 && !looksLikeSentence(normalized);
}

function inferFormEvidence(
  page: GroupedLayoutPage,
  tableBlockIds: ReadonlySet<string>,
): FormEvidence {
  const candidates = page.blocks.filter((block) =>
    !tableBlockIds.has(block.id) && labelMarkerCount(block.text) > 0 && normalizeText(block.text).length <= 180
  );
  const fieldRows = clusterVisualRows(page.blocks.filter((block) => !tableBlockIds.has(block.id)))
    .filter((row) => row.blocks.length >= 2 && row.blocks.every((block) =>
      normalizeText(block.text).length > 0 && normalizeText(block.text).length <= 80 && !containsNumericEvidence(block.text)
    ));
  if (candidates.length < 2 && fieldRows.length < 2) {
    return {};
  }
  const selected = new Set([
    ...candidates.map((block) => block.id),
    ...fieldRows.flatMap((row) => row.blocks.map((block) => block.id)),
  ]);
  for (const label of candidates) {
    const neighbor = page.blocks
      .filter((block) => !selected.has(block.id) && !tableBlockIds.has(block.id))
      .filter((block) => sameVisualRow(label, block) || looksLikeStackedFieldValue(label, block))
      .toSorted((left, right) => fieldNeighborDistance(label, left) - fieldNeighborDistance(label, right))[0];
    if (neighbor !== undefined) selected.add(neighbor.id);
  }
  const blocks = page.blocks.filter((block) => selected.has(block.id));
  const blockIds = blocks.map((block) => block.id);
  const runIds = dedupeStrings(blocks.flatMap((block) => block.runIds));
  const bbox = mergeBoundingBoxes(blocks.flatMap((block) => block.bbox === undefined ? [] : [block.bbox]));
  const confidence = Math.min(0.72, 0.5 + candidates.length * 0.045);
  return {
    region: {
      id: `region-form-${String(page.pageNumber)}-${blockIds[0] ?? "1"}`,
      pageNumber: page.pageNumber,
      kind: "form-like",
      blockIds,
      confidence,
      ...(bbox !== undefined ? { bbox } : {}),
      inferences: [{
        kind: "region",
        status: "inferred",
        method: "field-cluster",
        confidence,
        reason: "Repeated compact labels and nearby value evidence support a form-like region.",
        evidenceRunIds: runIds,
        evidenceBlockIds: blockIds,
      }],
    },
  };
}

function inferBodyFontSize(blocks: readonly OrderedLayoutBlock[]): number {
  const candidates = blocks
    .filter((block) => block.fontSize !== undefined)
    .toSorted((left, right) => normalizeText(right.text).length - normalizeText(left.text).length)
    .slice(0, Math.max(1, Math.ceil(blocks.length / 2)));
  return median(candidates.flatMap((block) => block.fontSize === undefined ? [] : [block.fontSize])) ?? 12;
}

function sameVisualRow(left: OrderedLayoutBlock, right: OrderedLayoutBlock): boolean {
  if (!left.anchor || !right.anchor) return false;
  const tolerance = Math.max(4, Math.max(left.fontSize ?? 12, right.fontSize ?? 12) * 0.5);
  return Math.abs(left.anchor.y - right.anchor.y) <= tolerance;
}

function looksLikeStackedFieldValue(label: OrderedLayoutBlock, value: OrderedLayoutBlock): boolean {
  if (!label.anchor || !value.anchor || labelMarkerCount(value.text) > 0) return false;
  const text = normalizeText(value.text);
  if (text.length === 0 || text.length > 96 || value.readingOrder <= label.readingOrder) return false;
  const fontSize = Math.max(label.fontSize ?? 12, value.fontSize ?? 12);
  const verticalGap = label.anchor.y - value.anchor.y;
  return Math.abs(label.anchor.x - value.anchor.x) <= Math.max(12, fontSize) &&
    verticalGap > 0 && verticalGap <= Math.max(40, fontSize * 3.5);
}

function fieldNeighborDistance(label: OrderedLayoutBlock, value: OrderedLayoutBlock): number {
  if (!label.anchor || !value.anchor) return Number.POSITIVE_INFINITY;
  return Math.abs(label.anchor.x - value.anchor.x) + Math.abs(label.anchor.y - value.anchor.y);
}

function containsNumericEvidence(text: string): boolean {
  const normalized = normalizeText(text);
  const numericTokens = normalized.match(/(?:^|\s)[(+-]?(?:\d[\d.,]*|[.,]\d+)(?:[%)]|\s|$)/gu) ?? [];
  return numericTokens.length >= 2 ||
    /[$€£¥]\s*\d|\d\s*(?:%|[$€£¥]|mm|cm|kg|kw|kwh)\b/iu.test(normalized) ||
    /^\d{2,}\s+\S/u.test(normalized);
}

function looksLikeListItem(text: string): boolean {
  return /^(?:[-*•‣▪◦]|\d+[.)]|[A-Za-z][.)])\s+/u.test(normalizeText(text));
}

function labelMarkerCount(text: string): number {
  return (normalizeText(text).match(/:/gu) ?? []).length;
}

function looksLikeSentence(text: string): boolean {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/u).filter(hasLetterOrNumber);
  return words.length >= 8 && (/[.!?]["')\]]*$/u.test(normalized) || /[,;]\s/u.test(normalized));
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]*$/u.test(normalizeText(text));
}

function beginsSentence(text: string): boolean {
  return /^["'([{]*[\p{Lu}\p{Lt}]/u.test(normalizeText(text));
}

function isShortSentenceTail(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length <= 12 && endsSentence(normalized);
}

function sameTextColumn(left: LayoutBlockSeed, right: LayoutBlockSeed): boolean {
  if (!left.anchor || !right.anchor) {
    return true;
  }
  const fontSize = Math.max(left.fontSize ?? 12, right.fontSize ?? 12);
  return Math.abs(left.anchor.x - right.anchor.x) <= Math.max(18, fontSize * 1.6);
}

function verticalGap(left: LayoutBlockSeed, right: LayoutBlockSeed): number {
  if (!left.anchor || !right.anchor) {
    return 0;
  }
  return Math.abs(left.anchor.y - right.anchor.y);
}

function pageWritingMode(page: PdfObservedPage): PdfWritingMode | undefined {
  const modes = page.runs.flatMap((run) => run.writingMode === undefined ? [] : [run.writingMode]);
  return modes.length >= Math.ceil(page.runs.length * 0.6) && modes.every((mode) => mode === "vertical")
    ? "vertical"
    : undefined;
}

function serializePages(pages: readonly PdfLayoutPage[]): string {
  return pages
    .map((page) => serializeBlocks(page.blocks))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function serializeBlocks(blocks: readonly PdfLayoutBlock[]): string {
  let output = "";
  let previous: PdfLayoutBlock | undefined;
  for (const block of blocks) {
    const text = normalizeText(block.text);
    if (text.length === 0) continue;
    if (output.length === 0) {
      output = text;
    } else {
      const removeLineWrapHyphen = previous !== undefined && shouldRemoveLineWrapHyphen(previous, block);
      if (removeLineWrapHyphen) output = output.slice(0, -1);
      const separator = removeLineWrapHyphen
        ? ""
        : block.startsParagraph || block.role === "heading" || block.role === "list" || previous?.role === "heading"
        ? "\n\n"
        : previous !== undefined && (previous.text.endsWith("-") || /^[,.;:!?]/u.test(text))
          ? ""
          : " ";
      output += `${separator}${text}`;
    }
    previous = block;
  }
  return output.trim();
}

function shouldRemoveLineWrapHyphen(previous: PdfLayoutBlock, current: PdfLayoutBlock): boolean {
  if (!/\p{L}{2,}-$/u.test(normalizeText(previous.text)) || !/^\p{Ll}/u.test(normalizeText(current.text))) {
    return false;
  }
  if (previous.anchor === undefined || current.anchor === undefined) return false;
  const fontSize = Math.max(previous.fontSize ?? 12, current.fontSize ?? 12);
  return current.anchor.y < previous.anchor.y &&
    previous.anchor.y - current.anchor.y <= Math.max(24, fontSize * 2.4) &&
    Math.abs(current.anchor.x - previous.anchor.x) <= Math.max(36, fontSize * 4);
}

function mergeBoundingBoxes(boxes: readonly PdfBoundingBox[]): PdfBoundingBox | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function hasAnchor<T extends { readonly anchor?: PdfPoint }>(value: T): value is T & { readonly anchor: PdfPoint } {
  return value.anchor !== undefined;
}

function hasLetterOrNumber(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return [...new Set(values)];
}
