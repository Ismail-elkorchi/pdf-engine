import {
  buildKnowledgeProjectionTree,
  tableToProjectionRows,
} from "./projection-tree.ts";

import type {
  PdfKnowledgeChunk,
  PdfKnowledgeTable,
} from "../contracts.ts";
import type {
  KnowledgeProjectionNode,
  KnowledgeProjectionTableNode,
} from "./projection-tree.ts";
import type {
  KnowledgeProjectionItem,
} from "./projection-types.ts";

export function buildKnowledgeMarkdownFromProjectionItems(
  items: readonly KnowledgeProjectionItem[],
): string {
  return serializeKnowledgeProjectionTree(buildKnowledgeProjectionTree(items));
}

export function buildKnowledgeMarkdown(
  chunks: readonly PdfKnowledgeChunk[],
  tables: readonly PdfKnowledgeTable[],
): string {
  const chunkTexts = new Set(chunks.map((chunk) => normalizeMultilineText(chunk.text)));
  const tableItems: KnowledgeProjectionItem[] = tables
    .filter((table) => !chunkTexts.has(normalizeMultilineText(serializeKnowledgeTable(table))))
    .map((table) => ({ kind: "table", table }));
  return buildKnowledgeMarkdownFromProjectionItems([
    ...chunks.map((chunk) => ({ kind: "chunk" as const, chunk })),
    ...tableItems,
  ]);
}

export function serializeKnowledgeTable(table: PdfKnowledgeTable): string {
  return tableToProjectionRows(table)
    .map((row) => row.cells.map((cell) => normalizeCellText(cell.text)).filter((text) => text.length > 0).join(" | "))
    .filter((rowText) => rowText.length > 0)
    .join("\n");
}

function serializeKnowledgeProjectionTree(nodes: readonly KnowledgeProjectionNode[]): string {
  return nodes
    .map(serializeKnowledgeProjectionNode)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function serializeKnowledgeProjectionNode(node: KnowledgeProjectionNode): string {
  if (node.kind === "heading") {
    return `## ${escapeMarkdownInline(node.text)}`;
  }

  if (node.kind === "list") {
    return node.items.map((item) => `- ${escapeMarkdownInline(item)}`).join("\n");
  }

  if (node.kind === "table") {
    return serializeKnowledgeTableNode(node);
  }

  return normalizeMultilineText(node.text);
}

function serializeKnowledgeTableNode(node: KnowledgeProjectionTableNode): string {
  const rows = node.rows
    .map((row) => row.cells.map((cell) => normalizeCellText(cell.text)))
    .filter((cells) => cells.some((cell) => cell.length > 0));
  if (rows.length === 0) {
    return "";
  }

  const columnCount = rows[0]?.length ?? 0;
  if (rows.length < 2 || columnCount < 2 || rows.some((row) => row.length !== columnCount)) {
    return rows.map((row) => row.filter((cell) => cell.length > 0).map(escapeMarkdownInline).join(" | ")).join("\n");
  }

  const [header = [], ...body] = rows;
  return [
    `| ${header.map(escapeMarkdownInline).join(" | ")} |`,
    `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(escapeMarkdownInline).join(" | ")} |`),
  ].join("\n");
}

function normalizeMultilineText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => normalizeCellText(line))
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeCellText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function escapeMarkdownInline(text: string): string {
  return normalizeCellText(text)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|");
}
