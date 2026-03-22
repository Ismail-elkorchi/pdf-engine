import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  PdfKnowledgeDocument,
  PdfLayoutDocument,
  PdfPipelineResult,
  PdfRenderDocument,
} from "../../src/contracts.ts";
import { createPdfEngine } from "../../src/engine-core.ts";
import {
  clampPageNumber,
  collectOutlineItems,
  collectPageNumbers,
  collectRenderSelectionMatches,
  collectSearchResults,
  createViewerState,
  findChunkById,
  findRenderPageByNumber,
  resolveViewerOptions,
} from "../../src/viewer-state.ts";

function createPipelineResultFixture(): PdfPipelineResult {
  const engine = createPdfEngine();
  const layoutValue: PdfLayoutDocument = {
    kind: "pdf-layout",
    strategy: "line-blocks",
    extractedText: "Heading block\nBody block\nSecond page detail",
    knownLimits: [],
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        blocks: [
          {
            id: "block-heading",
            pageNumber: 1,
            readingOrder: 0,
            text: "Heading block",
            role: "heading",
            roleConfidence: 0.99,
            startsParagraph: true,
            runIds: ["run-1"],
            glyphIds: ["glyph-1"],
            resolutionMethod: "page-tree",
          },
          {
            id: "block-body",
            pageNumber: 1,
            readingOrder: 1,
            text: "Body block",
            role: "body",
            roleConfidence: 0.95,
            startsParagraph: true,
            runIds: ["run-2"],
            glyphIds: ["glyph-2"],
            resolutionMethod: "page-tree",
          },
        ],
      },
      {
        pageNumber: 2,
        resolutionMethod: "page-tree",
        blocks: [
          {
            id: "block-detail",
            pageNumber: 2,
            readingOrder: 0,
            text: "Second page detail",
            role: "body",
            roleConfidence: 0.97,
            startsParagraph: true,
            runIds: ["run-3"],
            glyphIds: ["glyph-3"],
            resolutionMethod: "page-tree",
          },
        ],
      },
    ],
  };
  const knowledgeValue: PdfKnowledgeDocument = {
    kind: "pdf-knowledge",
    strategy: "layout-chunks-and-heuristic-tables",
    extractedText: "Chunk one\nChunk two",
    knownLimits: [],
    chunks: [
      {
        id: "chunk-1",
        text: "Chunk one",
        role: "heading",
        pageNumbers: [1],
        blockIds: ["block-heading"],
        runIds: ["run-1"],
        citations: [
          {
            id: "citation-1",
            pageNumber: 1,
            blockId: "block-heading",
            runIds: ["run-1"],
            text: "Heading block",
          },
        ],
      },
      {
        id: "chunk-2",
        text: "Chunk two with Second page detail",
        role: "body",
        pageNumbers: [2],
        blockIds: ["block-detail"],
        runIds: ["run-3"],
        citations: [
          {
            id: "citation-2",
            pageNumber: 2,
            blockId: "block-detail",
            runIds: ["run-3"],
            text: "Second page detail",
          },
        ],
      },
    ],
    tables: [
      {
        id: "table-1",
        pageNumber: 2,
        headers: ["Column"],
        heuristic: "layout-grid",
        blockIds: ["block-detail"],
        confidence: 0.87,
        cells: [
          {
            rowIndex: 0,
            columnIndex: 0,
            text: "Second page detail",
            citations: [
              {
                id: "citation-3",
                pageNumber: 2,
                blockId: "block-detail",
                runIds: ["run-3"],
                text: "Second page detail",
              },
            ],
          },
        ],
      },
    ],
  };

  return {
    engine: engine.identity,
    runtime: engine.runtime,
    source: {
      fileName: "viewer-state-test.pdf",
      byteLength: 1,
    },
    admission: {
      stage: "admission",
      status: "completed",
      diagnostics: [],
      value: {
        decision: "accepted",
        fileType: "pdf",
        byteLength: 1,
        isEncrypted: false,
        repairState: "clean",
        parseCoverage: {
          header: true,
          indirectObjects: true,
          crossReference: true,
          trailer: true,
          startXref: true,
          pageTree: true,
        },
        featureFindings: [],
        policy: engine.defaultPolicy,
        knownLimits: [],
      },
    },
    ir: {
      stage: "ir",
      status: "completed",
      diagnostics: [],
    },
    observation: {
      stage: "observation",
      status: "completed",
      diagnostics: [],
    },
    layout: {
      stage: "layout",
      status: "completed",
      diagnostics: [],
      value: layoutValue,
    },
    knowledge: {
      stage: "knowledge",
      status: "completed",
      diagnostics: [],
      value: knowledgeValue,
    },
    render: {
      stage: "render",
      status: "completed",
      diagnostics: [],
      value: {
        kind: "pdf-render",
        strategy: "observed-display-list",
        pages: [
          {
            pageNumber: 1,
            resolutionMethod: "page-tree",
            pageBox: {
              x: 0,
              y: 0,
              width: 200,
              height: 300,
            },
            displayList: {
              commands: [],
            },
            textIndex: {
              text: "Heading block",
              spans: [
                {
                  id: "render-span-1",
                  contentOrder: 0,
                  text: "Heading block",
                  glyphIds: ["glyph-1"],
                  anchor: {
                    x: 40,
                    y: 260,
                  },
                },
              ],
            },
            selectionModel: {
              units: [
                {
                  id: "selection-1",
                  textSpanId: "render-span-1",
                  text: "Heading block",
                  glyphIds: ["glyph-1"],
                  anchor: {
                    x: 40,
                    y: 260,
                  },
                },
              ],
            },
            imagery: {
              svg: {
                mimeType: "image/svg+xml",
                markup: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 300\"></svg>",
                width: 200,
                height: 300,
              },
              raster: {
                mimeType: "image/png",
                bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
                width: 200,
                height: 300,
              },
            },
            renderHash: {
              algorithm: "sha-256",
              hex: "1".repeat(64),
            },
          },
          {
            pageNumber: 2,
            resolutionMethod: "page-tree",
            pageBox: {
              x: 0,
              y: 0,
              width: 200,
              height: 300,
            },
            displayList: {
              commands: [],
            },
            textIndex: {
              text: "Second page detail",
              spans: [
                {
                  id: "render-span-2",
                  contentOrder: 0,
                  text: "Second page detail",
                  glyphIds: ["glyph-2"],
                  anchor: {
                    x: 40,
                    y: 220,
                  },
                },
              ],
            },
            selectionModel: {
              units: [
                {
                  id: "selection-2",
                  textSpanId: "render-span-2",
                  text: "Second page detail",
                  glyphIds: ["glyph-2"],
                  anchor: {
                    x: 40,
                    y: 220,
                  },
                },
              ],
            },
            imagery: {
              svg: {
                mimeType: "image/svg+xml",
                markup: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 300\"></svg>",
                width: 200,
                height: 300,
              },
              raster: {
                mimeType: "image/png",
                bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
                width: 200,
                height: 300,
              },
            },
            renderHash: {
              algorithm: "sha-256",
              hex: "2".repeat(64),
            },
          },
        ],
        resourcePayloads: [],
        renderHash: {
          algorithm: "sha-256",
          hex: "0".repeat(64),
        },
        knownLimits: ["render-imagery-partial"],
      } satisfies PdfRenderDocument,
    },
    diagnostics: [],
  };
}

test("resolveViewerOptions preserves current booleans when new options are omitted", () => {
  assert.deepEqual(
    resolveViewerOptions(
      {
        showTables: true,
        showBlockOutlines: false,
        showChunkAnchors: true,
        showSearch: false,
        showOutline: true,
      },
      undefined,
    ),
    {
      showTables: true,
      showBlockOutlines: false,
      showChunkAnchors: true,
      showSearch: false,
      showOutline: true,
    },
  );
});

test("createViewerState clamps pages and keeps prior state defaults when requested", () => {
  const pipelineResult = createPipelineResultFixture();
  const state = createViewerState(
    pipelineResult,
    {
      initialPage: 99,
      showSearch: true,
    },
    {
      previousView: "reader",
      previousSearchQuery: "detail",
      previousActiveChunkId: "chunk-2",
    },
  );

  assert.deepEqual(state.pageNumbers, [1, 2]);
  assert.equal(state.currentPageNumber, 2);
  assert.equal(state.currentView, "reader");
  assert.equal(state.searchQuery, "detail");
  assert.equal(state.activeChunkId, "chunk-2");
  assert.equal(state.options.showSearch, true);
  assert.equal(state.options.showTables, false);
});

test("viewer-state helpers collect outlines, render-backed search results, and chunk lookups", () => {
  const pipelineResult = createPipelineResultFixture();

  assert.deepEqual(collectPageNumbers(pipelineResult), [1, 2]);
  assert.equal(clampPageNumber(0, [1, 2]), 1);
  assert.equal(clampPageNumber(99, [1, 2]), 2);
  assert.equal(clampPageNumber(5, []), 1);

  assert.deepEqual(collectOutlineItems(pipelineResult), [
    {
      blockId: "block-heading",
      pageNumber: 1,
      text: "Heading block",
    },
  ]);

  const searchResults = collectSearchResults(pipelineResult, "second");
  assert.equal(searchResults.length, 4);
  assert.deepEqual(
    searchResults.map((result) => result.kind),
    ["render-text", "block", "chunk", "table"],
  );
  assert.equal(searchResults[0]?.renderSelectionUnitId, "selection-2");
  assert.equal(searchResults[0]?.pageNumber, 2);
  assert.equal(searchResults[2]?.chunkId, "chunk-2");
  assert.equal(findRenderPageByNumber(pipelineResult, 2)?.pageNumber, 2);
  assert.deepEqual(
    collectRenderSelectionMatches(pipelineResult, 2, "second").map((unit) => unit.id),
    ["selection-2"],
  );
  assert.equal(findChunkById(pipelineResult, "chunk-2")?.text, "Chunk two with Second page detail");
  assert.equal(findChunkById(pipelineResult, "missing"), undefined);
  assert.deepEqual(collectSearchResults(pipelineResult, "   "), []);
});

test("collectPageNumbers includes render-only pages when layout and knowledge are absent", () => {
  const pipelineResult = createPipelineResultFixture();
  const { value: _layoutValue, ...layoutWithoutValue } = pipelineResult.layout;
  const { value: _knowledgeValue, ...knowledgeWithoutValue } = pipelineResult.knowledge;
  const renderOnlyResult: PdfPipelineResult = {
    ...pipelineResult,
    layout: layoutWithoutValue,
    knowledge: knowledgeWithoutValue,
    render: {
      ...pipelineResult.render,
      value: {
        ...pipelineResult.render.value!,
        pages: [
          {
            ...pipelineResult.render.value!.pages[0]!,
            pageNumber: 3,
          },
        ],
      },
    },
  };

  assert.deepEqual(collectPageNumbers(renderOnlyResult), [3]);
});
