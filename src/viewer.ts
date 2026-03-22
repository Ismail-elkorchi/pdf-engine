import {
  clampPageNumber,
  collectOutlineItems,
  collectRenderSelectionMatches,
  collectSearchResults,
  createViewerState,
  findChunkById,
  findRenderPageByNumber,
  resolveViewerOptions,
  type PdfViewerOptions,
  type PdfViewerOutlineItem,
  type PdfViewerSearchResult,
  type PdfViewerState,
  type PdfViewerView,
} from "./viewer-state.ts";

import type {
  PdfBoundingBox,
  PdfKnowledgeChunk,
  PdfKnowledgeTable,
  PdfLayoutBlock,
  PdfLayoutPage,
  PdfPipelineResult,
  PdfRenderPage,
  PdfRenderSelectionUnit,
} from "./contracts.ts";

export type { PdfViewerOptions, PdfViewerView } from "./viewer-state.ts";

export interface PdfViewerHandle {
  goToPage(pageNumber: number): void;
  goToChunk(chunkId: string): void;
  setView(view: PdfViewerView): void;
  setSearchQuery(query: string): void;
  update(pipelineResult: PdfPipelineResult, options?: PdfViewerOptions): void;
  destroy(): void;
}

interface PdfViewerActions {
  readonly goToPage: (pageNumber: number) => void;
  readonly goToChunk: (chunkId: string) => void;
  readonly setView: (view: PdfViewerView) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly update: (pipelineResult: PdfPipelineResult, options?: PdfViewerOptions) => void;
}

const VIEWER_STYLE = `
.pdf-engine-viewer {
  color: #112133;
  background: linear-gradient(180deg, #f8faf7 0%, #eef2eb 100%);
  border: 1px solid #d6ded5;
  border-radius: 18px;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
  overflow: hidden;
}

.pdf-engine-viewer__toolbar {
  align-items: flex-start;
  background: rgba(255, 255, 255, 0.82);
  border-bottom: 1px solid #d6ded5;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  justify-content: space-between;
  padding: 14px 18px;
}

.pdf-engine-viewer__toolbar-group {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pdf-engine-viewer__controls {
  display: flex;
  gap: 8px;
}

.pdf-engine-viewer__button {
  background: #17324d;
  border: 0;
  border-radius: 999px;
  color: #f8faf7;
  cursor: pointer;
  font: inherit;
  padding: 8px 14px;
}

.pdf-engine-viewer__button[disabled] {
  background: #8b98a5;
  cursor: default;
}

.pdf-engine-viewer__button[aria-pressed="true"] {
  background: #6f8d52;
}

.pdf-engine-viewer__search {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pdf-engine-viewer__search-label,
.pdf-engine-viewer__label {
  color: #26415b;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
}

.pdf-engine-viewer__search-input {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #c5d2bf;
  border-radius: 999px;
  color: #112133;
  font: inherit;
  min-width: 220px;
  padding: 8px 12px;
}

.pdf-engine-viewer__layout {
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  padding: 18px;
}

.pdf-engine-viewer__page,
.pdf-engine-viewer__reader {
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid #d6ded5;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 360px;
  padding: 20px;
}

.pdf-engine-viewer__render-stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pdf-engine-viewer__render-meta {
  color: #5d6c7a;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 0.84rem;
  letter-spacing: 0.02em;
  margin: 0;
}

.pdf-engine-viewer__render-surface {
  background: #ffffff;
  border: 1px solid #d6ded5;
  border-radius: 16px;
  overflow: hidden;
  position: relative;
}

.pdf-engine-viewer__render-image {
  display: block;
  height: auto;
  max-width: 100%;
  width: 100%;
}

.pdf-engine-viewer__render-overlay {
  inset: 0;
  pointer-events: none;
  position: absolute;
}

.pdf-engine-viewer__render-highlight {
  background: rgba(246, 217, 110, 0.28);
  border: 2px solid rgba(188, 164, 107, 0.92);
  border-radius: 8px;
  box-sizing: border-box;
  position: absolute;
}

.pdf-engine-viewer__render-highlight[data-shape="point"] {
  background: rgba(246, 217, 110, 0.92);
  border-radius: 999px;
  height: 12px;
  transform: translate(-50%, -50%);
  width: 12px;
}

.pdf-engine-viewer__render-fallback {
  align-items: center;
  background: #fff8e6;
  border: 1px solid #ead9af;
  border-radius: 12px;
  color: #6a5631;
  display: inline-flex;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 0.86rem;
  gap: 8px;
  padding: 10px 12px;
}

.pdf-engine-viewer__reader-page {
  background: rgba(248, 250, 247, 0.85);
  border: 1px solid #d6ded5;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
}

.pdf-engine-viewer__reader-page-label {
  color: #5d6c7a;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  margin: 0;
  text-transform: uppercase;
}

.pdf-engine-viewer__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pdf-engine-viewer__section-title {
  color: #17324d;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0;
  text-transform: uppercase;
}

.pdf-engine-viewer__blocks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pdf-engine-viewer__block {
  background: #fffdf7;
  border-left: 4px solid #c5d2bf;
  border-radius: 12px;
  box-shadow: 0 1px 0 rgba(17, 33, 51, 0.06);
  padding: 12px 14px;
}

.pdf-engine-viewer__block[data-role="heading"] {
  border-left-color: #17324d;
  font-weight: 700;
}

.pdf-engine-viewer__block[data-role="list"] {
  border-left-color: #6f8d52;
}

.pdf-engine-viewer__block[data-role="header"],
.pdf-engine-viewer__block[data-role="footer"] {
  border-left-color: #bca46b;
  opacity: 0.85;
}

.pdf-engine-viewer__block-meta {
  color: #5d6c7a;
  display: flex;
  flex-wrap: wrap;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 0.78rem;
  gap: 10px;
  letter-spacing: 0.02em;
  margin-bottom: 6px;
}

.pdf-engine-viewer__block-text,
.pdf-engine-viewer__action-text {
  line-height: 1.55;
  white-space: pre-wrap;
}

.pdf-engine-viewer__table-wrap {
  overflow-x: auto;
}

.pdf-engine-viewer__table {
  border-collapse: collapse;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 0.92rem;
  min-width: 100%;
}

.pdf-engine-viewer__table th,
.pdf-engine-viewer__table td {
  border: 1px solid #d6ded5;
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.pdf-engine-viewer__table th {
  background: #eef2eb;
}

.pdf-engine-viewer__sidebar {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.pdf-engine-viewer__panel {
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid #d6ded5;
  border-radius: 16px;
  padding: 16px;
}

.pdf-engine-viewer__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.pdf-engine-viewer__list-item {
  background: #f7f4ea;
  border-radius: 12px;
  color: #17324d;
  padding: 10px 12px;
}

.pdf-engine-viewer__list-item[data-active="true"] {
  box-shadow: inset 0 0 0 2px #6f8d52;
}

.pdf-engine-viewer__list-item small {
  color: #5d6c7a;
  display: block;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  margin-bottom: 4px;
}

.pdf-engine-viewer__action {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: block;
  font: inherit;
  padding: 0;
  text-align: left;
  width: 100%;
}

.pdf-engine-viewer__empty {
  color: #5d6c7a;
  font-style: italic;
  margin: 0;
}

.pdf-engine-viewer__highlight {
  background: #f6d96e;
  border-radius: 0.18em;
  color: #112133;
  padding: 0 0.08em;
}

@media (max-width: 960px) {
  .pdf-engine-viewer__layout {
    grid-template-columns: 1fr;
  }
}
`;

/**
 * Renders a browser-only document viewer for a previously computed pipeline result.
 *
 * The viewer does not re-parse the source document. Page view prefers canonical
 * render artifacts per page and falls back explicitly to staged layout only when a
 * page is not render-backed yet. Reader view continues to reuse staged layout and
 * knowledge artifacts.
 *
 * @param container Browser DOM element that will own the viewer subtree.
 * @param pipelineResult Existing staged pipeline result to visualize.
 * @param options Optional viewer toggles, initial-page selection, and initial view mode.
 * @returns Handle that can navigate, switch modes, search, refresh, or destroy the viewer.
 */
export function renderPdfViewer(
  container: HTMLElement,
  pipelineResult: PdfPipelineResult,
  options: PdfViewerOptions = {},
): PdfViewerHandle {
  const ownerDocument = container.ownerDocument;
  if (!ownerDocument?.defaultView?.HTMLElement) {
    throw new Error("pdf-engine viewer requires a browser-like DOM environment.");
  }

  let state = createViewerState(pipelineResult, options);

  const actions: PdfViewerActions = {
    goToPage,
    goToChunk,
    setView,
    setSearchQuery,
    update,
  };

  function render(): void {
    container.replaceChildren(buildViewerRoot(ownerDocument, state, actions));
  }

  function goToPage(pageNumber: number): void {
    state = {
      ...state,
      currentPageNumber: clampPageNumber(pageNumber, state.pageNumbers),
    };
    render();
  }

  function goToChunk(chunkId: string): void {
    const chunk = findChunkById(state.pipelineResult, chunkId);
    if (!chunk) {
      return;
    }

    state = {
      ...state,
      currentPageNumber: clampPageNumber(chunk.pageNumbers[0] ?? state.currentPageNumber, state.pageNumbers),
      activeChunkId: chunk.id,
    };
    render();
  }

  function setView(view: PdfViewerView): void {
    state = {
      ...state,
      currentView: view,
    };
    render();
  }

  function setSearchQuery(query: string): void {
    state = {
      ...state,
      searchQuery: query,
    };
    render();
  }

  function update(nextPipelineResult: PdfPipelineResult, nextOptions?: PdfViewerOptions): void {
    state = createViewerState(nextPipelineResult, resolveViewerOptions(state.options, nextOptions), {
      previousPageNumber: state.currentPageNumber,
      previousView: state.currentView,
      previousSearchQuery: state.searchQuery,
      previousActiveChunkId: state.activeChunkId,
    });
    render();
  }

  function destroy(): void {
    container.replaceChildren();
  }

  render();

  return {
    goToPage,
    goToChunk,
    setView,
    setSearchQuery,
    update,
    destroy,
  };
}

function buildViewerRoot(
  ownerDocument: Document,
  state: PdfViewerState,
  actions: PdfViewerActions,
): HTMLElement {
  const currentRenderPage = findRenderPageByNumber(state.pipelineResult, state.currentPageNumber);
  const currentRenderHighlights = collectRenderSelectionMatches(
    state.pipelineResult,
    state.currentPageNumber,
    state.searchQuery,
  );
  const currentLayoutPage = state.pipelineResult.layout.value?.pages.find(
    (page) => page.pageNumber === state.currentPageNumber,
  );
  const currentTables = (state.pipelineResult.knowledge.value?.tables ?? []).filter(
    (table) => table.pageNumber === state.currentPageNumber,
  );
  const currentChunks = (state.pipelineResult.knowledge.value?.chunks ?? []).filter((chunk) =>
    chunk.pageNumbers.includes(state.currentPageNumber),
  );
  const currentPageIndex = state.pageNumbers.indexOf(state.currentPageNumber);
  const outlineItems = collectOutlineItems(state.pipelineResult);
  const searchResults = collectSearchResults(state.pipelineResult, state.searchQuery);

  const root = createElement(ownerDocument, "section", "pdf-engine-viewer");
  root.dataset["viewerCurrentView"] = state.currentView;
  root.append(createStyleElement(ownerDocument));
  root.append(createToolbar(ownerDocument, state, currentPageIndex, searchResults.length, actions));

  const layout = createElement(ownerDocument, "div", "pdf-engine-viewer__layout");
  if (state.currentView === "reader") {
    layout.append(
      createReaderPanel(
        ownerDocument,
        state.pipelineResult,
        state.pageNumbers,
        state.options.showTables,
        state.searchQuery,
      ),
    );
  } else {
    layout.append(
      createPagePanel(
        ownerDocument,
        currentRenderPage,
        currentRenderHighlights,
        currentLayoutPage,
        currentTables,
        state.options.showTables,
        state.searchQuery,
      ),
    );
  }

  layout.append(
    createSidebar(ownerDocument, state, currentLayoutPage, currentChunks, outlineItems, searchResults, actions),
  );
  root.append(layout);

  return root;
}

function createStyleElement(ownerDocument: Document): HTMLStyleElement {
  const style = ownerDocument.createElement("style");
  style.textContent = VIEWER_STYLE;
  return style;
}

function createToolbar(
  ownerDocument: Document,
  state: PdfViewerState,
  currentPageIndex: number,
  searchResultCount: number,
  actions: PdfViewerActions,
): HTMLElement {
  const toolbar = createElement(ownerDocument, "header", "pdf-engine-viewer__toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "PDF reader controls");

  const navigationGroup = createElement(ownerDocument, "div", "pdf-engine-viewer__toolbar-group");
  const controls = createElement(ownerDocument, "div", "pdf-engine-viewer__controls");
  const previousButton = createButton(ownerDocument, "Previous", () => {
    const previousPageNumber = state.pageNumbers[currentPageIndex - 1];
    if (previousPageNumber !== undefined) {
      actions.goToPage(previousPageNumber);
    }
  });
  previousButton.disabled = currentPageIndex <= 0;

  const nextButton = createButton(ownerDocument, "Next", () => {
    const nextPageNumber = state.pageNumbers[currentPageIndex + 1];
    if (nextPageNumber !== undefined) {
      actions.goToPage(nextPageNumber);
    }
  });
  nextButton.disabled = currentPageIndex < 0 || currentPageIndex >= state.pageNumbers.length - 1;

  const refreshButton = createButton(ownerDocument, "Refresh", () => {
    actions.update(state.pipelineResult, {
      initialView: state.currentView,
    });
  });

  const pageViewButton = createToggleButton(ownerDocument, "Page", state.currentView === "page", () => {
    actions.setView("page");
  });
  const readerViewButton = createToggleButton(ownerDocument, "Reader", state.currentView === "reader", () => {
    actions.setView("reader");
  });
  pageViewButton.dataset["viewerViewButton"] = "page";
  readerViewButton.dataset["viewerViewButton"] = "reader";

  controls.append(previousButton, nextButton, refreshButton, pageViewButton, readerViewButton);
  navigationGroup.append(controls);

  const label = createElement(ownerDocument, "div", "pdf-engine-viewer__label");
  label.dataset["viewerPageLabel"] = "true";
  label.setAttribute("aria-live", "polite");
  label.textContent = formatPageLabel(state);
  navigationGroup.append(label);
  toolbar.append(navigationGroup);

  if (state.options.showSearch) {
    const searchGroup = createElement(ownerDocument, "div", "pdf-engine-viewer__search");
    const searchLabel = createElement(ownerDocument, "label", "pdf-engine-viewer__search-label");
    searchLabel.textContent = "Search";
    const searchInput = ownerDocument.createElement("input");
    searchInput.className = "pdf-engine-viewer__search-input";
    searchInput.type = "search";
    searchInput.value = state.searchQuery;
    searchInput.placeholder = "Find text in render text, blocks, chunks, and tables";
    searchInput.dataset["viewerSearchInput"] = "true";
    searchInput.addEventListener("input", () => {
      actions.setSearchQuery(searchInput.value);
    });

    const searchCount = createElement(ownerDocument, "span", "pdf-engine-viewer__label");
    searchCount.dataset["viewerSearchCount"] = String(searchResultCount);
    searchCount.textContent =
      state.searchQuery.trim().length === 0
        ? "Search is ready"
        : `${String(searchResultCount)} result${searchResultCount === 1 ? "" : "s"}`;

    searchGroup.append(searchLabel, searchInput, searchCount);
    toolbar.append(searchGroup);
  }

  return toolbar;
}

function formatPageLabel(state: PdfViewerState): string {
  if (state.pageNumbers.length === 0) {
    return "No page content available";
  }

  if (state.currentView === "reader") {
    return `Reader view • page ${String(state.currentPageNumber)} of ${String(state.pageNumbers.length)}`;
  }

  return `Page ${String(state.currentPageNumber)} of ${String(state.pageNumbers.length)}`;
}

function createPagePanel(
  ownerDocument: Document,
  renderPage: PdfRenderPage | undefined,
  matchingRenderUnits: readonly PdfRenderSelectionUnit[],
  layoutPage: PdfLayoutPage | undefined,
  tables: readonly PdfKnowledgeTable[],
  showTables: boolean,
  searchQuery: string,
): HTMLElement {
  const pagePanel = createElement(ownerDocument, "section", "pdf-engine-viewer__page");

  const renderSurface = resolveRenderSurface(renderPage);
  if (renderPage && renderSurface) {
    pagePanel.dataset["viewerPageMode"] = "render";
    pagePanel.append(
      createRenderPageSection(ownerDocument, renderPage, renderSurface, matchingRenderUnits),
    );
  } else {
    pagePanel.dataset["viewerPageMode"] = "layout-fallback";
    pagePanel.append(createRenderFallbackNotice(ownerDocument));
    pagePanel.append(createBlocksSection(ownerDocument, layoutPage, searchQuery, true));
  }

  if (showTables) {
    pagePanel.append(createTablesSection(ownerDocument, tables, searchQuery, true));
  }

  return pagePanel;
}

interface PdfResolvedRenderSurface {
  readonly kind: "raster" | "svg";
  readonly source: string;
  readonly width: number;
  readonly height: number;
}

interface PdfViewerRenderHighlightBox {
  readonly id: string;
  readonly text: string;
  readonly shape: "box" | "point";
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly widthPercent?: number;
  readonly heightPercent?: number;
}

function createRenderPageSection(
  ownerDocument: Document,
  renderPage: PdfRenderPage,
  surface: PdfResolvedRenderSurface,
  matchingRenderUnits: readonly PdfRenderSelectionUnit[],
): HTMLElement {
  const section = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
  section.append(createSectionTitle(ownerDocument, "Rendered Page"));

  const stage = createElement(ownerDocument, "div", "pdf-engine-viewer__render-stage");
  const meta = createElement(ownerDocument, "p", "pdf-engine-viewer__render-meta");
  meta.textContent =
    matchingRenderUnits.length === 0
      ? `Render-backed page • ${surface.kind}`
      : `Render-backed page • ${surface.kind} • ${String(matchingRenderUnits.length)} search highlight${matchingRenderUnits.length === 1 ? "" : "s"}`;

  const surfaceElement = createElement(ownerDocument, "div", "pdf-engine-viewer__render-surface");
  surfaceElement.dataset["viewerRenderSurface"] = surface.kind;
  surfaceElement.dataset["viewerRenderHighlightCount"] = String(matchingRenderUnits.length);

  const image = ownerDocument.createElement("img");
  image.className = "pdf-engine-viewer__render-image";
  image.alt = `Rendered page ${String(renderPage.pageNumber)}`;
  image.src = surface.source;
  image.width = surface.width;
  image.height = surface.height;
  surfaceElement.append(image);

  const highlights = resolveRenderHighlightBoxes(renderPage.pageBox, matchingRenderUnits);
  if (highlights.length > 0) {
    const overlay = createElement(ownerDocument, "div", "pdf-engine-viewer__render-overlay");
    overlay.dataset["viewerRenderHighlightCount"] = String(highlights.length);
    for (const highlightSpec of highlights) {
      const highlight = createElement(ownerDocument, "div", "pdf-engine-viewer__render-highlight");
      highlight.dataset["viewerRenderHighlight"] = highlightSpec.id;
      highlight.dataset["viewerRenderHighlightShape"] = highlightSpec.shape;
      highlight.dataset["shape"] = highlightSpec.shape;
      highlight.title = highlightSpec.text;
      highlight.style.left = `${formatPercent(highlightSpec.leftPercent)}%`;
      highlight.style.top = `${formatPercent(highlightSpec.topPercent)}%`;
      if (highlightSpec.shape === "box") {
        highlight.style.width = `${formatPercent(highlightSpec.widthPercent ?? 0)}%`;
        highlight.style.height = `${formatPercent(highlightSpec.heightPercent ?? 0)}%`;
      }
      overlay.append(highlight);
    }
    surfaceElement.append(overlay);
  }

  stage.append(meta, surfaceElement);
  section.append(stage);
  return section;
}

function createRenderFallbackNotice(ownerDocument: Document): HTMLElement {
  const notice = createElement(ownerDocument, "p", "pdf-engine-viewer__render-fallback");
  notice.dataset["viewerRenderFallback"] = "true";
  notice.textContent = "This page is not render-backed yet. Showing the layout fallback instead.";
  return notice;
}

function resolveRenderSurface(renderPage: PdfRenderPage | undefined): PdfResolvedRenderSurface | null {
  if (!renderPage?.imagery) {
    return null;
  }

  if (renderPage.imagery.raster) {
    return {
      kind: "raster",
      source: createByteDataUrl(renderPage.imagery.raster.bytes, renderPage.imagery.raster.mimeType),
      width: renderPage.imagery.raster.width,
      height: renderPage.imagery.raster.height,
    };
  }

  if (renderPage.imagery.svg) {
    return {
      kind: "svg",
      source: createSvgDataUrl(renderPage.imagery.svg.markup),
      width: renderPage.imagery.svg.width,
      height: renderPage.imagery.svg.height,
    };
  }

  return null;
}

function resolveRenderHighlightBoxes(
  pageBox: PdfBoundingBox | undefined,
  matchingRenderUnits: readonly PdfRenderSelectionUnit[],
): readonly PdfViewerRenderHighlightBox[] {
  if (!pageBox || pageBox.width <= 0 || pageBox.height <= 0) {
    return [];
  }

  return matchingRenderUnits.flatMap((unit) => {
    const box = unit.bbox ? toBoundingHighlightBox(unit, pageBox) : undefined;
    if (box) {
      return [box];
    }

    const anchorBox = unit.anchor ? toAnchorHighlightBox(unit, pageBox) : undefined;
    return anchorBox ? [anchorBox] : [];
  });
}

function toBoundingHighlightBox(
  unit: PdfRenderSelectionUnit,
  pageBox: PdfBoundingBox,
): PdfViewerRenderHighlightBox | undefined {
  const bbox = unit.bbox;
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
    return undefined;
  }

  return {
    id: unit.id,
    text: unit.text,
    shape: "box",
    leftPercent: ((bbox.x - pageBox.x) / pageBox.width) * 100,
    topPercent: ((pageBox.y + pageBox.height - (bbox.y + bbox.height)) / pageBox.height) * 100,
    widthPercent: (bbox.width / pageBox.width) * 100,
    heightPercent: (bbox.height / pageBox.height) * 100,
  };
}

function toAnchorHighlightBox(
  unit: PdfRenderSelectionUnit,
  pageBox: PdfBoundingBox,
): PdfViewerRenderHighlightBox | undefined {
  const anchor = unit.anchor;
  if (!anchor) {
    return undefined;
  }

  return {
    id: unit.id,
    text: unit.text,
    shape: "point",
    leftPercent: ((anchor.x - pageBox.x) / pageBox.width) * 100,
    topPercent: ((pageBox.y + pageBox.height - anchor.y) / pageBox.height) * 100,
  };
}

function formatPercent(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function createReaderPanel(
  ownerDocument: Document,
  pipelineResult: PdfPipelineResult,
  pageNumbers: readonly number[],
  showTables: boolean,
  searchQuery: string,
): HTMLElement {
  const readerPanel = createElement(ownerDocument, "section", "pdf-engine-viewer__reader");
  readerPanel.dataset["viewerReaderPageCount"] = String(pageNumbers.length);

  if (pageNumbers.length === 0) {
    readerPanel.append(createEmptyText(ownerDocument, "No reader content is available."));
    return readerPanel;
  }

  for (const pageNumber of pageNumbers) {
    const page = pipelineResult.layout.value?.pages.find((candidate) => candidate.pageNumber === pageNumber);
    const tables = (pipelineResult.knowledge.value?.tables ?? []).filter(
      (table) => table.pageNumber === pageNumber,
    );
    const pageSection = createElement(ownerDocument, "section", "pdf-engine-viewer__reader-page");
    pageSection.dataset["viewerReaderPage"] = String(pageNumber);

    const pageLabel = createElement(ownerDocument, "p", "pdf-engine-viewer__reader-page-label");
    pageLabel.textContent = `Page ${String(pageNumber)}`;
    pageSection.append(pageLabel);
    pageSection.append(createBlocksSection(ownerDocument, page, searchQuery, false));
    if (showTables) {
      pageSection.append(createTablesSection(ownerDocument, tables, searchQuery, false));
    }
    readerPanel.append(pageSection);
  }

  return readerPanel;
}

function createBlocksSection(
  ownerDocument: Document,
  layoutPage: PdfLayoutPage | undefined,
  searchQuery: string,
  includeDataset: boolean,
): HTMLElement {
  const blocksSection = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
  blocksSection.append(createSectionTitle(ownerDocument, "Page Layout"));

  if (!layoutPage || layoutPage.blocks.length === 0) {
    blocksSection.append(createEmptyText(ownerDocument, "No layout blocks are available for this page."));
    return blocksSection;
  }

  const blocksContainer = createElement(ownerDocument, "div", "pdf-engine-viewer__blocks");
  if (includeDataset) {
    blocksContainer.dataset["viewerBlockCount"] = String(layoutPage.blocks.length);
  }

  for (const block of layoutPage.blocks) {
    blocksContainer.append(createBlockCard(ownerDocument, block, searchQuery));
  }
  blocksSection.append(blocksContainer);
  return blocksSection;
}

function createTablesSection(
  ownerDocument: Document,
  tables: readonly PdfKnowledgeTable[],
  searchQuery: string,
  includeDataset: boolean,
): HTMLElement {
  const tablesSection = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
  tablesSection.append(createSectionTitle(ownerDocument, "Projected Tables"));
  if (includeDataset) {
    tablesSection.dataset["viewerTableCount"] = String(tables.length);
  }

  if (tables.length === 0) {
    tablesSection.append(createEmptyText(ownerDocument, "No projected tables are available for this page."));
    return tablesSection;
  }

  for (const table of tables) {
    tablesSection.append(createTableCard(ownerDocument, table, searchQuery));
  }

  return tablesSection;
}

function createSidebar(
  ownerDocument: Document,
  state: PdfViewerState,
  layoutPage: PdfLayoutPage | undefined,
  chunks: readonly PdfKnowledgeChunk[],
  outlineItems: readonly PdfViewerOutlineItem[],
  searchResults: readonly PdfViewerSearchResult[],
  actions: PdfViewerActions,
): HTMLElement {
  const sidebar = createElement(ownerDocument, "aside", "pdf-engine-viewer__sidebar");

  if (state.options.showSearch) {
    sidebar.append(createSearchPanel(ownerDocument, state, searchResults, actions));
  }

  if (state.options.showOutline) {
    sidebar.append(createOutlinePanel(ownerDocument, outlineItems, actions));
  }

  if (state.options.showChunkAnchors) {
    sidebar.append(createChunkPanel(ownerDocument, chunks, state, actions));
  }

  if (state.options.showBlockOutlines) {
    sidebar.append(createBlockOutlinePanel(ownerDocument, layoutPage, state.searchQuery));
  }

  if (
    !state.options.showSearch &&
    !state.options.showOutline &&
    !state.options.showChunkAnchors &&
    !state.options.showBlockOutlines
  ) {
    const placeholder = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
    placeholder.append(createSectionTitle(ownerDocument, "Viewer"));
    placeholder.append(
      createEmptyText(
        ownerDocument,
        "Enable search, outline, block outlines, or chunk anchors to inspect additional provenance.",
      ),
    );
    sidebar.append(placeholder);
  }

  return sidebar;
}

function createSearchPanel(
  ownerDocument: Document,
  state: PdfViewerState,
  searchResults: readonly PdfViewerSearchResult[],
  actions: PdfViewerActions,
): HTMLElement {
  const panel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
  panel.dataset["viewerSearchCount"] = String(searchResults.length);
  panel.append(createSectionTitle(ownerDocument, "Search Results"));

  const query = state.searchQuery.trim();
  if (query.length === 0) {
    panel.append(createEmptyText(ownerDocument, "Enter a query to search render text, blocks, chunks, and tables."));
    return panel;
  }

  if (searchResults.length === 0) {
    panel.append(createEmptyText(ownerDocument, "No render or staged matches were found for the current query."));
    return panel;
  }

  const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
  for (const result of searchResults) {
    const item = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
    const label = ownerDocument.createElement("small");
    label.textContent = result.label;
    const button = createActionButton(ownerDocument, () => {
      if (result.chunkId) {
        actions.goToChunk(result.chunkId);
        return;
      }
      actions.goToPage(result.pageNumber);
    });
    button.dataset["viewerSearchResult"] = result.id;
    button.dataset["viewerSearchResultKind"] = result.kind;
    appendHighlightedText(ownerDocument, button, result.text, state.searchQuery, "pdf-engine-viewer__action-text");
    item.append(label, button);
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function createOutlinePanel(
  ownerDocument: Document,
  outlineItems: readonly PdfViewerOutlineItem[],
  actions: PdfViewerActions,
): HTMLElement {
  const panel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
  panel.dataset["viewerOutlineCount"] = String(outlineItems.length);
  panel.append(createSectionTitle(ownerDocument, "Outline"));

  if (outlineItems.length === 0) {
    panel.append(createEmptyText(ownerDocument, "No heading outline is available for this result."));
    return panel;
  }

  const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
  for (const item of outlineItems) {
    const entry = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
    const label = ownerDocument.createElement("small");
    label.textContent = `Page ${String(item.pageNumber)}`;
    const button = createActionButton(ownerDocument, () => {
      actions.goToPage(item.pageNumber);
    });
    button.dataset["viewerOutlineItem"] = item.blockId;
    button.textContent = item.text;
    entry.append(label, button);
    list.append(entry);
  }
  panel.append(list);
  return panel;
}

function createChunkPanel(
  ownerDocument: Document,
  chunks: readonly PdfKnowledgeChunk[],
  state: PdfViewerState,
  actions: PdfViewerActions,
): HTMLElement {
  const panel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
  panel.dataset["viewerChunkCount"] = String(chunks.length);
  panel.append(createSectionTitle(ownerDocument, "Chunk Anchors"));

  if (chunks.length === 0) {
    panel.append(createEmptyText(ownerDocument, "No chunk anchors are available for this page."));
    return panel;
  }

  const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
  for (const chunk of chunks) {
    const item = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
    const isActiveChunk = state.activeChunkId === chunk.id;
    item.dataset["active"] = isActiveChunk ? "true" : "false";
    if (isActiveChunk) {
      item.dataset["viewerActiveChunk"] = chunk.id;
    }
    const label = ownerDocument.createElement("small");
    label.textContent = `${chunk.id} • ${chunk.citations.length} citations`;
    const button = createActionButton(ownerDocument, () => {
      actions.goToChunk(chunk.id);
    });
    button.dataset["viewerChunkId"] = chunk.id;
    appendHighlightedText(ownerDocument, button, chunk.text, state.searchQuery, "pdf-engine-viewer__action-text");
    item.append(label, button);
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function createBlockOutlinePanel(
  ownerDocument: Document,
  layoutPage: PdfLayoutPage | undefined,
  searchQuery: string,
): HTMLElement {
  const panel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
  panel.append(createSectionTitle(ownerDocument, "Block Outline"));

  if (!layoutPage || layoutPage.blocks.length === 0) {
    panel.append(createEmptyText(ownerDocument, "No block outline is available for this page."));
    return panel;
  }

  const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
  for (const block of layoutPage.blocks) {
    const item = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
    const label = ownerDocument.createElement("small");
    label.textContent = `${block.id} • ${block.role} • order ${String(block.readingOrder)}`;
    const text = ownerDocument.createElement("div");
    appendHighlightedText(ownerDocument, text, block.text, searchQuery, "pdf-engine-viewer__action-text");
    item.append(label, text);
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function createTableCard(
  ownerDocument: Document,
  table: PdfKnowledgeTable,
  searchQuery: string,
): HTMLElement {
  const section = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
  const title = createSectionTitle(
    ownerDocument,
    table.headers?.join(" / ") ?? `Table on page ${String(table.pageNumber)}`,
  );
  section.append(title);

  const wrapper = createElement(ownerDocument, "div", "pdf-engine-viewer__table-wrap");
  const tableElement = createElement(ownerDocument, "table", "pdf-engine-viewer__table");
  const columnCount = Math.max(
    table.headers?.length ?? 0,
    ...table.cells.map((cell) => cell.columnIndex + 1),
  );

  if ((table.headers?.length ?? 0) > 0) {
    const thead = ownerDocument.createElement("thead");
    const headerRow = ownerDocument.createElement("tr");
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const headerCell = ownerDocument.createElement("th");
      appendHighlightedText(
        ownerDocument,
        headerCell,
        table.headers?.[columnIndex] ?? "",
        searchQuery,
      );
      headerRow.append(headerCell);
    }
    thead.append(headerRow);
    tableElement.append(thead);
  }

  const tbody = ownerDocument.createElement("tbody");
  for (const row of collectTableRows(table, columnCount)) {
    const rowElement = ownerDocument.createElement("tr");
    for (const cellText of row) {
      const cellElement = ownerDocument.createElement("td");
      appendHighlightedText(ownerDocument, cellElement, cellText, searchQuery);
      rowElement.append(cellElement);
    }
    tbody.append(rowElement);
  }
  tableElement.append(tbody);

  wrapper.append(tableElement);
  section.append(wrapper);
  return section;
}

function collectTableRows(table: PdfKnowledgeTable, columnCount: number): readonly (readonly string[])[] {
  const cellsByRow = new Map<number, Map<number, string>>();
  for (const cell of table.cells) {
    const row = cellsByRow.get(cell.rowIndex) ?? new Map<number, string>();
    row.set(cell.columnIndex, cell.text);
    cellsByRow.set(cell.rowIndex, row);
  }

  return [...cellsByRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => {
      const values: string[] = [];
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        values.push(row.get(columnIndex) ?? "");
      }
      return values;
    });
}

function createBlockCard(
  ownerDocument: Document,
  block: PdfLayoutBlock,
  searchQuery: string,
): HTMLElement {
  const article = createElement(ownerDocument, "article", "pdf-engine-viewer__block");
  article.dataset["role"] = block.role;
  article.dataset["blockId"] = block.id;

  const meta = createElement(ownerDocument, "div", "pdf-engine-viewer__block-meta");
  meta.append(
    ownerDocument.createTextNode(`${block.role} • order ${String(block.readingOrder)}`),
    ownerDocument.createTextNode(` • ${block.startsParagraph ? "paragraph-start" : "continuation"}`),
  );
  if (block.writingMode) {
    meta.append(ownerDocument.createTextNode(` • ${block.writingMode}`));
  }

  const text = ownerDocument.createElement("div");
  appendHighlightedText(ownerDocument, text, block.text, searchQuery, "pdf-engine-viewer__block-text");

  article.append(meta, text);
  return article;
}

function appendHighlightedText(
  ownerDocument: Document,
  parent: HTMLElement,
  text: string,
  query: string,
  className?: string,
): void {
  if (className) {
    parent.className = className;
  }

  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery.length === 0) {
    parent.textContent = text;
    return;
  }

  const normalizedText = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
    if (matchIndex < 0) {
      parent.append(ownerDocument.createTextNode(text.slice(cursor)));
      break;
    }

    if (matchIndex > cursor) {
      parent.append(ownerDocument.createTextNode(text.slice(cursor, matchIndex)));
    }

    const highlight = ownerDocument.createElement("mark");
    highlight.className = "pdf-engine-viewer__highlight";
    highlight.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length);
    parent.append(highlight);
    cursor = matchIndex + normalizedQuery.length;
  }
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function createSvgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function createByteDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${globalThis.btoa(binary)}`;
}

function createSectionTitle(ownerDocument: Document, text: string): HTMLElement {
  const title = createElement(ownerDocument, "h2", "pdf-engine-viewer__section-title");
  title.textContent = text;
  return title;
}

function createEmptyText(ownerDocument: Document, text: string): HTMLElement {
  const paragraph = createElement(ownerDocument, "p", "pdf-engine-viewer__empty");
  paragraph.textContent = text;
  return paragraph;
}

function createButton(
  ownerDocument: Document,
  text: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = "pdf-engine-viewer__button";
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function createToggleButton(
  ownerDocument: Document,
  text: string,
  pressed: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = createButton(ownerDocument, text, onClick);
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  return button;
}

function createActionButton(
  ownerDocument: Document,
  onClick: () => void,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = "pdf-engine-viewer__action";
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tagName: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = ownerDocument.createElement(tagName);
  element.className = className;
  return element;
}
