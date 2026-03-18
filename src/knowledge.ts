import type {
  PdfKnownLimitCode,
  PdfKnowledgeChunk,
  PdfKnowledgeChunkRole,
  PdfKnowledgeCitation,
  PdfKnowledgeDocument,
  PdfKnowledgeStrategy,
  PdfKnowledgeTableHeuristic,
  PdfKnowledgeTable,
  PdfKnowledgeTableCell,
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfLayoutPage,
  PdfObservedDocument,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfPoint,
} from "./contracts.ts";

const DEFAULT_CHUNK_TARGET = 420;
const GRID_HEADER_ROW_MIN_COLUMNS = 3;
const GRID_ROW_CELL_MIN_COUNT = 2;
const ROW_SEQUENCE_MIN_HEADERS = 3;
const ROW_SEQUENCE_MIN_ROWS = 2;

interface ProjectedTableCellSeed {
  readonly columnIndex: number;
  readonly text: string;
  readonly blocks: readonly PdfLayoutBlock[];
}

interface ProjectedTableRowSeed {
  readonly cells: readonly ProjectedTableCellSeed[];
}

interface ProjectedTableCandidate {
  readonly pageNumber: number;
  readonly heuristic: PdfKnowledgeTableHeuristic;
  readonly headers: readonly string[];
  readonly blockIds: readonly string[];
  readonly confidence: number;
  readonly rows: readonly ProjectedTableRowSeed[];
}

interface RowBand {
  readonly centerY: number;
  readonly blocks: readonly AnchoredLayoutBlock[];
}

type AnchoredLayoutBlock = PdfLayoutBlock & { readonly anchor: PdfPoint };

export function buildKnowledgeDocument(
  layout: PdfLayoutDocument,
  observation?: PdfObservedDocument,
): PdfKnowledgeDocument {
  const chunks = buildKnowledgeChunks(layout);
  const tables = buildKnowledgeTables(layout, observation);
  const strategy: PdfKnowledgeStrategy =
    tables.length === 0 ? "layout-chunks" : "layout-chunks-and-heuristic-tables";

  return {
    kind: "shell-knowledge",
    strategy,
    chunks,
    tables,
    extractedText: chunks.map((chunk) => chunk.text).join("\n\n"),
    knownLimits: dedupeKnownLimits(
      tables.length === 0
        ? [...layout.knownLimits, "knowledge-chunk-heuristic", "table-projection-not-implemented"]
        : [...layout.knownLimits, "knowledge-chunk-heuristic", "table-projection-heuristic"],
    ),
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

function buildKnowledgeTables(
  layout: PdfLayoutDocument,
  observation?: PdfObservedDocument,
): readonly PdfKnowledgeTable[] {
  const observationPages = new Map((observation?.pages ?? []).map((page) => [page.pageNumber, page]));
  const runToBlock = buildRunToBlockIndex(layout);
  const candidates: ProjectedTableCandidate[] = [];

  for (const page of layout.pages) {
    const layoutGridCandidate = projectLayoutGridTable(page);
    if (layoutGridCandidate) {
      candidates.push(layoutGridCandidate);
    }

    const observationPage = observationPages.get(page.pageNumber);
    const rowSequenceCandidate =
      observationPage === undefined ? undefined : projectRowSequenceTable(page, observationPage, runToBlock);
    if (
      rowSequenceCandidate &&
      !candidates.some((candidate) => projectedTableOverlap(candidate, rowSequenceCandidate))
    ) {
      candidates.push(rowSequenceCandidate);
    }
  }

  return dedupeProjectedTableCandidates(candidates).map((candidate, candidateIndex) =>
    finalizeProjectedTable(candidateIndex + 1, candidate)
  );
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
    text: serializeChunkBlocks(blocks),
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

function projectLayoutGridTable(page: PdfLayoutPage): ProjectedTableCandidate | undefined {
  const anchoredBlocks = page.blocks
    .filter((block): block is AnchoredLayoutBlock => block.anchor !== undefined)
    .filter((block) => block.role !== "header" && block.role !== "footer");
  if (anchoredBlocks.length < 8) {
    return undefined;
  }

  const rowBands = clusterBlocksIntoRows(anchoredBlocks);
  let bestCandidate: ProjectedTableCandidate | undefined;
  let bestScore = -1;

  for (const [rowIndex, headerBand] of rowBands.entries()) {
    const headerBlocks = [...headerBand.blocks].sort(compareBlocksByX);
    if (!looksLikeGridHeaderRow(headerBlocks)) {
      continue;
    }

    const columnAnchors = headerBlocks.map((block) => block.anchor.x);
    const rowSeeds: ProjectedTableRowSeed[] = [
      {
        cells: headerBlocks.map((block, columnIndex) => ({
          columnIndex,
          text: normalizeCellText(block.text),
          blocks: [block],
        })),
      },
    ];

    let previousCenterY = headerBand.centerY;
    for (const candidateBand of rowBands.slice(rowIndex + 1)) {
      const fontSize = candidateBand.blocks[0]?.fontSize ?? headerBlocks[0]?.fontSize ?? 12;
      const rowGap = previousCenterY - candidateBand.centerY;
      if (rowGap > Math.max(20, fontSize * 2.8)) {
        break;
      }

      const rowCells = matchBlocksToColumns(candidateBand.blocks, columnAnchors);
      if (rowCells.length < GRID_ROW_CELL_MIN_COUNT) {
        if (rowSeeds.length > 1) {
          break;
        }
        continue;
      }

      rowSeeds.push({ cells: rowCells });
      previousCenterY = candidateBand.centerY;
    }

    const bodyRowCount = rowSeeds.length - 1;
    if (bodyRowCount < ROW_SEQUENCE_MIN_ROWS) {
      continue;
    }

    const headers = rowSeeds[0]?.cells.map((cell) => cell.text).filter((text) => text.length > 0) ?? [];
    if (headers.length < GRID_HEADER_ROW_MIN_COLUMNS) {
      continue;
    }

    const candidate: ProjectedTableCandidate = {
      pageNumber: page.pageNumber,
      heuristic: "layout-grid",
      headers,
      blockIds: dedupeStrings(rowSeeds.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => block.id)))),
      confidence: Number(
        Math.min(0.86, 0.48 + headers.length * 0.035 + bodyRowCount * 0.03).toFixed(2),
      ),
      rows: rowSeeds,
    };
    const score = headers.length * 10 + bodyRowCount;
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function projectRowSequenceTable(
  layoutPage: PdfLayoutPage,
  observationPage: PdfObservedPage,
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): ProjectedTableCandidate | undefined {
  const runs = observationPage.runs.filter((run) => normalizeCellText(run.text).length > 0);
  const headerGroup = findBestHeaderRunGroup(runs);
  if (!headerGroup) {
    return undefined;
  }

  const headerCount = headerGroup.runs.length;
  const dataRuns = collectSequenceDataRuns(runs, headerGroup.startIndex);
  if (dataRuns.length < headerCount * 2 - 1) {
    return undefined;
  }

  const bodyRows = chunkSequenceRuns(dataRuns, headerCount);
  if (bodyRows.length < ROW_SEQUENCE_MIN_ROWS) {
    return undefined;
  }

  const headerRow: ProjectedTableRowSeed = {
    cells: headerGroup.runs.map((run, columnIndex) => ({
      columnIndex,
      text: normalizeCellText(run.text),
      blocks: toRunBlocks([run], runToBlock),
    })),
  };
  const bodyRowSeeds = bodyRows.map((rowRuns) => ({
    cells: rowRuns.map((run, columnIndex) => ({
      columnIndex,
      text: normalizeCellText(run.text),
      blocks: toRunBlocks([run], runToBlock),
    })),
  }));

  const headers = headerRow.cells.map((cell) => cell.text).filter((text) => text.length > 0);
  if (headers.length < ROW_SEQUENCE_MIN_HEADERS) {
    return undefined;
  }

  const rows = [headerRow, ...bodyRowSeeds];
  return {
    pageNumber: layoutPage.pageNumber,
    heuristic: "row-sequence",
    headers,
    blockIds: dedupeStrings(rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => block.id)))),
    confidence: Number(Math.min(0.72, 0.44 + headers.length * 0.03 + bodyRows.length * 0.025).toFixed(2)),
    rows,
  };
}

function findBestHeaderRunGroup(
  runs: readonly PdfObservedTextRun[],
): { readonly startIndex: number; readonly runs: readonly PdfObservedTextRun[] } | undefined {
  const fontSizes = runs.map((run) => run.fontSize ?? 0).filter((value) => value > 0).sort((left, right) => left - right);
  const medianFontSize =
    fontSizes.length === 0 ? 0 : fontSizes[Math.floor(fontSizes.length / 2)] ?? 0;
  let bestGroup: { readonly startIndex: number; readonly runs: readonly PdfObservedTextRun[] } | undefined;
  let bestScore = -1;

  for (let startIndex = 0; startIndex < runs.length; startIndex += 1) {
    const startRun = runs[startIndex] as PdfObservedTextRun;
    const fontSize = startRun.fontSize ?? 0;
    if (fontSize <= medianFontSize + 1) {
      continue;
    }

    const group: PdfObservedTextRun[] = [startRun];
    for (let nextIndex = startIndex + 1; nextIndex < runs.length; nextIndex += 1) {
      const nextRun = runs[nextIndex] as PdfObservedTextRun;
      if (!isHeaderRunText(nextRun.text) || (nextRun.fontSize ?? 0) !== fontSize) {
        break;
      }
      group.push(nextRun);
    }

    if (group.length < ROW_SEQUENCE_MIN_HEADERS) {
      continue;
    }

    const score = fontSize * 10 + group.length;
    if (score > bestScore) {
      bestScore = score;
      bestGroup = { startIndex, runs: group };
    }
  }

  return bestGroup;
}

function collectSequenceDataRuns(
  runs: readonly PdfObservedTextRun[],
  headerStartIndex: number,
): readonly PdfObservedTextRun[] {
  const collectedRuns: PdfObservedTextRun[] = [];

  for (let index = headerStartIndex - 1; index >= 0; index -= 1) {
    const run = runs[index] as PdfObservedTextRun;
    if (!isSequenceDataRunText(run.text)) {
      break;
    }
    collectedRuns.unshift(run);
  }

  return collectedRuns;
}

function chunkSequenceRuns(
  runs: readonly PdfObservedTextRun[],
  columnCount: number,
): readonly (readonly PdfObservedTextRun[])[] {
  const rows: PdfObservedTextRun[][] = [];
  let offset = 0;

  while (offset < runs.length) {
    const remaining = runs.length - offset;
    const rowLength = remaining > columnCount ? columnCount : remaining;
    if (rowLength < 2) {
      return [];
    }
    rows.push(runs.slice(offset, offset + rowLength));
    offset += rowLength;
  }

  return rows;
}

function clusterBlocksIntoRows(blocks: readonly AnchoredLayoutBlock[]): readonly RowBand[] {
  const sortedBlocks = [...blocks].sort((left, right) => {
    if (left.anchor.y !== right.anchor.y) {
      return right.anchor.y - left.anchor.y;
    }
    return left.anchor.x - right.anchor.x;
  });

  const rows: { centerY: number; blocks: AnchoredLayoutBlock[] }[] = [];
  for (const block of sortedBlocks) {
    const previousRow = rows.at(-1);
    const threshold = Math.max(8, (block.fontSize ?? 12) * 0.9);
    if (
      previousRow &&
      Math.abs(previousRow.centerY - block.anchor.y) <= threshold &&
      !rowHasCompetingColumn(previousRow.blocks, block)
    ) {
      previousRow.blocks.push(block);
      previousRow.centerY =
        previousRow.blocks.reduce((sum, currentBlock) => sum + currentBlock.anchor.y, 0) / previousRow.blocks.length;
      continue;
    }

    rows.push({
      centerY: block.anchor.y,
      blocks: [block],
    });
  }

  return rows.map((row) => ({
    centerY: row.centerY,
    blocks: [...row.blocks].sort(compareBlocksByX),
  }));
}

function rowHasCompetingColumn(
  rowBlocks: readonly AnchoredLayoutBlock[],
  candidateBlock: AnchoredLayoutBlock,
): boolean {
  const columnThreshold = Math.max(14, (candidateBlock.fontSize ?? 12) * 1.2);
  const baselineThreshold = Math.max(4, (candidateBlock.fontSize ?? 12) * 0.35);

  return rowBlocks.some((rowBlock) =>
    Math.abs(rowBlock.anchor.x - candidateBlock.anchor.x) <= columnThreshold &&
    Math.abs(rowBlock.anchor.y - candidateBlock.anchor.y) > baselineThreshold
  );
}

function matchBlocksToColumns(
  blocks: readonly AnchoredLayoutBlock[],
  columnAnchors: readonly number[],
): readonly ProjectedTableCellSeed[] {
  const sortedBlocks = [...blocks].sort(compareBlocksByX);
  const assignments = assignBlocksToColumns(sortedBlocks, columnAnchors);
  const matchedCells = new Map<number, ProjectedTableCellSeed>();

  for (const assignment of assignments) {
    const existingCell = matchedCells.get(assignment.columnIndex);
    if (!existingCell) {
      matchedCells.set(assignment.columnIndex, {
        columnIndex: assignment.columnIndex,
        text: normalizeCellText(assignment.block.text),
        blocks: [assignment.block],
      });
      continue;
    }

    matchedCells.set(assignment.columnIndex, {
      columnIndex: assignment.columnIndex,
      text: joinCellText(existingCell.text, assignment.block.text),
      blocks: [...existingCell.blocks, assignment.block],
    });
  }

  return [...matchedCells.values()]
    .filter((cell) => cell.text.length > 0)
    .sort((left, right) => left.columnIndex - right.columnIndex);
}

interface ColumnAssignment {
  readonly columnIndex: number;
  readonly block: AnchoredLayoutBlock;
}

function assignBlocksToColumns(
  blocks: readonly AnchoredLayoutBlock[],
  columnAnchors: readonly number[],
): readonly ColumnAssignment[] {
  if (blocks.length === 0 || columnAnchors.length === 0 || blocks.length > columnAnchors.length) {
    return [];
  }

  const blockCount = blocks.length;
  const columnCount = columnAnchors.length;
  const costs = Array.from({ length: blockCount + 1 }, () =>
    Array.from({ length: columnCount + 1 }, () => Number.POSITIVE_INFINITY),
  );
  const decisions = Array.from({ length: blockCount + 1 }, () =>
    Array.from({ length: columnCount + 1 }, () => false),
  );

  for (let columnIndex = 0; columnIndex <= columnCount; columnIndex += 1) {
    costs[0]![columnIndex] = 0;
  }

  for (let blockIndex = 1; blockIndex <= blockCount; blockIndex += 1) {
    const remainingBlocks = blockCount - blockIndex;
    for (let columnIndex = blockIndex; columnIndex <= columnCount - remainingBlocks; columnIndex += 1) {
      const skipCost = costs[blockIndex]![columnIndex - 1]!;
      let bestCost = skipCost;
      let assignCurrentBlock = false;

      const assignCost = costs[blockIndex - 1]![columnIndex - 1]!;
      if (Number.isFinite(assignCost)) {
        const block = blocks[blockIndex - 1]!;
        const columnAnchor = columnAnchors[columnIndex - 1];
        if (columnAnchor !== undefined) {
          const totalCost = assignCost + scoreColumnAssignment(block, columnAnchor, columnIndex - 1, columnAnchors.length);
          if (totalCost < bestCost) {
            bestCost = totalCost;
            assignCurrentBlock = true;
          }
        }
      }

      costs[blockIndex]![columnIndex] = bestCost;
      decisions[blockIndex]![columnIndex] = assignCurrentBlock;
    }
  }

  const assignments: ColumnAssignment[] = [];
  let blockIndex = blockCount;
  let columnIndex = columnCount;
  while (blockIndex > 0 && columnIndex > 0) {
    if (decisions[blockIndex]![columnIndex]) {
      assignments.push({
        columnIndex: columnIndex - 1,
        block: blocks[blockIndex - 1]!,
      });
      blockIndex -= 1;
      columnIndex -= 1;
      continue;
    }
    columnIndex -= 1;
  }

  if (blockIndex > 0) {
    return [];
  }

  return assignments.reverse();
}

function scoreColumnAssignment(
  block: AnchoredLayoutBlock,
  columnAnchor: number,
  columnIndex: number,
  columnCount: number,
): number {
  const text = normalizeCellText(block.text);
  const distance = Math.abs(columnAnchor - block.anchor.x);

  let penalty = distance;
  if (looksLikeNumericCell(text)) {
    const leadingTextColumnCount = Math.min(2, columnCount);
    if (columnIndex < leadingTextColumnCount) {
      penalty += 40;
    }
  } else if (columnIndex >= Math.max(2, columnCount - 3)) {
    penalty += 22;
  }

  return penalty;
}

function looksLikeGridHeaderRow(blocks: readonly AnchoredLayoutBlock[]): boolean {
  if (blocks.length < GRID_HEADER_ROW_MIN_COLUMNS) {
    return false;
  }

  const texts = blocks.map((block) => normalizeCellText(block.text)).filter((text) => text.length > 0);
  if (texts.length < GRID_HEADER_ROW_MIN_COLUMNS) {
    return false;
  }

  if (texts.some((text) => text.length > 32 || looksLikeNumericCell(text))) {
    return false;
  }

  const xValues = blocks.map((block) => block.anchor.x);
  return Math.max(...xValues) - Math.min(...xValues) >= 60;
}

function finalizeProjectedTable(tableIndex: number, candidate: ProjectedTableCandidate): PdfKnowledgeTable {
  const cells: PdfKnowledgeTableCell[] = [];

  for (const [rowIndex, row] of candidate.rows.entries()) {
    for (const cell of row.cells) {
      cells.push({
        rowIndex,
        columnIndex: cell.columnIndex,
        text: cell.text,
        citations: createTableCellCitations(tableIndex, rowIndex, cell.columnIndex, cell.blocks),
      });
    }
  }

  return {
    id: `table-${tableIndex}`,
    pageNumber: candidate.pageNumber,
    headers: candidate.headers,
    ...(candidate.heuristic !== undefined ? { heuristic: candidate.heuristic } : {}),
    blockIds: candidate.blockIds,
    confidence: candidate.confidence,
    cells,
  };
}

function createTableCellCitations(
  tableIndex: number,
  rowIndex: number,
  columnIndex: number,
  blocks: readonly PdfLayoutBlock[],
): readonly PdfKnowledgeCitation[] {
  return blocks.map((block, citationIndex) => ({
    id: `table-${tableIndex}-r${rowIndex}-c${columnIndex + 1}-${citationIndex + 1}`,
    pageNumber: block.pageNumber,
    blockId: block.id,
    runIds: block.runIds,
    text: block.text,
    ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
  }));
}

function buildRunToBlockIndex(layout: PdfLayoutDocument): ReadonlyMap<string, PdfLayoutBlock> {
  const runToBlock = new Map<string, PdfLayoutBlock>();
  for (const page of layout.pages) {
    for (const block of page.blocks) {
      for (const runId of block.runIds) {
        runToBlock.set(runId, block);
      }
    }
  }
  return runToBlock;
}

function toRunBlocks(
  runs: readonly PdfObservedTextRun[],
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): readonly PdfLayoutBlock[] {
  return dedupeById(
    runs
      .map((run) => runToBlock.get(run.id))
      .filter((block): block is PdfLayoutBlock => block !== undefined),
  );
}

function projectedTableOverlap(
  left: ProjectedTableCandidate,
  right: ProjectedTableCandidate,
): boolean {
  if (left.pageNumber !== right.pageNumber) {
    return false;
  }

  const leftIds = new Set(left.blockIds);
  return right.blockIds.some((blockId) => leftIds.has(blockId));
}

function dedupeProjectedTableCandidates(
  candidates: readonly ProjectedTableCandidate[],
): readonly ProjectedTableCandidate[] {
  const bestBySignature = new Map<string, ProjectedTableCandidate>();

  for (const candidate of candidates) {
    const signature = projectedTableSignature(candidate);
    const currentBest = bestBySignature.get(signature);
    if (!currentBest || compareProjectedTableCandidates(candidate, currentBest) < 0) {
      bestBySignature.set(signature, candidate);
    }
  }

  return [...bestBySignature.values()].sort((left, right) => {
    if (left.pageNumber !== right.pageNumber) {
      return left.pageNumber - right.pageNumber;
    }
    return compareProjectedTableCandidates(left, right);
  });
}

function projectedTableSignature(candidate: ProjectedTableCandidate): string {
  return candidate.headers
    .map((header) => normalizeCellText(header).toLowerCase())
    .join("|");
}

function compareProjectedTableCandidates(
  left: ProjectedTableCandidate,
  right: ProjectedTableCandidate,
): number {
  const leftCellCount = left.rows.reduce((sum, row) => sum + row.cells.length, 0);
  const rightCellCount = right.rows.reduce((sum, row) => sum + row.cells.length, 0);

  if (left.pageNumber !== right.pageNumber) {
    return left.pageNumber - right.pageNumber;
  }

  if (left.headers.length !== right.headers.length) {
    return right.headers.length - left.headers.length;
  }

  if (leftCellCount !== rightCellCount) {
    return rightCellCount - leftCellCount;
  }

  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  return 0;
}

function compareBlocksByX(left: AnchoredLayoutBlock, right: AnchoredLayoutBlock): number {
  if (left.anchor.x !== right.anchor.x) {
    return left.anchor.x - right.anchor.x;
  }
  return right.anchor.y - left.anchor.y;
}

function isHeaderRunText(text: string): boolean {
  const normalized = normalizeCellText(text);
  return normalized.length > 0 && normalized.length <= 24 && !normalized.includes(":") && !looksLikeNumericCell(normalized);
}

function isSequenceDataRunText(text: string): boolean {
  const normalized = normalizeCellText(text);
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }

  if (normalized.includes("\n")) {
    return false;
  }

  return !/[/:]/u.test(normalized) && !/\.(?:json|pdf)$/iu.test(normalized);
}

function looksLikeNumericCell(text: string): boolean {
  return /^[\d\s.,$()%+-]+$/u.test(text);
}

function normalizeCellText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function joinCellText(previousText: string, currentText: string): string {
  return `${previousText} ${normalizeCellText(currentText)}`.replaceAll(/\s+/g, " ").trim();
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values));
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return Array.from(new Set(values));
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function dedupeById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  const seenIds = new Set<string>();
  const deduped: T[] = [];
  for (const value of values) {
    if (seenIds.has(value.id)) {
      continue;
    }
    seenIds.add(value.id);
    deduped.push(value);
  }
  return deduped;
}

function serializeChunkBlocks(blocks: readonly PdfLayoutBlock[]): string {
  let text = "";

  for (const [blockIndex, block] of blocks.entries()) {
    const separator = blockIndex === 0 ? "" : (block.startsParagraph ? "\n\n" : "\n");
    text += `${separator}${block.text}`;
  }

  return text.trim();
}
