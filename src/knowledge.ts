import { buildKnowledgeChunks } from "./knowledge/chunks.ts";
import { assertKnowledgeCitationsResolvable } from "./knowledge/citations.ts";
import { buildKnowledgeMarkdown } from "./knowledge/markdown.ts";
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
  const chunks = buildKnowledgeChunks(layout, tables);
  const strategy: PdfKnowledgeStrategy =
    tables.length === 0 ? "layout-chunks" : "layout-chunks-and-heuristic-tables";
  const partialKnowledge = { chunks, tables };
  assertKnowledgeCitationsResolvable(layout, partialKnowledge);

  return {
    kind: "pdf-knowledge",
    strategy,
    chunks,
    tables,
    markdown: buildKnowledgeMarkdown(chunks, tables),
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
