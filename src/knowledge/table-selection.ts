import { normalizeStableText } from "./stable-id.ts";

import type { ProjectedTableCandidate } from "./projection-types.ts";

export function projectedTableOverlap(
  left: ProjectedTableCandidate,
  right: ProjectedTableCandidate,
): boolean {
  if (left.pageNumber !== right.pageNumber) {
    return false;
  }

  const leftIds = new Set(left.blockIds);
  return right.blockIds.some((blockId) => leftIds.has(blockId));
}

export function dedupeProjectedTableCandidates(
  candidates: readonly ProjectedTableCandidate[],
): readonly ProjectedTableCandidate[] {
  const selectedBySignature = new Map<string, ProjectedTableCandidate>();

  for (const candidate of candidates) {
    const signature = projectedTableSignature(candidate);
    const currentSelection = selectedBySignature.get(signature);
    if (!currentSelection || compareProjectedTableCandidates(candidate, currentSelection) < 0) {
      selectedBySignature.set(signature, candidate);
    }
  }

  return [...selectedBySignature.values()].sort((left, right) => {
    if (left.pageNumber !== right.pageNumber) {
      return left.pageNumber - right.pageNumber;
    }
    return compareProjectedTableCandidates(left, right);
  });
}

function projectedTableSignature(candidate: ProjectedTableCandidate): string {
  return `${candidate.pageNumber}:${candidate.headers
    .map((header) => normalizeStableText(header).toLowerCase())
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
