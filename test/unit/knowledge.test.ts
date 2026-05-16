import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfKnowledgeDocument,
  PdfObservedDocument,
  PdfObservedTextRun,
} from "../../src/contracts.ts";
import { assertKnowledgeCitationsResolvable, buildKnowledgeDocument } from "../../src/knowledge.ts";

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
  assert.deepEqual(knowledge.knownLimits, [
    "knowledge-chunk-heuristic",
    "knowledge-markdown-heuristic",
    "table-projection-heuristic",
  ]);
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
  assert.match(knowledge.markdown, /^## Sample Measurements/u);
  assert.match(knowledge.markdown, /\| Item \| Nominal Width \| Measured Width \| Result \|/u);
  const measuredWidthCitation = table.cells.at(5)?.citations[0];
  assert.equal(measuredWidthCitation?.text, "10.0 mm");
  assert.equal(measuredWidthCitation?.sourceSpan?.text, "10.0 mm");
  assert.equal(measuredWidthCitation?.sourceSpan?.runSpans[0]?.runId, "run-3");
  assert.equal(
    measuredWidthCitation?.sourceSpan === undefined
      ? undefined
      : createCompactRowRunLayout([
          "Sample Measurements",
          "Item Nominal Width Measured Width Result",
          "Alpha 10.0 mm 10.4 mm pass",
          "Beta 12.0 mm 11.1 mm review",
          "Gamma 8.0 mm 8.0 mm pass",
        ]).pages[0]?.blocks[1]?.text.slice(
          measuredWidthCitation.sourceSpan.blockRange.start,
          measuredWidthCitation.sourceSpan.blockRange.end,
        ),
    "10.0 mm",
  );
});

test("knowledge projection identifiers are deterministic and source-derived", () => {
  const texts = [
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ];
  const layout = createCompactRowRunLayout(texts);
  const observation = createCompactRowRunObservation(texts);

  const firstKnowledge = buildKnowledgeDocument(layout, observation);
  const secondKnowledge = buildKnowledgeDocument(layout, observation);

  assert.deepEqual(collectKnowledgeIds(secondKnowledge), collectKnowledgeIds(firstKnowledge));
  assert.ok(firstKnowledge.chunks.every((chunk) => !/^chunk-\d+$/u.test(chunk.id)));
  assert.ok(firstKnowledge.tables.every((table) => !/^table-\d+$/u.test(table.id)));
  assert.ok(
    [
      ...firstKnowledge.chunks.flatMap((chunk) => chunk.citations),
      ...firstKnowledge.tables.flatMap((table) => table.cells.flatMap((cell) => cell.citations)),
    ].every((citation) => !/^(?:citation-\d+-\d+|table-\d+-r\d-c\d-\d)$/u.test(citation.id)),
  );
});

test("knowledge table identifiers stay stable when unrelated later prose is added", () => {
  const texts = [
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ];
  const baseKnowledge = buildKnowledgeDocument(
    createCompactRowRunLayout(texts),
    createCompactRowRunObservation(texts),
  );
  const extendedKnowledge = buildKnowledgeDocument(
    appendLayoutBlock(createCompactRowRunLayout(texts), {
      id: "block-extra",
      pageNumber: 1,
      readingOrder: 3,
      text: "Unrelated later prose",
      role: "body",
      roleConfidence: 0.82,
      startsParagraph: true,
      runIds: ["run-extra"],
      glyphIds: ["glyph-extra"],
      resolutionMethod: "page-tree",
      anchor: { x: 72, y: 640 },
      fontSize: 12,
    }),
    createCompactRowRunObservation(texts),
  );

  assert.equal(extendedKnowledge.tables[0]?.id, baseKnowledge.tables[0]?.id);
  assert.deepEqual(
    getTableCellCitationIds(extendedKnowledge, "10.0 mm"),
    getTableCellCitationIds(baseKnowledge, "10.0 mm"),
  );
});

test("knowledge interleaves projected table chunks at their source reading position", () => {
  const knowledge = buildKnowledgeDocument(
    createFieldLabelFormLayout(),
    createFieldLabelFormObservation(),
  );

  const tableChunkIndex = knowledge.chunks.findIndex((chunk) =>
    chunk.role === "mixed" &&
    chunk.text.includes("Registration Form") &&
    chunk.text.includes("Name:") &&
    chunk.text.includes("Reviewer:")
  );
  const closingChunkIndex = knowledge.chunks.findIndex((chunk) => chunk.text.includes("Closing paragraph"));

  assert.notEqual(tableChunkIndex, -1);
  assert.notEqual(closingChunkIndex, -1);
  assert.ok(!knowledge.chunks[tableChunkIndex]?.text.includes("Closing paragraph"));
  assert.ok(tableChunkIndex < closingChunkIndex);
  assert.ok(knowledge.extractedText.indexOf("Registration Form\nName:") < knowledge.extractedText.indexOf("Closing paragraph"));
});

test("knowledge hard-fails unresolvable citation anchors", () => {
  const layout = createCompactRowRunLayout([
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ]);
  const invalidKnowledge: Pick<PdfKnowledgeDocument, "chunks" | "tables"> = {
    chunks: [
      {
        id: "chunk-1",
        text: "Detached text",
        role: "body",
        pageNumbers: [1],
        blockIds: ["missing-block"],
        runIds: ["run-missing"],
        citations: [
          {
            id: "citation-1",
            pageNumber: 1,
            blockId: "missing-block",
            runIds: ["run-missing"],
            text: "Detached text",
          },
        ],
      },
    ],
    tables: [],
  };

  assert.throws(
    () => assertKnowledgeCitationsResolvable(layout, invalidKnowledge),
    /Unresolvable knowledge citation citation-1: missing layout block missing-block/u,
  );
});

test("knowledge hard-fails stale citation text", () => {
  const layout = createCompactRowRunLayout([
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ]);
  const invalidKnowledge: Pick<PdfKnowledgeDocument, "chunks" | "tables"> = {
    chunks: [
      {
        id: "chunk-stale",
        text: "Detached text",
        role: "body",
        pageNumbers: [1],
        blockIds: ["block-1"],
        runIds: ["run-1"],
        citations: [
          {
            id: "citation-stale",
            pageNumber: 1,
            blockId: "block-1",
            runIds: ["run-1"],
            text: "Detached text",
          },
        ],
      },
    ],
    tables: [],
  };

  assert.throws(
    () => assertKnowledgeCitationsResolvable(layout, invalidKnowledge),
    /Unresolvable knowledge citation citation-stale: citation text is not present in block block-1/u,
  );
});

test("knowledge hard-fails stale source spans and table-cell overreach", () => {
  const layout = createCompactRowRunLayout([
    "Sample Measurements",
    "Item Nominal Width Measured Width Result",
    "Alpha 10.0 mm 10.4 mm pass",
    "Beta 12.0 mm 11.1 mm review",
    "Gamma 8.0 mm 8.0 mm pass",
  ]);
  const staleSourceSpan: Pick<PdfKnowledgeDocument, "chunks" | "tables"> = {
    chunks: [
      {
        id: "chunk-source-span",
        text: "Sample Measurements",
        role: "heading",
        pageNumbers: [1],
        blockIds: ["block-1"],
        runIds: ["run-1"],
        citations: [
          {
            id: "citation-source-span",
            pageNumber: 1,
            blockId: "block-1",
            runIds: ["run-1"],
            text: "Sample Measurements",
            sourceSpan: {
              text: "Wrong text",
              blockRange: { start: 0, end: "Sample Measurements".length },
              runSpans: [
                {
                  runId: "run-1",
                  range: { start: 0, end: "Sample Measurements".length },
                  text: "Sample Measurements",
                },
              ],
            },
          },
        ],
      },
    ],
    tables: [],
  };

  assert.throws(
    () => assertKnowledgeCitationsResolvable(layout, staleSourceSpan),
    /Unresolvable knowledge citation citation-source-span: source span text is stale for block block-1/u,
  );

  const splitHeaderCell: Pick<PdfKnowledgeDocument, "chunks" | "tables"> = {
    chunks: [],
    tables: [
      {
        id: "table-split-header",
        pageNumber: 1,
        headers: ["Serial No."],
        heuristic: "contract-award-sequence",
        blockIds: ["block-1"],
        confidence: 0.9,
        cells: [
          {
            rowIndex: 0,
            columnIndex: 0,
            text: "Sample Measurements Item Nominal Width Measured Width Result",
            citations: [
              {
                id: "citation-split-header",
                pageNumber: 1,
                blockId: "block-1",
                runIds: ["run-1"],
                text: "Sample Measurements",
              },
            ],
          },
        ],
      },
    ],
  };

  assert.doesNotThrow(() => assertKnowledgeCitationsResolvable(layout, splitHeaderCell));

  const overbroadTableCell: Pick<PdfKnowledgeDocument, "chunks" | "tables"> = {
    chunks: [],
    tables: [
      {
        id: "table-overbroad",
        pageNumber: 1,
        headers: ["Item"],
        heuristic: "row-sequence",
        blockIds: ["block-2"],
        confidence: 0.9,
        cells: [
          {
            rowIndex: 0,
            columnIndex: 0,
            text: "Alpha",
            citations: [
              {
                id: "citation-overbroad",
                pageNumber: 1,
                blockId: "block-2",
                runIds: ["run-3"],
                text: "Alpha 10.0 mm 10.4 mm pass",
              },
            ],
          },
        ],
      },
    ],
  };

  assert.throws(
    () => assertKnowledgeCitationsResolvable(layout, overbroadTableCell),
    /Unresolvable knowledge citation citation-overbroad: table cell citation overreaches cell text/u,
  );
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
    "knowledge-markdown-heuristic",
    "table-projection-not-implemented",
  ]);
});

test("knowledge does not project compact row-run tables from prose with incidental numbers", () => {
  const texts = [
    "Programming Note",
    "Data to be loaded into a floating-point double or quad register that is not doubleword-aligned in memory",
    "must be loaded into the lower 16 double registers using single-precision instructions",
    "If desired it can then be copied into the upper 16 double registers",
  ];

  const knowledge = buildKnowledgeDocument(
    createCompactRowRunLayout(texts),
    createCompactRowRunObservation(texts),
  );

  assert.equal(knowledge.tables.length, 0);
  assert.match(
    knowledge.extractedText,
    /Data to be loaded into a floating-point double or quad register/u,
  );
  assert.match(knowledge.extractedText, /single-precision instructions/u);
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

function createFieldLabelFormLayout(): PdfLayoutDocument {
  const texts = ["Registration Form", "Name:", "Department:", "Contact:", "Reviewer:", "Closing paragraph"];
  const roles: readonly PdfLayoutBlock["role"][] = ["heading", "body", "body", "body", "body", "body"];
  return {
    kind: "pdf-layout",
    strategy: "line-blocks",
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        blocks: texts.map((text, index): PdfLayoutBlock => ({
          id: `field-block-${String(index + 1)}`,
          pageNumber: 1,
          readingOrder: index,
          text,
          role: roles[index] ?? "body",
          roleConfidence: index === 0 ? 0.92 : 0.84,
          startsParagraph: true,
          runIds: [`field-run-${String(index + 1)}`],
          glyphIds: [`field-glyph-${String(index + 1)}`],
          resolutionMethod: "page-tree",
          anchor: { x: 72, y: 740 - index * 24 },
          fontSize: index === 0 ? 22 : 12,
        })),
      },
    ],
    extractedText: texts.join("\n"),
    knownLimits: [],
  };
}

function createFieldLabelFormObservation(): PdfObservedDocument {
  const texts = ["Registration Form", "Name:", "Department:", "Contact:", "Reviewer:", "Closing paragraph"];
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
          id: `field-run-${String(index + 1)}`,
          pageNumber: 1,
          contentOrder: index,
          text,
          glyphIds: [`field-glyph-${String(index + 1)}`],
          origin: "native-text",
          anchor: { x: 72, y: 740 - index * 24 },
          fontSize: index === 0 ? 22 : 12,
          startsNewLine: true,
        })),
        marks: [],
      },
    ],
  };
}

function collectKnowledgeIds(knowledge: PdfKnowledgeDocument): readonly string[] {
  return [
    ...knowledge.chunks.map((chunk) => chunk.id),
    ...knowledge.chunks.flatMap((chunk) => chunk.citations.map((citation) => citation.id)),
    ...knowledge.tables.map((table) => table.id),
    ...knowledge.tables.flatMap((table) =>
      table.cells.flatMap((cell) => cell.citations.map((citation) => citation.id))
    ),
  ];
}

function appendLayoutBlock(layout: PdfLayoutDocument, block: PdfLayoutBlock): PdfLayoutDocument {
  const [firstPage, ...remainingPages] = layout.pages;
  assert.ok(firstPage);
  return {
    ...layout,
    pages: [
      {
        ...firstPage,
        blocks: [...firstPage.blocks, block],
      },
      ...remainingPages,
    ],
    extractedText: `${layout.extractedText}\n${block.text}`,
  };
}

function getTableCellCitationIds(knowledge: PdfKnowledgeDocument, cellText: string): readonly string[] {
  return knowledge.tables.flatMap((table) =>
    table.cells
      .filter((cell) => cell.text === cellText)
      .flatMap((cell) => cell.citations.map((citation) => citation.id))
  );
}
