import type {
  PdfKnowledgeTableHeuristic,
  PdfLayoutBlock,
  PdfObservedTextRun,
  PdfPoint,
} from "../contracts.ts";

export interface ProjectedTableCellSeed {
  readonly columnIndex: number;
  readonly text: string;
  readonly blocks: readonly PdfLayoutBlock[];
  readonly runIds?: readonly string[];
}

export interface ProjectedTableRowSeed {
  readonly cells: readonly ProjectedTableCellSeed[];
}

export interface CompactRunRowSeed {
  readonly run: PdfObservedTextRun;
  readonly cells: readonly string[];
}

export interface ProjectedTableCandidate {
  readonly pageNumber: number;
  readonly heuristic: PdfKnowledgeTableHeuristic;
  readonly headers: readonly string[];
  readonly blockIds: readonly string[];
  readonly confidence: number;
  readonly rows: readonly ProjectedTableRowSeed[];
}

export interface RowBand {
  readonly centerY: number;
  readonly blocks: readonly AnchoredLayoutBlock[];
}

export type AnchoredLayoutBlock = PdfLayoutBlock & { readonly anchor: PdfPoint };
