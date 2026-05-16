import type {
  PdfKnowledgeChunk,
  PdfKnowledgeTable,
} from "../contracts.ts";

export function buildKnowledgeMarkdown(
  chunks: readonly PdfKnowledgeChunk[],
  tables: readonly PdfKnowledgeTable[],
): string {
  const chunkTexts = chunks
    .map(serializeChunkMarkdown)
    .filter((text) => text.length > 0);
  const chunkSourceTexts = new Set(chunks.map((chunk) => normalizeMarkdownText(chunk.text)));
  const tableTexts = tables
    .map(serializeKnowledgeTable)
    .filter((text) => text.length > 0 && !chunkSourceTexts.has(normalizeMarkdownText(text)))
    .map((text) => serializeTableLikeMarkdown(text) ?? text);
  return [...chunkTexts, ...tableTexts]
    .join("\n\n");
}

export function serializeKnowledgeTable(table: PdfKnowledgeTable): string {
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

function serializeChunkMarkdown(chunk: PdfKnowledgeChunk): string {
  const text = normalizeMarkdownText(chunk.text);
  if (text.length === 0) {
    return "";
  }

  const tableMarkdown = serializeTableLikeMarkdown(text);
  if (tableMarkdown) {
    return tableMarkdown;
  }

  const lines = text.split(/\n+/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (chunk.role === "heading") {
    const [heading = "", ...bodyLines] = lines;
    return [`## ${heading}`, bodyLines.join("\n")].filter((part) => part.length > 0).join("\n\n");
  }
  if (chunk.role === "list") {
    return lines.map((line) => `- ${line.replace(/^[-*]\s*/u, "")}`).join("\n");
  }

  return text;
}

function serializeTableLikeMarkdown(text: string): string | undefined {
  const rows = text
    .split(/\n+/u)
    .map((line) => line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0))
    .filter((cells) => cells.length > 0);
  if (rows.length < 2) {
    return undefined;
  }

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount < 2 || rows.some((row) => row.length !== columnCount)) {
    return undefined;
  }

  const [header = [], ...body] = rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function normalizeMarkdownText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeCellText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
