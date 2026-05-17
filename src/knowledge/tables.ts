import { collectProjectedTableCandidates } from "./table-candidates.ts";
import { finalizeProjectedTable } from "./table-finalization.ts";
import { dedupeProjectedTableCandidates } from "./table-selection.ts";

import type {
  PdfKnowledgeTable,
  PdfLayoutDocument,
  PdfObservedDocument,
} from "../contracts.ts";

export function buildKnowledgeTables(
  layout: PdfLayoutDocument,
  observation?: PdfObservedDocument,
): readonly PdfKnowledgeTable[] {
  return dedupeProjectedTableCandidates(
    collectProjectedTableCandidates(layout, observation),
  ).map(finalizeProjectedTable);
}
