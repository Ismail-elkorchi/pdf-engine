import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfObservedDocument,
  PdfObservedTextRun,
} from "../../src/contracts.ts";
import { buildKnowledgeDocument } from "../../src/knowledge.ts";

test("knowledge projects compact row-run tables with citation-backed cells", () => {
  const layout = createCompactRowRunLayout([
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ]);
  const observation = createCompactRowRunObservation([
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ]);

  const knowledge = buildKnowledgeDocument(layout, observation);

  assert.equal(knowledge.strategy, "layout-chunks-and-heuristic-tables");
  assert.deepEqual(knowledge.knownLimits, ["knowledge-chunk-heuristic", "table-projection-heuristic"]);
  assert.equal(knowledge.tables.length, 1);

  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "row-sequence");
  assert.deepEqual(table.headers, ["Item", "Nominal Width", "Measured Width", "Result"]);
  assert.deepEqual(
    table.cells.map((cell) => [cell.rowIndex, cell.columnIndex, cell.text]),
    [
      [0, 0, "Item"],
      [0, 1, "Nominal Width"],
      [0, 2, "Measured Width"],
      [0, 3, "Result"],
      [1, 0, "Alpha"],
      [1, 1, "10.0 mm"],
      [1, 2, "10.4 mm"],
      [1, 3, "pass"],
      [2, 0, "Beta"],
      [2, 1, "12.0 mm"],
      [2, 2, "11.1 mm"],
      [2, 3, "review"],
      [3, 0, "Gamma"],
      [3, 1, "8.0 mm"],
      [3, 2, "8.0 mm"],
      [3, 3, "pass"],
    ],
  );
  assert.deepEqual(table.blockIds, ["block-1", "block-2", "block-3"]);
  assert.deepEqual(table.cells.at(5)?.citations.map((citation) => citation.runIds), [["run-3"]]);
});

test("knowledge does not project compact row-run tables without consistent numeric body rows", () => {
  const texts = [
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha passed review and moved forward",
    "Beta needs manual follow up",
    "Gamma remains under review",
  ];

  const knowledge = buildKnowledgeDocument(
    createCompactRowRunLayout(texts),
    createCompactRowRunObservation(texts),
  );

  assert.equal(knowledge.tables.length, 0);
  assert.deepEqual(knowledge.knownLimits, [
    "knowledge-chunk-heuristic",
    "table-projection-not-implemented",
  ]);
});

function createCompactRowRunLayout(texts: readonly string[]): PdfLayoutDocument {
  const [title = "", header = "", firstRow = "", secondRow = "", thirdRow = ""] = texts;
  const blocks: PdfLayoutBlock[] = [
    {
      id: "block-1",
      pageNumber: 1,
      readingOrder: 0,
      text: `${title}\n${header}`,
      role: "heading",
      roleConfidence: 0.91,
      startsParagraph: true,
      runIds: ["run-1", "run-2"],
      glyphIds: ["glyph-1", "glyph-2"],
      resolutionMethod: "page-tree",
      anchor: { x: 72, y: 740 },
      fontSize: 12,
    },
    {
      id: "block-2",
      pageNumber: 1,
      readingOrder: 1,
      text: `${firstRow}\n${secondRow}`,
      role: "body",
      roleConfidence: 0.82,
      startsParagraph: true,
      runIds: ["run-3", "run-4"],
      glyphIds: ["glyph-3", "glyph-4"],
      resolutionMethod: "page-tree",
      anchor: { x: 72, y: 700 },
      fontSize: 12,
    },
    {
      id: "block-3",
      pageNumber: 1,
      readingOrder: 2,
      text: thirdRow,
      role: "body",
      roleConfidence: 0.82,
      startsParagraph: false,
      runIds: ["run-5"],
      glyphIds: ["glyph-5"],
      resolutionMethod: "page-tree",
      anchor: { x: 72, y: 680 },
      fontSize: 12,
    },
  ];

  return {
    kind: "pdf-layout",
    strategy: "line-blocks",
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        blocks,
      },
    ],
    extractedText: texts.join("\n"),
    knownLimits: [],
  };
}

function createCompactRowRunObservation(texts: readonly string[]): PdfObservedDocument {
  return {
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: texts.join("\n"),
    knownLimits: [],
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        glyphs: [],
        runs: texts.map((text, index): PdfObservedTextRun => ({
          id: `run-${String(index + 1)}`,
          pageNumber: 1,
          contentOrder: index,
          text,
          glyphIds: [`glyph-${String(index + 1)}`],
          origin: "native-text",
          anchor: { x: 72, y: 740 - index * 20 },
          fontSize: 12,
          startsNewLine: true,
        })),
        marks: [],
      },
    ],
  };
}
