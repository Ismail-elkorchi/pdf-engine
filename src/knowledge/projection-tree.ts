import type {
  PdfKnowledgeCitation,
  PdfKnowledgeChunk,
  PdfKnowledgeTable,
} from "../contracts.ts";
import type {
  KnowledgeProjectionItem,
} from "./projection-types.ts";

export type KnowledgeProjectionNode =
  | KnowledgeProjectionHeadingNode
  | KnowledgeProjectionListNode
  | KnowledgeProjectionParagraphNode
  | KnowledgeProjectionTableNode;

export interface KnowledgeProjectionHeadingNode {
  readonly kind: "heading";
  readonly text: string;
  readonly citations: readonly PdfKnowledgeCitation[];
}

export interface KnowledgeProjectionListNode {
  readonly kind: "list";
  readonly items: readonly string[];
  readonly citations: readonly PdfKnowledgeCitation[];
}

export interface KnowledgeProjectionParagraphNode {
  readonly kind: "paragraph";
  readonly text: string;
  readonly citations: readonly PdfKnowledgeCitation[];
}

export interface KnowledgeProjectionTableNode {
  readonly kind: "table";
  readonly sourceTableId?: string;
  readonly rows: readonly KnowledgeProjectionTableRowNode[];
  readonly citations: readonly PdfKnowledgeCitation[];
}

export interface KnowledgeProjectionTableRowNode {
  readonly cells: readonly KnowledgeProjectionTableCellNode[];
}

export interface KnowledgeProjectionTableCellNode {
  readonly text: string;
  readonly citations: readonly PdfKnowledgeCitation[];
}

export function buildKnowledgeProjectionTree(
  items: readonly KnowledgeProjectionItem[],
): readonly KnowledgeProjectionNode[] {
  return items.flatMap((item) => {
    if (item.kind === "table") {
      return tableToProjectionNode(item.table);
    }

    return chunkToProjectionNodes(item.chunk);
  });
}

export function tableToProjectionRows(table: PdfKnowledgeTable): readonly KnowledgeProjectionTableRowNode[] {
  const rowIndexes = dedupeNumbers(table.cells.map((cell) => cell.rowIndex));
  const columnIndexes = dedupeNumbers(table.cells.map((cell) => cell.columnIndex));
  return rowIndexes.map((rowIndex) => ({
    cells: columnIndexes.map((columnIndex) => {
      const cell = table.cells.find((candidate) =>
        candidate.rowIndex === rowIndex && candidate.columnIndex === columnIndex
      );
      return {
        text: normalizeProjectionText(cell?.text ?? ""),
        citations: cell?.citations ?? [],
      };
    }),
  }));
}

function tableToProjectionNode(table: PdfKnowledgeTable): readonly KnowledgeProjectionNode[] {
  const rows = tableToProjectionRows(table)
    .map((row) => ({
      cells: row.cells.filter((cell) => cell.text.length > 0),
    }))
    .filter((row) => row.cells.length > 0);
  if (rows.length === 0) {
    return [];
  }

  return [
    {
      kind: "table",
      sourceTableId: table.id,
      rows,
      citations: dedupeKnowledgeCitations(rows.flatMap((row) => row.cells.flatMap((cell) => cell.citations))),
    },
  ];
}

function chunkToProjectionNodes(chunk: PdfKnowledgeChunk): readonly KnowledgeProjectionNode[] {
  const text = normalizeMultilineProjectionText(chunk.text);
  if (text.length === 0) {
    return [];
  }

  const literalTableRows = parseLiteralTableRows(text);
  if (literalTableRows !== undefined) {
    return [
      {
        kind: "table",
        rows: literalTableRows,
        citations: chunk.citations,
      },
    ];
  }

  if (chunk.role === "heading") {
    return headingChunkToProjectionNodes(text, chunk.citations);
  }

  if (chunk.role === "list") {
    return [
      {
        kind: "list",
        items: text
          .split(/\n+/u)
          .map((line) => line.replace(/^[-*]\s*/u, "").trim())
          .filter((line) => line.length > 0),
        citations: chunk.citations,
      },
    ];
  }

  return [
    {
      kind: "paragraph",
      text,
      citations: chunk.citations,
    },
  ];
}

function headingChunkToProjectionNodes(
  text: string,
  citations: readonly PdfKnowledgeCitation[],
): readonly KnowledgeProjectionNode[] {
  const [heading = "", ...bodyLines] = text
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (heading.length === 0) {
    return [];
  }

  return [
    {
      kind: "heading",
      text: heading,
      citations,
    },
    ...(
      bodyLines.length === 0
        ? []
        : [{
          kind: "paragraph" as const,
          text: bodyLines.join("\n"),
          citations,
        }]
    ),
  ];
}

function parseLiteralTableRows(text: string): readonly KnowledgeProjectionTableRowNode[] | undefined {
  const rows = text
    .split(/\n+/u)
    .map((line) => line.split("|").map((cell) => normalizeProjectionText(cell)).filter((cell) => cell.length > 0))
    .filter((cells) => cells.length > 0);
  if (rows.length < 2) {
    return undefined;
  }

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount < 2 || rows.some((row) => row.length !== columnCount)) {
    return undefined;
  }

  return rows.map((cells) => ({
    cells: cells.map((cell) => ({
      text: cell,
      citations: [],
    })),
  }));
}

function normalizeMultilineProjectionText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => normalizeProjectionText(line))
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeProjectionText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dedupeKnowledgeCitations(citations: readonly PdfKnowledgeCitation[]): readonly PdfKnowledgeCitation[] {
  const seenIds = new Set<string>();
  const deduped: PdfKnowledgeCitation[] = [];
  for (const citation of citations) {
    if (seenIds.has(citation.id)) {
      continue;
    }
    seenIds.add(citation.id);
    deduped.push(citation);
  }
  return deduped;
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
