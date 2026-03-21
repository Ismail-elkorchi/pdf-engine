import type { PdfKnowledgeChunk, PdfPipelineResult } from "./contracts.ts";

export type PdfViewerView = "page" | "reader";

export interface PdfViewerOptions {
  readonly initialPage?: number;
  readonly initialView?: PdfViewerView;
  readonly showTables?: boolean;
  readonly showBlockOutlines?: boolean;
  readonly showChunkAnchors?: boolean;
  readonly showSearch?: boolean;
  readonly showOutline?: boolean;
}

export interface PdfResolvedViewerOptions {
  readonly showTables: boolean;
  readonly showBlockOutlines: boolean;
  readonly showChunkAnchors: boolean;
  readonly showSearch: boolean;
  readonly showOutline: boolean;
}

export interface PdfViewerState {
  readonly pipelineResult: PdfPipelineResult;
  readonly options: PdfResolvedViewerOptions;
  readonly pageNumbers: readonly number[];
  readonly currentPageNumber: number;
  readonly currentView: PdfViewerView;
  readonly searchQuery: string;
  readonly activeChunkId: string | null;
}

export interface PdfViewerOutlineItem {
  readonly blockId: string;
  readonly pageNumber: number;
  readonly text: string;
}

export interface PdfViewerSearchResult {
  readonly id: string;
  readonly pageNumber: number;
  readonly kind: "block" | "chunk" | "table";
  readonly label: string;
  readonly text: string;
  readonly chunkId?: string;
}

export interface PdfViewerStateDefaults {
  readonly previousPageNumber?: number;
  readonly previousView?: PdfViewerView;
  readonly previousSearchQuery?: string;
  readonly previousActiveChunkId?: string | null;
}

/**
 * Repo-local viewer state helpers. These are intentionally kept separate from
 * DOM rendering so lower-layer tests can exercise navigation and search logic.
 */
export function resolveViewerOptions(
  currentOptions: PdfResolvedViewerOptions,
  nextOptions: PdfViewerOptions | undefined,
): PdfViewerOptions {
  if (nextOptions === undefined) {
    return currentOptions;
  }

  return {
    ...(nextOptions.initialPage === undefined ? {} : { initialPage: nextOptions.initialPage }),
    ...(nextOptions.initialView === undefined ? {} : { initialView: nextOptions.initialView }),
    showTables: nextOptions.showTables ?? currentOptions.showTables,
    showBlockOutlines: nextOptions.showBlockOutlines ?? currentOptions.showBlockOutlines,
    showChunkAnchors: nextOptions.showChunkAnchors ?? currentOptions.showChunkAnchors,
    showSearch: nextOptions.showSearch ?? currentOptions.showSearch,
    showOutline: nextOptions.showOutline ?? currentOptions.showOutline,
  };
}

export function createViewerState(
  pipelineResult: PdfPipelineResult,
  options: PdfViewerOptions,
  defaults: PdfViewerStateDefaults = {},
): PdfViewerState {
  const pageNumbers = collectPageNumbers(pipelineResult);
  const defaultPageNumber = options.initialPage ?? defaults.previousPageNumber ?? pageNumbers[0] ?? 1;

  return {
    pipelineResult,
    options: {
      showTables: options.showTables ?? false,
      showBlockOutlines: options.showBlockOutlines ?? false,
      showChunkAnchors: options.showChunkAnchors ?? false,
      showSearch: options.showSearch ?? false,
      showOutline: options.showOutline ?? false,
    },
    pageNumbers,
    currentPageNumber: clampPageNumber(defaultPageNumber, pageNumbers),
    currentView: options.initialView ?? defaults.previousView ?? "page",
    searchQuery: defaults.previousSearchQuery ?? "",
    activeChunkId: defaults.previousActiveChunkId ?? null,
  };
}

export function collectPageNumbers(pipelineResult: PdfPipelineResult): readonly number[] {
  const pageNumbers = new Set<number>();

  for (const page of pipelineResult.layout.value?.pages ?? []) {
    pageNumbers.add(page.pageNumber);
  }

  for (const table of pipelineResult.knowledge.value?.tables ?? []) {
    pageNumbers.add(table.pageNumber);
  }

  for (const chunk of pipelineResult.knowledge.value?.chunks ?? []) {
    for (const pageNumber of chunk.pageNumbers) {
      pageNumbers.add(pageNumber);
    }
  }

  return [...pageNumbers].sort((left, right) => left - right);
}

export function clampPageNumber(pageNumber: number, pageNumbers: readonly number[]): number {
  if (pageNumbers.length === 0) {
    return 1;
  }

  if (pageNumbers.includes(pageNumber)) {
    return pageNumber;
  }

  if (pageNumber < pageNumbers[0]!) {
    return pageNumbers[0]!;
  }

  return pageNumbers[pageNumbers.length - 1]!;
}

export function collectOutlineItems(
  pipelineResult: PdfPipelineResult,
): readonly PdfViewerOutlineItem[] {
  return (pipelineResult.layout.value?.pages ?? []).flatMap((page) =>
    page.blocks
      .filter((block) => block.role === "heading" && block.text.trim().length > 0)
      .map((block) => ({
        blockId: block.id,
        pageNumber: block.pageNumber,
        text: block.text,
      }))
  );
}

export function collectSearchResults(
  pipelineResult: PdfPipelineResult,
  query: string,
): readonly PdfViewerSearchResult[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const results: PdfViewerSearchResult[] = [];

  for (const page of pipelineResult.layout.value?.pages ?? []) {
    for (const block of page.blocks) {
      if (matchesSearch(block.text, normalizedQuery)) {
        results.push({
          id: `block:${block.id}`,
          pageNumber: block.pageNumber,
          kind: "block",
          label: `Page ${String(block.pageNumber)} • ${block.role}`,
          text: block.text,
        });
      }
    }
  }

  for (const chunk of pipelineResult.knowledge.value?.chunks ?? []) {
    if (matchesSearch(chunk.text, normalizedQuery)) {
      results.push({
        id: `chunk:${chunk.id}`,
        pageNumber: chunk.pageNumbers[0] ?? 1,
        kind: "chunk",
        label: `Chunk ${chunk.id} • page ${String(chunk.pageNumbers[0] ?? 1)}`,
        text: chunk.text,
        chunkId: chunk.id,
      });
    }
  }

  for (const table of pipelineResult.knowledge.value?.tables ?? []) {
    const flattenedTableText = [...(table.headers ?? []), ...table.cells.map((cell) => cell.text)].join(" ");
    if (matchesSearch(flattenedTableText, normalizedQuery)) {
      results.push({
        id: `table:${table.id}`,
        pageNumber: table.pageNumber,
        kind: "table",
        label: `Table ${table.id} • page ${String(table.pageNumber)}`,
        text: flattenedTableText,
      });
    }
  }

  return results;
}

export function findChunkById(
  pipelineResult: PdfPipelineResult,
  chunkId: string,
): PdfKnowledgeChunk | undefined {
  return (pipelineResult.knowledge.value?.chunks ?? []).find((chunk) => chunk.id === chunkId);
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchesSearch(text: string, normalizedQuery: string): boolean {
  return text.toLowerCase().includes(normalizedQuery);
}
