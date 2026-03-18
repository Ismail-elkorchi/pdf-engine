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
const FIELD_VALUE_MIN_ROWS = 2;
const FIELD_LABEL_MIN_ROWS = 4;
const FIELD_LABEL_MAX_X_SPAN = 240;
const FORM_OPTION_TEXTS = new Set(["female", "male", "non-binary", "verified"]);
const CONTRACT_AWARD_HEADERS = ["Serial No.", "Contract Description", "Contractor", "Amount", "Remarks"] as const;
const CONTRACT_AWARD_MIN_ROWS = 2;

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
  const tables = buildKnowledgeTables(layout, observation);
  const chunks = buildKnowledgeChunks(layout, tables);
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

interface InlineKnowledgeTablePlan {
  readonly table: PdfKnowledgeTable;
  readonly pageNumber: number;
  readonly startReadingOrder: number;
}

function buildKnowledgeChunks(
  layout: PdfLayoutDocument,
  tables: readonly PdfKnowledgeTable[],
): readonly PdfKnowledgeChunk[] {
  const chunks: PdfKnowledgeChunk[] = [];
  let chunkIndex = 0;
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

    for (const plan of pagePlans.get(page.pageNumber) ?? []) {
      chunkIndex += 1;
      chunks.push(createProjectedTableChunk(chunkIndex, plan.table));
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

    const stackedHeaderCandidate =
      observationPage === undefined
        ? undefined
        : projectStackedHeaderSequenceTable(page, observationPage, runToBlock);
    if (
      stackedHeaderCandidate &&
      !candidates.some((candidate) => projectedTableOverlap(candidate, stackedHeaderCandidate))
    ) {
      candidates.push(stackedHeaderCandidate);
    }

    const contractAwardCandidate =
      observationPage === undefined
        ? undefined
        : projectContractAwardSequenceTable(page, observationPage, runToBlock);
    if (
      contractAwardCandidate &&
      !candidates.some((candidate) => projectedTableOverlap(candidate, contractAwardCandidate))
    ) {
      candidates.push(contractAwardCandidate);
    }

    const fieldValueCandidate = projectFieldValueFormTable(page);
    if (
      fieldValueCandidate &&
      !candidates.some((candidate) => projectedTableOverlap(candidate, fieldValueCandidate))
    ) {
      candidates.push(fieldValueCandidate);
    }

    const fieldLabelCandidate =
      observationPage === undefined
        ? undefined
        : projectFieldLabelFormTable(page, observationPage, runToBlock, fieldValueCandidate !== undefined);
    if (
      fieldLabelCandidate &&
      !candidates.some((candidate) => projectedTableOverlap(candidate, fieldLabelCandidate))
    ) {
      candidates.push(fieldLabelCandidate);
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

function createProjectedTableChunk(chunkIndex: number, table: PdfKnowledgeTable): PdfKnowledgeChunk {
  const sourceCitations = dedupeKnowledgeCitations(table.cells.flatMap((cell) => cell.citations));
  return {
    id: `chunk-${chunkIndex}`,
    text: serializeKnowledgeTable(table),
    role: "mixed",
    pageNumbers:
      sourceCitations.length === 0
        ? [table.pageNumber]
        : dedupeNumbers(sourceCitations.map((citation) => citation.pageNumber)),
    blockIds: dedupeStrings(table.blockIds),
    runIds: dedupeStrings(sourceCitations.flatMap((citation) => citation.runIds)),
    citations: sourceCitations.map((citation, citationIndex) => ({
      ...citation,
      id: `citation-${chunkIndex}-${citationIndex + 1}`,
    })),
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

function projectStackedHeaderSequenceTable(
  layoutPage: PdfLayoutPage,
  observationPage: PdfObservedPage,
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): ProjectedTableCandidate | undefined {
  const runs = observationPage.runs.filter((run) => normalizeCellText(run.text).length > 0);
  const headerGroup = findBestHeaderRunGroup(runs);
  if (!headerGroup) {
    return undefined;
  }

  const headerBlocks = dedupeById(
    headerGroup.runs
      .map((run) => runToBlock.get(run.id))
      .filter((block): block is PdfLayoutBlock => block !== undefined),
  );
  const headerTexts = expandStackedHeaderTexts(headerBlocks);
  if (headerTexts.length < ROW_SEQUENCE_MIN_HEADERS || headerTexts.length >= headerGroup.runs.length) {
    return undefined;
  }

  const dataRuns = collectSequenceDataRuns(runs, headerGroup.startIndex);
  if (dataRuns.length < headerTexts.length * 2 - 1) {
    return undefined;
  }

  const bodyRows = chunkSequenceRuns(dataRuns, headerTexts.length);
  if (bodyRows.length < ROW_SEQUENCE_MIN_ROWS || !looksLikeStackedHeaderBodyRows(bodyRows)) {
    return undefined;
  }

  const headerRow: ProjectedTableRowSeed = {
    cells: headerTexts.map((text, columnIndex) => ({
      columnIndex,
      text,
      blocks: headerBlocks,
    })),
  };
  const bodyRowSeeds = bodyRows.map((rowRuns) => ({
    cells: rowRuns.map((run, columnIndex) => ({
      columnIndex,
      text: normalizeCellText(run.text),
      blocks: toRunBlocks([run], runToBlock),
    })),
  }));
  const rows = [headerRow, ...bodyRowSeeds];

  return {
    pageNumber: layoutPage.pageNumber,
    heuristic: "stacked-header-sequence",
    headers: headerTexts,
    blockIds: dedupeStrings(rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => block.id)))),
    confidence: Number(Math.min(0.74, 0.48 + headerTexts.length * 0.03 + bodyRows.length * 0.025).toFixed(2)),
    rows,
  };
}

function projectFieldValueFormTable(page: PdfLayoutPage): ProjectedTableCandidate | undefined {
  const blocks = page.blocks.filter((block) => block.role !== "header" && block.role !== "footer");
  if (blocks.length < 3) {
    return undefined;
  }

  const rows: ProjectedTableRowSeed[] = [];
  const blockIds = new Set<string>();

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex] as PdfLayoutBlock;
    const inlineFieldValue = parseInlineFieldValueRow(block);
    if (inlineFieldValue) {
      rows.push(createFieldValueRow(inlineFieldValue.field, inlineFieldValue.value, [block]));
      blockIds.add(block.id);
      continue;
    }

    const label = parseFieldLabel(block.text);
    if (!label) {
      continue;
    }

    const nextBlock = blocks[blockIndex + 1];
    if (nextBlock === undefined || !looksLikeFieldValuePair(block, nextBlock)) {
      continue;
    }

    rows.push(createFieldValueRow(label, normalizeCellText(nextBlock.text), [block, nextBlock]));
    blockIds.add(block.id);
    blockIds.add(nextBlock.id);
    blockIndex += 1;
  }

  if (rows.length < FIELD_VALUE_MIN_ROWS) {
    return undefined;
  }

  const candidateRows: ProjectedTableRowSeed[] = [
    {
      cells: [
        { columnIndex: 0, text: "Field", blocks: [] },
        { columnIndex: 1, text: "Value", blocks: [] },
      ],
    },
    ...rows,
  ];

  return {
    pageNumber: page.pageNumber,
    heuristic: "field-value-form",
    headers: ["Field", "Value"],
    blockIds: [...blockIds],
    confidence: Number(Math.min(0.78, 0.52 + rows.length * 0.04).toFixed(2)),
    rows: candidateRows,
  };
}

function projectFieldLabelFormTable(
  page: PdfLayoutPage,
  observationPage: PdfObservedPage,
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
  hasFieldValueTable: boolean,
): ProjectedTableCandidate | undefined {
  const headerBlock = selectFormHeaderBlock(page.blocks);
  if (!headerBlock) {
    return undefined;
  }

  const seenLabels = new Set<string>();
  const rows: ProjectedTableRowSeed[] = [
    {
      cells: [
        {
          columnIndex: 0,
          text: normalizeCellText(headerBlock.text),
          blocks: [headerBlock],
        },
      ],
    },
  ];
  const blockIds = new Set<string>([headerBlock.id]);
  const canReuseHeadingFieldLabels = !hasFieldValueTable;

  for (const run of observationPage.runs) {
    const block = runToBlock.get(run.id);
    if (
      !block ||
      block.id === headerBlock.id ||
      block.role === "header" ||
      (block.role === "heading" && !(canReuseHeadingFieldLabels && looksLikeCompactHeadingFieldLabel(block.text))) ||
      (block.role === "footer" && !looksLikeFormFooterFieldCluster(block.text))
    ) {
      continue;
    }

    const labelText = normalizeStandaloneFormFieldLabel(run.text);
    if (!labelText || seenLabels.has(labelText)) {
      continue;
    }

    seenLabels.add(labelText);
    rows.push({
      cells: [
        {
          columnIndex: 0,
          text: labelText,
          blocks: toRunBlocks([run], runToBlock),
        },
      ],
    });
    blockIds.add(block.id);
  }

  if (rows.length - 1 < FIELD_LABEL_MIN_ROWS) {
    return undefined;
  }

  const labelAnchors = rows
    .slice(1)
    .flatMap((row) => row.cells)
    .flatMap((cell) => cell.blocks)
    .filter((block): block is AnchoredLayoutBlock => block.anchor !== undefined)
    .map((block) => block.anchor.x);
  if (labelAnchors.length > 0) {
    const xSpan = Math.max(...labelAnchors) - Math.min(...labelAnchors);
    if (xSpan > FIELD_LABEL_MAX_X_SPAN) {
      return undefined;
    }
  }

  const headerText = normalizeCellText(headerBlock.text);
  return {
    pageNumber: page.pageNumber,
    heuristic: "field-label-form",
    headers: [headerText],
    blockIds: [...blockIds],
    confidence: Number(Math.min(0.76, 0.48 + (rows.length - 1) * 0.03).toFixed(2)),
    rows,
  };
}

function projectContractAwardSequenceTable(
  layoutPage: PdfLayoutPage,
  observationPage: PdfObservedPage,
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): ProjectedTableCandidate | undefined {
  const headerEndIndex = findContractAwardHeaderEndIndex(observationPage.runs);
  if (headerEndIndex === undefined) {
    return undefined;
  }

  const bodyRows = collectContractAwardRows(observationPage.runs.slice(headerEndIndex + 1));
  if (bodyRows.length < CONTRACT_AWARD_MIN_ROWS) {
    return undefined;
  }

  const headerBlocks = toRunBlocks(observationPage.runs.slice(0, headerEndIndex + 1), runToBlock);
  const rows: ProjectedTableRowSeed[] = [
    {
      cells: CONTRACT_AWARD_HEADERS.map((header, columnIndex) => ({
        columnIndex,
        text: header,
        blocks: headerBlocks,
      })),
    },
  ];
  const blockIds = new Set<string>(headerBlocks.map((block) => block.id));

  for (const bodyRow of bodyRows) {
    const projectedRow = projectContractAwardRow(bodyRow, runToBlock);
    if (!projectedRow) {
      continue;
    }

    rows.push(projectedRow);
    for (const cell of projectedRow.cells) {
      for (const block of cell.blocks) {
        blockIds.add(block.id);
      }
    }
  }

  if (rows.length - 1 < CONTRACT_AWARD_MIN_ROWS) {
    return undefined;
  }

  return {
    pageNumber: layoutPage.pageNumber,
    heuristic: "contract-award-sequence",
    headers: [...CONTRACT_AWARD_HEADERS],
    blockIds: [...blockIds],
    confidence: Number(Math.min(0.81, 0.54 + (rows.length - 1) * 0.03).toFixed(2)),
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

function findContractAwardHeaderEndIndex(runs: readonly PdfObservedTextRun[]): number | undefined {
  const headerWindow = runs.slice(0, 32).map((run) => normalizeCellText(run.text)).join(" ").toLowerCase();
  if (
    !headerWindow.includes("serial no.") ||
    !headerWindow.includes("contract description") ||
    !headerWindow.includes("remarks")
  ) {
    return undefined;
  }

  const firstRowIndex = runs.findIndex((run, index) =>
    index > 0 && looksLikeContractAwardRowStart(normalizeCellText(run.text))
  );
  return firstRowIndex <= 0 ? undefined : firstRowIndex - 1;
}

function collectContractAwardRows(
  runs: readonly PdfObservedTextRun[],
): readonly (readonly PdfObservedTextRun[])[] {
  const rows: PdfObservedTextRun[][] = [];
  let currentRow: PdfObservedTextRun[] = [];

  for (const run of runs) {
    const text = normalizeCellText(run.text);
    if (text.length === 0) {
      continue;
    }

    if (looksLikeContractAwardRowStart(text)) {
      if (currentRow.length > 0) {
        rows.push(currentRow);
      }
      currentRow = [run];
      continue;
    }

    if (currentRow.length === 0) {
      continue;
    }

    currentRow.push(run);
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows.filter((row) => row.length >= 4);
}

function projectContractAwardRow(
  rowRuns: readonly PdfObservedTextRun[],
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): ProjectedTableRowSeed | undefined {
  const rowStartText = normalizeCellText(rowRuns[0]?.text ?? "");
  const rowStartParts = rowStartText.split(/\s+/u);
  const serialNumber = rowStartParts[0];
  const descriptionStart = rowStartParts.slice(1).join(" ");
  if (!serialNumber || !/^\d{1,3}$/u.test(serialNumber) || descriptionStart.length === 0) {
    return undefined;
  }

  const descriptionParts = [descriptionStart];
  let runIndex = 1;
  while (runIndex < rowRuns.length) {
    const text = normalizeCellText(rowRuns[runIndex]?.text ?? "");
    if (text.length === 0) {
      runIndex += 1;
      continue;
    }

    if (looksLikeContractCodeRun(text) || looksLikeAwardAmountRun(text)) {
      break;
    }

    descriptionParts.push(text);
    runIndex += 1;
  }

  while (runIndex < rowRuns.length && looksLikeContractCodeRun(normalizeCellText(rowRuns[runIndex]?.text ?? ""))) {
    runIndex += 1;
  }

  const contractorRuns: PdfObservedTextRun[] = [];
  while (runIndex < rowRuns.length) {
    const text = normalizeCellText(rowRuns[runIndex]?.text ?? "");
    if (text.length === 0) {
      runIndex += 1;
      continue;
    }

    if (looksLikeAwardAmountRun(text) || looksLikeContractAwardRemark(text)) {
      break;
    }

    contractorRuns.push(rowRuns[runIndex] as PdfObservedTextRun);
    runIndex += 1;
  }

  const trailerText = rowRuns.slice(runIndex).map((run) => normalizeCellText(run.text)).join(" ");
  const descriptionText = normalizeCellText(descriptionParts.join(" "));
  const contractorText = normalizeContractAwardContractor(
    contractorRuns.map((run) => normalizeCellText(run.text)).join(" "),
  );
  const amountText = extractContractAwardAmount(trailerText);
  const remarkText = extractContractAwardRemark(trailerText);
  if (!descriptionText || !contractorText || !amountText || !remarkText) {
    return undefined;
  }

  const rowBlocks = toRunBlocks(rowRuns, runToBlock);
  return {
    cells: [
      { columnIndex: 0, text: serialNumber, blocks: rowBlocks },
      { columnIndex: 1, text: descriptionText, blocks: rowBlocks },
      { columnIndex: 2, text: contractorText, blocks: rowBlocks },
      { columnIndex: 3, text: amountText, blocks: rowBlocks },
      { columnIndex: 4, text: remarkText, blocks: rowBlocks },
    ],
  };
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

function expandStackedHeaderTexts(
  headerBlocks: readonly PdfLayoutBlock[],
): readonly string[] {
  const orderedBlocks = headerBlocks
    .filter((block): block is AnchoredLayoutBlock => block.anchor !== undefined)
    .sort(compareBlocksByX);
  if (orderedBlocks.length < 2) {
    return [];
  }

  const multilineBlock = orderedBlocks.find((block) => block.text.includes("\n"));
  if (!multilineBlock) {
    return [];
  }

  const headerTexts: string[] = [];
  for (const block of orderedBlocks) {
    const lines = block.text
      .split(/\n+/u)
      .map((line) => normalizeCellText(line))
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }

    if (block.id === multilineBlock.id) {
      headerTexts.push(...mergeStackedHeaderLines(lines));
      continue;
    }

    headerTexts.push(lines[0] as string);
  }

  return headerTexts.filter((text) => !looksLikeNumericCell(text));
}

function mergeStackedHeaderLines(lines: readonly string[]): readonly string[] {
  if (lines.length >= 4 && shouldMergeLeadingHeaderLines(lines[0], lines[1])) {
    return [joinCellText(lines[0] as string, lines[1] as string), ...lines.slice(2)];
  }

  return lines;
}

function shouldMergeLeadingHeaderLines(
  firstLine: string | undefined,
  secondLine: string | undefined,
): boolean {
  if (firstLine === undefined || secondLine === undefined) {
    return false;
  }

  if (firstLine.length === 0 || secondLine.length === 0) {
    return false;
  }

  if (looksLikeNumericCell(firstLine) || looksLikeNumericCell(secondLine)) {
    return false;
  }

  return firstLine.length <= 24 && secondLine.length <= 24;
}

function looksLikeStackedHeaderBodyRows(
  rows: readonly (readonly PdfObservedTextRun[])[],
): boolean {
  return rows.every((row, rowIndex) => {
    const firstCell = normalizeCellText(row[0]?.text ?? "");
    const secondCell = normalizeCellText(row[1]?.text ?? "");
    if (!looksLikeNumericCell(firstCell)) {
      return false;
    }

    if (secondCell.length === 0 || looksLikeNumericCell(secondCell)) {
      return false;
    }

    if (rowIndex === rows.length - 1) {
      return row.length >= 3;
    }

    return row.length >= 4;
  });
}

function parseInlineFieldValueRow(
  block: PdfLayoutBlock,
): { readonly field: string; readonly value: string } | undefined {
  const normalizedText = normalizeCellText(block.text);
  if (normalizedText.length === 0) {
    return undefined;
  }

  const colonCount = [...normalizedText].filter((character) => character === ":").length;
  if (colonCount !== 1) {
    return undefined;
  }

  const colonIndex = normalizedText.lastIndexOf(":");
  if (colonIndex < 0) {
    return undefined;
  }

  const field = stripFieldPrefix(normalizedText.slice(0, colonIndex));
  const value = normalizeCellText(normalizedText.slice(colonIndex + 1));
  if (!field || !value || looksLikeUrlSchemeField(field) || !looksLikeFieldValueText(value)) {
    return undefined;
  }

  return { field, value };
}

function parseFieldLabel(text: string): string | undefined {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || !normalizedText.endsWith(":")) {
    return undefined;
  }

  const field = stripFieldPrefix(normalizedText.slice(0, -1));
  if (!field || looksLikeNumericCell(field)) {
    return undefined;
  }

  return field;
}

function stripFieldPrefix(text: string): string {
  return text.replace(/^\*\s*/u, "").trim();
}

function looksLikeUrlSchemeField(text: string): boolean {
  const compact = normalizeCellText(text).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
  return /^(?:https?|ftp)$/u.test(compact);
}

function looksLikeFieldValuePair(
  labelBlock: PdfLayoutBlock,
  valueBlock: PdfLayoutBlock,
): boolean {
  const label = parseFieldLabel(labelBlock.text);
  const value = normalizeCellText(valueBlock.text);
  if (
    !label ||
    value.length === 0 ||
    parseFieldLabel(valueBlock.text) ||
    parseInlineFieldValueRow(valueBlock)
  ) {
    return false;
  }

  if (!looksLikeFieldValueText(value)) {
    return false;
  }

  const labelAnchor = labelBlock.anchor;
  const valueAnchor = valueBlock.anchor;
  if (labelAnchor === undefined || valueAnchor === undefined) {
    return false;
  }

  const sameColumn = Math.abs(labelAnchor.x - valueAnchor.x) <= 12;
  const closeInFlow = labelAnchor.y - valueAnchor.y <= 40 && labelAnchor.y > valueAnchor.y;
  return sameColumn && closeInFlow;
}

function looksLikeFieldValueText(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 96) {
    return false;
  }

  if (normalizedText.endsWith(":")) {
    return false;
  }

  return !/^(?:\*?\s*)?(?:\d+\.\s+)?[A-Z][^:]{0,80}:$/u.test(normalizedText);
}

function selectFormHeaderBlock(blocks: readonly PdfLayoutBlock[]): PdfLayoutBlock | undefined {
  const candidates = blocks.filter((block) => {
    const normalizedText = normalizeCellText(block.text);
    if (block.role !== "heading" || normalizedText.length === 0 || normalizedText.length > 80) {
      return false;
    }

    if (
      looksLikeNumericCell(normalizedText) ||
      looksLikePageMarkerText(normalizedText) ||
      looksLikeFormMetadataText(normalizedText) ||
      normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length < 2 ||
      ((block.fontSize ?? 0) < 18 && normalizeStandaloneFormFieldLabel(normalizedText) !== undefined)
    ) {
      return false;
    }

    return true;
  });

  return candidates.sort((left, right) => {
    const leftFontSize = left.fontSize ?? 0;
    const rightFontSize = right.fontSize ?? 0;
    if (leftFontSize !== rightFontSize) {
      return rightFontSize - leftFontSize;
    }
    return left.readingOrder - right.readingOrder;
  })[0];
}

function normalizeStandaloneFormFieldLabel(text: string): string | undefined {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 64) {
    return undefined;
  }

  if (
    looksLikeFormMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText) ||
    looksLikeNumericCell(normalizedText)
  ) {
    return undefined;
  }

  const lowerText = normalizedText.toLowerCase();
  if (FORM_OPTION_TEXTS.has(lowerText)) {
    return undefined;
  }

  if (looksLikeNumberedFormPromptLabel(normalizedText)) {
    return undefined;
  }

  if (normalizedText.endsWith(":")) {
    const fieldText = stripFieldPrefix(normalizedText.slice(0, -1));
    return fieldText.length === 0 ? undefined : `${fieldText}:`;
  }

  if (/[.!?]$/.test(normalizedText) || /\d/u.test(normalizedText)) {
    return undefined;
  }

  const words = normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0 || words.length > 5 || !/[\p{Ll}]/u.test(normalizedText)) {
    return undefined;
  }

  if (looksLikeSentenceCaseFormFieldLabel(words)) {
    return normalizedText;
  }

  if (!words.every((word) => isHeadingWord(word))) {
    return undefined;
  }

  return normalizedText;
}

function looksLikeNumberedFormPromptLabel(text: string): boolean {
  return /^\d+(?:\.\d+)*[.)]\s+/u.test(text);
}

function looksLikeCompactHeadingFieldLabel(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (
    !normalizedText.endsWith(":") ||
    normalizedText.length > 32 ||
    looksLikeNumberedFormPromptLabel(normalizedText) ||
    looksLikeFormMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText)
  ) {
    return false;
  }

  const words = normalizedText
    .slice(0, -1)
    .split(/\s+/u)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length >= 1 && words.length <= 3;
}

function looksLikeFormFooterFieldCluster(text: string): boolean {
  const lines = text
    .split(/\n+/u)
    .map((line) => normalizeCellText(line))
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return false;
  }

  return lines.some((line) => parseFieldLabel(line) !== undefined) &&
    lines.some((line) => FORM_OPTION_TEXTS.has(line.toLowerCase()));
}

function looksLikeFormMetadataText(text: string): boolean {
  return /^(?:created:|optimized\b|pdfcpu:|pr\. name:|source:|testdata\/)/iu.test(text);
}

function looksLikePageMarkerText(text: string): boolean {
  return /^page \d+ of \d+$/iu.test(text);
}

function isHeadingWord(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  if (normalized.length === 0) {
    return false;
  }

  return /^[\p{Lu}\p{Lt}\p{N}][\p{L}\p{N}'’/-]*$/u.test(normalized) ||
    /^(?:a|an|and|as|at|by|de|for|from|in|into|of|on|or|the|to|und|von|with)$/iu.test(normalized);
}

function looksLikeSentenceCaseFormFieldLabel(words: readonly string[]): boolean {
  const [firstWord, ...remainingWords] = words;
  if (firstWord === undefined || !startsWithUppercaseLetter(firstWord)) {
    return false;
  }

  return remainingWords.every((word) => {
    if (/^(?:a|an|and|as|at|by|de|for|from|in|into|of|on|or|the|to|und|von|with)$/iu.test(word)) {
      return true;
    }

    return /^[\p{Ll}][\p{L}\p{N}'’/-]*$/u.test(word) || isHeadingWord(word);
  });
}

function startsWithUppercaseLetter(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  return /^[\p{Lu}\p{Lt}]/u.test(normalized);
}

function normalizeContractAwardContractor(text: string): string {
  let normalizedText = normalizeCellText(text).replace(/^Shopping\s+/u, "");
  normalizedText = normalizedText.replace(/\b(?:P\.?\s?O\.?\s?Box|PR Box|Box)\b.*$/iu, "").trim();
  const companyMatch = normalizedText.match(
    /^(.+?\b(?:Limited|Ltd|Ltd\.|Company|Companies|Enterprise|Enterprises|Centre|Services|Systems|Press)\b)/u,
  );
  if (companyMatch?.[1]) {
    return companyMatch[1];
  }

  return normalizedText;
}

function createFieldValueRow(
  field: string,
  value: string,
  blocks: readonly PdfLayoutBlock[],
): ProjectedTableRowSeed {
  return {
    cells: [
      {
        columnIndex: 0,
        text: field,
        blocks,
      },
      {
        columnIndex: 1,
        text: value,
        blocks,
      },
    ],
  };
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

function serializeKnowledgeTable(table: PdfKnowledgeTable): string {
  const rowIndexes = [...dedupeNumbers(table.cells.map((cell) => cell.rowIndex))].sort(
    (left: number, right: number) => left - right,
  );
  const serializedRows = rowIndexes.map((rowIndex: number) => {
    const rowCells = table.cells
      .filter((cell) => cell.rowIndex === rowIndex)
      .sort((left, right) => left.columnIndex - right.columnIndex)
      .map((cell) => normalizeCellText(cell.text))
      .filter((text) => text.length > 0);
    return rowCells.join(" | ");
  });

  return serializedRows.filter((rowText: string) => rowText.length > 0).join("\n");
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
  return `${candidate.pageNumber}:${candidate.headers
    .map((header) => normalizeCellText(header).toLowerCase())
    .join("|")}`;
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

function looksLikeContractAwardRowStart(text: string): boolean {
  return /^\d{1,3}\s+\S/u.test(text);
}

function looksLikeContractCodeRun(text: string): boolean {
  return /^(?:[A-Z]{2,}\/){2,}[A-Z0-9/‐-]+$/u.test(text) || /^[‐-][A-Z0-9/\s]+$/u.test(text);
}

function looksLikeAwardAmountRun(text: string): boolean {
  return /\d[\d,.]*\s*(?:GHS|GHȻ|GBP|USD|EUR|£)/u.test(text);
}

function extractContractAwardAmount(text: string): string | undefined {
  const match = text.match(/\d[\d,.]*\s*(?:GHS|GHȻ|GBP|USD|EUR|£)/u);
  return match?.[0];
}

function extractContractAwardRemark(text: string): string | undefined {
  const match = text.match(/\b(?:Completed|Awarded|Cancelled|Ongoing)\b/iu);
  return match?.[0];
}

function looksLikeContractAwardRemark(text: string): boolean {
  return extractContractAwardRemark(text) !== undefined;
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
    const normalizedBlockText = block.text.replaceAll(/\s+/g, " ").trim();
    if (normalizedBlockText.length === 0) {
      continue;
    }
    const separator = blockIndex === 0 ? "" : (block.startsParagraph ? "\n\n" : " ");
    text += `${separator}${normalizedBlockText}`;
  }

  return text.trim();
}
