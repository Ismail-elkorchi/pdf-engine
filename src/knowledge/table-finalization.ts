import {
  citationTextPresent,
  createKnowledgeSourceSpan,
  findSourceTextRange,
} from "./citations.ts";
import {
  createBlockFingerprint,
  createStableId,
  normalizeStableText,
} from "./stable-id.ts";

import type {
  PdfKnowledgeCitation,
  PdfKnowledgeTable,
  PdfKnowledgeTableCell,
  PdfLayoutBlock,
} from "../contracts.ts";
import type { ProjectedTableCandidate } from "./projection-types.ts";

export function finalizeProjectedTable(candidate: ProjectedTableCandidate): PdfKnowledgeTable {
  const tableId = createStableId(
    "table",
    [
      "knowledge-table",
      candidate.pageNumber,
      candidate.heuristic,
      candidate.headers.join("\u001f"),
      candidate.blockIds.join("\u001f"),
      candidate.rows.map((row) =>
        row.cells.map((cell) => `${cell.columnIndex}:${normalizeStableText(cell.text)}:${cell.runIds?.join(",") ?? ""}`).join("\u001e")
      ).join("\u001d"),
    ],
    [candidate.heuristic, candidate.pageNumber, candidate.headers.join(" ") || (candidate.blockIds[0] ?? "table")],
  );
  const cells: PdfKnowledgeTableCell[] = [];

  for (const [rowIndex, row] of candidate.rows.entries()) {
    for (const cell of row.cells) {
      cells.push({
        rowIndex,
        columnIndex: cell.columnIndex,
        text: cell.text,
        citations: createTableCellCitations(tableId, rowIndex, cell.columnIndex, cell.text, cell.blocks, cell.runIds),
      });
    }
  }

  return {
    id: tableId,
    pageNumber: candidate.pageNumber,
    headers: candidate.headers,
    heuristic: candidate.heuristic,
    blockIds: candidate.blockIds,
    confidence: candidate.confidence,
    cells,
  };
}

function createTableCellCitations(
  tableId: string,
  rowIndex: number,
  columnIndex: number,
  cellText: string,
  blocks: readonly PdfLayoutBlock[],
  runIds?: readonly string[],
): readonly PdfKnowledgeCitation[] {
  const runIdSet = runIds === undefined ? undefined : new Set(runIds);
  return blocks.flatMap((block) => {
    const citationText = selectTableCellCitationText(block, cellText);
    if (citationText === undefined) {
      return [];
    }
    const citedRunIds =
      runIdSet === undefined
        ? block.runIds
        : block.runIds.filter((runId) => runIdSet.has(runId));
    const sourceRange = findSourceTextRange(block.text, citationText);
    return [{
      id: createStableId(
        "citation",
        [
          "table-cell",
          tableId,
          rowIndex,
          columnIndex,
          normalizeStableText(citationText),
          createBlockFingerprint(block),
          citedRunIds.join(","),
        ],
        [`r${rowIndex}`, `c${columnIndex + 1}`, block.id, citationText],
      ),
      pageNumber: block.pageNumber,
      blockId: block.id,
      runIds: citedRunIds,
      text: citationText,
      ...(sourceRange === undefined ? {} : { sourceSpan: createKnowledgeSourceSpan(block, citationText, citedRunIds, sourceRange) }),
      ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
    }];
  });
}

function selectTableCellCitationText(block: PdfLayoutBlock, cellText: string): string | undefined {
  if (citationTextPresent(block.text, cellText)) {
    return cellText;
  }

  const normalizedCellText = normalizeStableText(cellText);
  const normalizedBlockText = normalizeStableText(block.text);
  if (normalizedBlockText.length > 0 && normalizedCellText.includes(normalizedBlockText)) {
    return block.text;
  }

  return block.text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => {
      const normalizedLine = normalizeStableText(line);
      return normalizedLine.length > 0 && normalizedCellText.includes(normalizedLine);
    });
}
