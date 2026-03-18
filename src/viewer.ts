import type {
  PdfKnowledgeChunk,
  PdfKnowledgeTable,
  PdfLayoutBlock,
  PdfLayoutPage,
  PdfPipelineResult,
} from "./contracts.ts";

export interface PdfViewerOptions {
  readonly initialPage?: number;
  readonly showTables?: boolean;
  readonly showBlockOutlines?: boolean;
  readonly showChunkAnchors?: boolean;
}

export interface PdfViewerHandle {
  goToPage(pageNumber: number): void;
  update(pipelineResult: PdfPipelineResult, options?: PdfViewerOptions): void;
  destroy(): void;
}

interface PdfResolvedViewerOptions {
  readonly showTables: boolean;
  readonly showBlockOutlines: boolean;
  readonly showChunkAnchors: boolean;
}

interface PdfViewerState {
  readonly pipelineResult: PdfPipelineResult;
  readonly options: PdfResolvedViewerOptions;
  readonly pageNumbers: readonly number[];
  readonly currentPageNumber: number;
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
  align-items: center;
  background: rgba(255, 255, 255, 0.82);
  border-bottom: 1px solid #d6ded5;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding: 14px 18px;
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

.pdf-engine-viewer__label {
  color: #26415b;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
}

.pdf-engine-viewer__layout {
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  padding: 18px;
}

.pdf-engine-viewer__page {
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid #d6ded5;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 360px;
  padding: 20px;
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

.pdf-engine-viewer__block-text {
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

.pdf-engine-viewer__list-item small {
  color: #5d6c7a;
  display: block;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  margin-bottom: 4px;
}

.pdf-engine-viewer__empty {
  color: #5d6c7a;
  font-style: italic;
  margin: 0;
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
 * The viewer reuses staged layout and knowledge artifacts; it does not re-parse the
 * source document and it does not attempt pixel-accurate rendering.
 *
 * @param container Browser DOM element that will own the viewer subtree.
 * @param pipelineResult Existing staged pipeline result to visualize.
 * @param options Optional viewer toggles and initial-page selection.
 * @returns Handle that can navigate, refresh, or destroy the viewer.
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

  function render(): void {
    container.replaceChildren(buildViewerRoot(ownerDocument, state, goToPage, update));
  }

  function goToPage(pageNumber: number): void {
    state = {
      ...state,
      currentPageNumber: clampPageNumber(pageNumber, state.pageNumbers),
    };
    render();
  }

  function update(nextPipelineResult: PdfPipelineResult, nextOptions?: PdfViewerOptions): void {
    state = createViewerState(
      nextPipelineResult,
      resolveViewerOptions(state.options, nextOptions),
      state.currentPageNumber,
    );
    render();
  }

  function destroy(): void {
    container.replaceChildren();
  }

  render();

  return {
    goToPage,
    update,
    destroy,
  };
}

function resolveViewerOptions(
  currentOptions: PdfResolvedViewerOptions,
  nextOptions: PdfViewerOptions | undefined,
): PdfViewerOptions {
  if (nextOptions === undefined) {
    return currentOptions;
  }

  return {
    ...(nextOptions.initialPage === undefined ? {} : { initialPage: nextOptions.initialPage }),
    showTables: nextOptions.showTables ?? currentOptions.showTables,
    showBlockOutlines: nextOptions.showBlockOutlines ?? currentOptions.showBlockOutlines,
    showChunkAnchors: nextOptions.showChunkAnchors ?? currentOptions.showChunkAnchors,
  };
}

function createViewerState(
  pipelineResult: PdfPipelineResult,
  options: PdfViewerOptions,
  previousPageNumber?: number,
): PdfViewerState {
  const pageNumbers = collectPageNumbers(pipelineResult);
  const defaultPageNumber = options.initialPage ?? previousPageNumber ?? pageNumbers[0] ?? 1;

  return {
    pipelineResult,
    options: {
      showTables: options.showTables ?? false,
      showBlockOutlines: options.showBlockOutlines ?? false,
      showChunkAnchors: options.showChunkAnchors ?? false,
    },
    pageNumbers,
    currentPageNumber: clampPageNumber(defaultPageNumber, pageNumbers),
  };
}

function collectPageNumbers(pipelineResult: PdfPipelineResult): readonly number[] {
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

function clampPageNumber(pageNumber: number, pageNumbers: readonly number[]): number {
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

function buildViewerRoot(
  ownerDocument: Document,
  state: PdfViewerState,
  goToPage: (pageNumber: number) => void,
  update: (pipelineResult: PdfPipelineResult, options?: PdfViewerOptions) => void,
): HTMLElement {
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

  const root = createElement(ownerDocument, "section", "pdf-engine-viewer");
  root.append(createStyleElement(ownerDocument));
  root.append(
    createToolbar(
      ownerDocument,
      state,
      currentPageIndex,
      goToPage,
      update,
    ),
  );

  const layout = createElement(ownerDocument, "div", "pdf-engine-viewer__layout");
  layout.append(
    createPagePanel(ownerDocument, currentLayoutPage, currentTables, state.options.showTables),
  );
  layout.append(
    createSidebar(
      ownerDocument,
      currentLayoutPage,
      currentChunks,
      state.options.showBlockOutlines,
      state.options.showChunkAnchors,
    ),
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
  goToPage: (pageNumber: number) => void,
  update: (pipelineResult: PdfPipelineResult, options?: PdfViewerOptions) => void,
): HTMLElement {
  const toolbar = createElement(ownerDocument, "header", "pdf-engine-viewer__toolbar");
  const controls = createElement(ownerDocument, "div", "pdf-engine-viewer__controls");
  const previousButton = createButton(ownerDocument, "Previous", () => {
    const previousPageNumber = state.pageNumbers[currentPageIndex - 1];
    if (previousPageNumber !== undefined) {
      goToPage(previousPageNumber);
    }
  });
  previousButton.disabled = currentPageIndex <= 0;

  const nextButton = createButton(ownerDocument, "Next", () => {
    const nextPageNumber = state.pageNumbers[currentPageIndex + 1];
    if (nextPageNumber !== undefined) {
      goToPage(nextPageNumber);
    }
  });
  nextButton.disabled = currentPageIndex < 0 || currentPageIndex >= state.pageNumbers.length - 1;

  const refreshButton = createButton(ownerDocument, "Refresh", () => {
    update(state.pipelineResult, state.options);
  });

  controls.append(previousButton, nextButton, refreshButton);

  const label = createElement(ownerDocument, "div", "pdf-engine-viewer__label");
  label.dataset["viewerPageLabel"] = "true";
  label.setAttribute("aria-live", "polite");
  label.textContent =
    state.pageNumbers.length === 0
      ? "No page content available"
      : `Page ${String(state.currentPageNumber)} of ${String(state.pageNumbers.length)}`;

  toolbar.append(controls, label);
  return toolbar;
}

function createPagePanel(
  ownerDocument: Document,
  layoutPage: PdfLayoutPage | undefined,
  tables: readonly PdfKnowledgeTable[],
  showTables: boolean,
): HTMLElement {
  const pagePanel = createElement(ownerDocument, "section", "pdf-engine-viewer__page");
  const blocksSection = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
  blocksSection.append(createSectionTitle(ownerDocument, "Page Layout"));

  if (!layoutPage || layoutPage.blocks.length === 0) {
    blocksSection.append(createEmptyText(ownerDocument, "No layout blocks are available for this page."));
  } else {
    const blocksContainer = createElement(ownerDocument, "div", "pdf-engine-viewer__blocks");
    blocksContainer.dataset["viewerBlockCount"] = String(layoutPage.blocks.length);
    for (const block of layoutPage.blocks) {
      blocksContainer.append(createBlockCard(ownerDocument, block));
    }
    blocksSection.append(blocksContainer);
  }

  pagePanel.append(blocksSection);

  if (showTables) {
    const tablesSection = createElement(ownerDocument, "section", "pdf-engine-viewer__section");
    tablesSection.append(createSectionTitle(ownerDocument, "Projected Tables"));
    tablesSection.dataset["viewerTableCount"] = String(tables.length);
    if (tables.length === 0) {
      tablesSection.append(createEmptyText(ownerDocument, "No projected tables are available for this page."));
    } else {
      for (const table of tables) {
        tablesSection.append(createTableCard(ownerDocument, table));
      }
    }
    pagePanel.append(tablesSection);
  }

  return pagePanel;
}

function createSidebar(
  ownerDocument: Document,
  layoutPage: PdfLayoutPage | undefined,
  chunks: readonly PdfKnowledgeChunk[],
  showBlockOutlines: boolean,
  showChunkAnchors: boolean,
): HTMLElement {
  const sidebar = createElement(ownerDocument, "aside", "pdf-engine-viewer__sidebar");

  if (showChunkAnchors) {
    const chunkPanel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
    chunkPanel.dataset["viewerChunkCount"] = String(chunks.length);
    chunkPanel.append(createSectionTitle(ownerDocument, "Chunk Anchors"));
    if (chunks.length === 0) {
      chunkPanel.append(createEmptyText(ownerDocument, "No chunk anchors are available for this page."));
    } else {
      const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
      for (const chunk of chunks) {
        const item = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
        const label = ownerDocument.createElement("small");
        label.textContent = `${chunk.id} • ${chunk.citations.length} citations`;
        item.append(label, ownerDocument.createTextNode(chunk.text));
        list.append(item);
      }
      chunkPanel.append(list);
    }
    sidebar.append(chunkPanel);
  }

  if (showBlockOutlines) {
    const outlinePanel = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
    outlinePanel.append(createSectionTitle(ownerDocument, "Block Outline"));
    if (!layoutPage || layoutPage.blocks.length === 0) {
      outlinePanel.append(createEmptyText(ownerDocument, "No block outline is available for this page."));
    } else {
      const list = createElement(ownerDocument, "ol", "pdf-engine-viewer__list");
      for (const block of layoutPage.blocks) {
        const item = createElement(ownerDocument, "li", "pdf-engine-viewer__list-item");
        const label = ownerDocument.createElement("small");
        label.textContent = `${block.id} • ${block.role} • order ${String(block.readingOrder)}`;
        item.append(label, ownerDocument.createTextNode(block.text));
        list.append(item);
      }
      outlinePanel.append(list);
    }
    sidebar.append(outlinePanel);
  }

  if (!showChunkAnchors && !showBlockOutlines) {
    const placeholder = createElement(ownerDocument, "section", "pdf-engine-viewer__panel");
    placeholder.append(createSectionTitle(ownerDocument, "Viewer"));
    placeholder.append(
      createEmptyText(
        ownerDocument,
        "Enable block outlines or chunk anchors to inspect additional provenance for this page.",
      ),
    );
    sidebar.append(placeholder);
  }

  return sidebar;
}

function createTableCard(ownerDocument: Document, table: PdfKnowledgeTable): HTMLElement {
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
      headerCell.textContent = table.headers?.[columnIndex] ?? "";
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
      cellElement.textContent = cellText;
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

function createBlockCard(ownerDocument: Document, block: PdfLayoutBlock): HTMLElement {
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

  const text = createElement(ownerDocument, "div", "pdf-engine-viewer__block-text");
  text.textContent = block.text;

  article.append(meta, text);
  return article;
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

function createButton(ownerDocument: Document, text: string, onClick: () => void): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = "pdf-engine-viewer__button";
  button.type = "button";
  button.textContent = text;
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
