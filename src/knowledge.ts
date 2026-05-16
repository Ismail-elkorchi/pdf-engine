import { buildKnowledgeChunksWithProjectionItems } from "./knowledge/chunks.ts";
import { assertKnowledgeCitationsResolvable } from "./knowledge/citations.ts";
import { buildKnowledgeForms } from "./knowledge/form-projection.ts";
import { buildKnowledgeMarkdownFromProjectionItems } from "./knowledge/markdown.ts";
import { buildKnowledgeTables } from "./knowledge/tables.ts";

import type {
  PdfKnownLimitCode,
  PdfKnowledgeDocument,
  PdfKnowledgeStrategy,
  PdfLayoutDocument,
  PdfObservedDocument,
} from "./contracts.ts";

export { assertKnowledgeCitationsResolvable } from "./knowledge/citations.ts";

export function buildKnowledgeDocument(
  layout: PdfLayoutDocument,
  observation?: PdfObservedDocument,
): PdfKnowledgeDocument {
  const tables = buildKnowledgeTables(layout, observation);
  const forms = buildKnowledgeForms(tables);
  const { chunks, projectionItems } = buildKnowledgeChunksWithProjectionItems(layout, tables);
  const strategy: PdfKnowledgeStrategy =
    tables.length === 0 ? "layout-chunks" : "layout-chunks-and-heuristic-tables";
  const partialKnowledge = { chunks, tables, forms };
  assertKnowledgeCitationsResolvable(layout, partialKnowledge);

  return {
    kind: "pdf-knowledge",
    strategy,
    chunks,
    tables,
    forms,
    markdown: buildKnowledgeMarkdownFromProjectionItems(projectionItems),
    extractedText: chunks.map((chunk) => chunk.text).join("\n\n"),
    knownLimits: dedupeKnownLimits(
      tables.length === 0
        ? [...layout.knownLimits, "knowledge-chunk-heuristic", "knowledge-markdown-heuristic", "table-projection-not-implemented"]
        : [...layout.knownLimits, "knowledge-chunk-heuristic", "knowledge-markdown-heuristic", "table-projection-heuristic"],
    ),
  };
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return [...new Set(values)].sort();
}
