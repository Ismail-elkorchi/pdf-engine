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

test("knowledge projects anchored layout grids in row-major source order", () => {
  const layout = createSinglePageLayout([
    createLayoutBlock({ id: "grid-title", readingOrder: 0, text: "Grid Summary", role: "heading", x: 72, y: 760, fontSize: 18 }),
    createLayoutBlock({ id: "grid-h1", readingOrder: 1, text: "Item", x: 72, y: 720 }),
    createLayoutBlock({ id: "grid-h2", readingOrder: 2, text: "Quantity", x: 180, y: 720 }),
    createLayoutBlock({ id: "grid-h3", readingOrder: 3, text: "Status", x: 300, y: 720 }),
    createLayoutBlock({ id: "grid-r1c1", readingOrder: 4, text: "Alpha", x: 72, y: 700 }),
    createLayoutBlock({ id: "grid-r1c2", readingOrder: 5, text: "10", x: 180, y: 700 }),
    createLayoutBlock({ id: "grid-r1c3", readingOrder: 6, text: "Active", x: 300, y: 700 }),
    createLayoutBlock({ id: "grid-r2c1", readingOrder: 7, text: "Beta", x: 72, y: 680 }),
    createLayoutBlock({ id: "grid-r2c2", readingOrder: 8, text: "12", x: 180, y: 680 }),
    createLayoutBlock({ id: "grid-r2c3", readingOrder: 9, text: "Pending", x: 300, y: 680 }),
  ]);

  const knowledge = buildKnowledgeDocument(layout);

  assert.equal(knowledge.tables.length, 1);
  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "layout-grid");
  assert.deepEqual(table.headers, ["Item", "Quantity", "Status"]);
  assert.deepEqual(
    table.cells.map((cell) => [cell.rowIndex, cell.columnIndex, cell.text]),
    [
      [0, 0, "Item"],
      [0, 1, "Quantity"],
      [0, 2, "Status"],
      [1, 0, "Alpha"],
      [1, 1, "10"],
      [1, 2, "Active"],
      [2, 0, "Beta"],
      [2, 1, "12"],
      [2, 2, "Pending"],
    ],
  );
  assert.deepEqual(table.blockIds, [
    "grid-h1",
    "grid-h2",
    "grid-h3",
    "grid-r1c1",
    "grid-r1c2",
    "grid-r1c3",
    "grid-r2c1",
    "grid-r2c2",
    "grid-r2c3",
  ]);
});

test("knowledge projects high-font row sequences without relying on compact line parsing", () => {
  const runs = [
    createObservedRun({ id: "run-r1c1", contentOrder: 0, text: "Alpha", fontSize: 10 }),
    createObservedRun({ id: "run-r1c2", contentOrder: 1, text: "10", fontSize: 10 }),
    createObservedRun({ id: "run-r1c3", contentOrder: 2, text: "Pass", fontSize: 10 }),
    createObservedRun({ id: "run-r2c1", contentOrder: 3, text: "Beta", fontSize: 10 }),
    createObservedRun({ id: "run-r2c2", contentOrder: 4, text: "12", fontSize: 10 }),
    createObservedRun({ id: "run-r2c3", contentOrder: 5, text: "Review", fontSize: 10 }),
    createObservedRun({ id: "run-h1", contentOrder: 6, text: "Item", fontSize: 14 }),
    createObservedRun({ id: "run-h2", contentOrder: 7, text: "Count", fontSize: 14 }),
    createObservedRun({ id: "run-h3", contentOrder: 8, text: "Result", fontSize: 14 }),
  ];
  const layout = createSinglePageLayout(
    runs.map((run, index) =>
      createLayoutBlock({
        id: `seq-block-${String(index + 1)}`,
        readingOrder: index,
        text: run.text,
        runIds: [run.id],
      })
    ),
  );

  const knowledge = buildKnowledgeDocument(layout, createSinglePageObservation(runs));

  assert.equal(knowledge.tables.length, 1);
  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "row-sequence");
  assert.deepEqual(table.headers, ["Item", "Count", "Result"]);
  assert.deepEqual(
    table.cells.map((cell) => [cell.rowIndex, cell.columnIndex, cell.text]),
    [
      [0, 0, "Item"],
      [0, 1, "Count"],
      [0, 2, "Result"],
      [1, 0, "Alpha"],
      [1, 1, "10"],
      [1, 2, "Pass"],
      [2, 0, "Beta"],
      [2, 1, "12"],
      [2, 2, "Review"],
    ],
  );
});

test("knowledge projects stacked header sequences from direct multiline header evidence", () => {
  const runs = [
    createObservedRun({ id: "stack-r1c1", contentOrder: 0, text: "1", fontSize: 10 }),
    createObservedRun({ id: "stack-r1c2", contentOrder: 1, text: "Printer", fontSize: 10 }),
    createObservedRun({ id: "stack-r1c3", contentOrder: 2, text: "Nova Limited", fontSize: 10 }),
    createObservedRun({ id: "stack-r1c4", contentOrder: 3, text: "1200", fontSize: 10 }),
    createObservedRun({ id: "stack-r1c5", contentOrder: 4, text: "Completed", fontSize: 10 }),
    createObservedRun({ id: "stack-r2c1", contentOrder: 5, text: "2", fontSize: 10 }),
    createObservedRun({ id: "stack-r2c2", contentOrder: 6, text: "Scanner", fontSize: 10 }),
    createObservedRun({ id: "stack-r2c3", contentOrder: 7, text: "Orion Services", fontSize: 10 }),
    createObservedRun({ id: "stack-r2c4", contentOrder: 8, text: "900", fontSize: 10 }),
    createObservedRun({ id: "stack-r2c5", contentOrder: 9, text: "Ongoing", fontSize: 10 }),
    createObservedRun({ id: "stack-h1", contentOrder: 10, text: "Serial", fontSize: 15 }),
    createObservedRun({ id: "stack-h2", contentOrder: 11, text: "Description", fontSize: 15 }),
    createObservedRun({ id: "stack-h3", contentOrder: 12, text: "Contractor", fontSize: 15 }),
    createObservedRun({ id: "stack-h4", contentOrder: 13, text: "Amount", fontSize: 15 }),
    createObservedRun({ id: "stack-h5", contentOrder: 14, text: "Status", fontSize: 15 }),
    createObservedRun({ id: "stack-h6", contentOrder: 15, text: "Notes", fontSize: 15 }),
  ];
  const layout = createSinglePageLayout([
    createLayoutBlock({
      id: "stack-body-1",
      readingOrder: 0,
      text: "1\nPrinter\nNova Limited\n1200\nCompleted",
      runIds: ["stack-r1c1", "stack-r1c2", "stack-r1c3", "stack-r1c4", "stack-r1c5"],
    }),
    createLayoutBlock({
      id: "stack-body-2",
      readingOrder: 1,
      text: "2\nScanner\nOrion Services\n900\nOngoing",
      runIds: ["stack-r2c1", "stack-r2c2", "stack-r2c3", "stack-r2c4", "stack-r2c5"],
    }),
    createLayoutBlock({
      id: "stack-head-a",
      readingOrder: 2,
      text: "Serial\nDescription",
      runIds: ["stack-h1", "stack-h2"],
      x: 72,
      y: 720,
      fontSize: 15,
    }),
    createLayoutBlock({
      id: "stack-head-b",
      readingOrder: 3,
      text: "Contractor",
      runIds: ["stack-h3", "stack-h6"],
      x: 190,
      y: 720,
      fontSize: 15,
    }),
    createLayoutBlock({
      id: "stack-head-c",
      readingOrder: 4,
      text: "Amount",
      runIds: ["stack-h4"],
      x: 320,
      y: 720,
      fontSize: 15,
    }),
    createLayoutBlock({
      id: "stack-head-d",
      readingOrder: 5,
      text: "Status",
      runIds: ["stack-h5"],
      x: 430,
      y: 720,
      fontSize: 15,
    }),
  ]);

  const knowledge = buildKnowledgeDocument(layout, createSinglePageObservation(runs));

  assert.equal(knowledge.tables.length, 1);
  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "stacked-header-sequence");
  assert.deepEqual(table.headers, ["Serial", "Description", "Contractor", "Amount", "Status"]);
  assert.deepEqual(
    table.cells.filter((cell) => cell.rowIndex === 2).map((cell) => cell.text),
    ["2", "Scanner", "Orion Services", "900", "Ongoing"],
  );
});

test("knowledge projects inline field-value rows without field-label duplication", () => {
  const layout = createSinglePageLayout([
    createLayoutBlock({ id: "fv-title", readingOrder: 0, text: "Request Details", role: "heading", fontSize: 20 }),
    createLayoutBlock({ id: "fv-name", readingOrder: 1, text: "Requester: Ada Lovelace" }),
    createLayoutBlock({ id: "fv-team", readingOrder: 2, text: "Team: Research" }),
    createLayoutBlock({ id: "fv-priority", readingOrder: 3, text: "Priority: High" }),
  ]);

  const knowledge = buildKnowledgeDocument(layout);

  assert.equal(knowledge.tables.length, 1);
  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "field-value-form");
  assert.deepEqual(table.headers, ["Field", "Value"]);
  assert.deepEqual(
    table.cells.filter((cell) => cell.rowIndex > 0).map((cell) => [cell.rowIndex, cell.columnIndex, cell.text]),
    [
      [1, 0, "Requester"],
      [1, 1, "Ada Lovelace"],
      [2, 0, "Team"],
      [2, 1, "Research"],
      [3, 0, "Priority"],
      [3, 1, "High"],
    ],
  );
  assert.equal(knowledge.forms.length, 1);
  const [form] = knowledge.forms;
  assert.ok(form);
  assert.equal(form.heuristic, "field-value-form");
  assert.equal(form.fields.length, 3);
  assert.deepEqual(
    form.fields.map((field) => [field.name, field.value, field.valueState]),
    [
      ["Requester", "Ada Lovelace", "value-present"],
      ["Team", "Research", "value-present"],
      ["Priority", "High", "value-present"],
    ],
  );
  assert.ok(form.fields.every((field) => field.citations.length > 0));
  assert.deepEqual(form.fields[0]?.blockIds, ["fv-name"]);
  assert.equal(form.fields[0]?.citations[0]?.sourceSpan?.text, "Requester");
  assert.equal(form.fields[0]?.citations[1]?.sourceSpan?.text, "Ada Lovelace");
});

test("knowledge projects field-label forms only when labels are spatially coherent", () => {
  const knowledge = buildKnowledgeDocument(
    createFieldLabelFormLayout(),
    createFieldLabelFormObservation(),
  );

  assert.equal(knowledge.tables.length, 1);
  assert.equal(knowledge.tables[0]?.heuristic, "field-label-form");
  assert.deepEqual(knowledge.tables[0]?.headers, ["Registration Form"]);
  assert.deepEqual(
    knowledge.tables[0]?.cells.filter((cell) => cell.rowIndex > 0).map((cell) => cell.text),
    ["Name:", "Department:", "Contact:", "Reviewer:"],
  );
  assert.equal(knowledge.forms.length, 1);
  assert.deepEqual(
    knowledge.forms[0]?.fields.map((field) => [field.name, field.value, field.valueState]),
    [
      ["Name", undefined, "not-observed"],
      ["Department", undefined, "not-observed"],
      ["Contact", undefined, "not-observed"],
      ["Reviewer", undefined, "not-observed"],
    ],
  );
  assert.equal(knowledge.forms[0]?.title, "Registration Form");
  assert.deepEqual(knowledge.forms[0]?.fields[0]?.blockIds, ["field-block-2"]);
});

test("knowledge projects contract award sequences with separated contractor and amount evidence", () => {
  const runs = [
    createObservedRun({ id: "award-h1", contentOrder: 0, text: "Serial No.", fontSize: 11 }),
    createObservedRun({ id: "award-h2", contentOrder: 1, text: "Contract Description", fontSize: 11 }),
    createObservedRun({ id: "award-h3", contentOrder: 2, text: "Contractor", fontSize: 11 }),
    createObservedRun({ id: "award-h4", contentOrder: 3, text: "Amount", fontSize: 11 }),
    createObservedRun({ id: "award-h5", contentOrder: 4, text: "Remarks", fontSize: 11 }),
    createObservedRun({ id: "award-r1a", contentOrder: 5, text: "1 Purchase of laptops", fontSize: 10 }),
    createObservedRun({ id: "award-r1b", contentOrder: 6, text: "AC/PC/2026", fontSize: 10 }),
    createObservedRun({ id: "award-r1c", contentOrder: 7, text: "Nova Limited", fontSize: 10 }),
    createObservedRun({ id: "award-r1d", contentOrder: 8, text: "1,200 GHS Completed", fontSize: 10 }),
    createObservedRun({ id: "award-r2a", contentOrder: 9, text: "2 Printer maintenance", fontSize: 10 }),
    createObservedRun({ id: "award-r2b", contentOrder: 10, text: "AC/PM/2026", fontSize: 10 }),
    createObservedRun({ id: "award-r2c", contentOrder: 11, text: "Orion Services", fontSize: 10 }),
    createObservedRun({ id: "award-r2d", contentOrder: 12, text: "900.00 GHS Ongoing", fontSize: 10 }),
  ];
  const layout = createSinglePageLayout(
    runs.map((run, index) =>
      createLayoutBlock({
        id: `award-block-${String(index + 1)}`,
        readingOrder: index,
        text: run.text,
        runIds: [run.id],
      })
    ),
  );

  const knowledge = buildKnowledgeDocument(layout, createSinglePageObservation(runs));

  assert.equal(knowledge.tables.length, 1);
  const [table] = knowledge.tables;
  assert.ok(table);
  assert.equal(table.heuristic, "contract-award-sequence");
  assert.deepEqual(table.headers, ["Serial No.", "Contract Description", "Contractor", "Amount", "Remarks"]);
  assert.deepEqual(
    table.cells.filter((cell) => cell.rowIndex === 1).map((cell) => cell.text),
    ["1", "Purchase of laptops", "Nova Limited", "1,200 GHS", "Completed"],
  );
  const tableChunkIndex = knowledge.chunks.findIndex((chunk) => chunk.text.includes("Serial No. | Contract Description"));
  const laterChunkIndex = knowledge.chunks.findIndex((chunk) => chunk.text.includes("2 Printer maintenance"));
  assert.notEqual(tableChunkIndex, -1);
  assert.ok(laterChunkIndex === -1 || tableChunkIndex <= laterChunkIndex);
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

test("knowledge does not project scattered field labels as a form table", () => {
  const texts = ["Registration Form", "Name:", "Department:", "Contact:", "Reviewer:"];
  const xPositions = [72, 72, 180, 360, 520];
  const layout = createSinglePageLayout(
    texts.map((text, index) => {
      const xPosition = xPositions[index] ?? 72;
      return createLayoutBlock({
        id: `scatter-block-${String(index + 1)}`,
        readingOrder: index,
        text,
        role: index === 0 ? "heading" : "body",
        runIds: [`scatter-run-${String(index + 1)}`],
        x: xPosition,
        y: 740 - index * 24,
        fontSize: index === 0 ? 22 : 12,
      });
    }),
  );
  const observation = createSinglePageObservation(
    texts.map((text, index) => {
      const xPosition = xPositions[index] ?? 72;
      return createObservedRun({
        id: `scatter-run-${String(index + 1)}`,
        contentOrder: index,
        text,
        x: xPosition,
        y: 740 - index * 24,
        fontSize: index === 0 ? 22 : 12,
      });
    }),
  );

  const knowledge = buildKnowledgeDocument(layout, observation);

  assert.equal(knowledge.tables.length, 0);
  assert.equal(knowledge.forms.length, 0);
});

test("knowledge does not project URL-like prose as field-value form data", () => {
  const layout = createSinglePageLayout([
    createLayoutBlock({ id: "url-title", readingOrder: 0, text: "Reference Notes", role: "heading", fontSize: 20 }),
    createLayoutBlock({ id: "url-1", readingOrder: 1, text: "https: example.org/reference" }),
    createLayoutBlock({ id: "url-2", readingOrder: 2, text: "ftp: archive.example.org" }),
    createLayoutBlock({ id: "url-3", readingOrder: 3, text: "This paragraph describes where source material can be found." }),
  ]);

  const knowledge = buildKnowledgeDocument(layout);

  assert.equal(knowledge.tables.length, 0);
  assert.equal(knowledge.forms.length, 0);
  assert.match(knowledge.extractedText, /source material/u);
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

function createSinglePageLayout(blocks: readonly PdfLayoutBlock[]): PdfLayoutDocument {
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
    extractedText: blocks.map((block) => block.text).join("\n"),
    knownLimits: [],
  };
}

function createLayoutBlock({
  id,
  readingOrder,
  text,
  role = "body",
  runIds,
  x,
  y,
  fontSize = 12,
}: {
  readonly id: string;
  readonly readingOrder: number;
  readonly text: string;
  readonly role?: PdfLayoutBlock["role"];
  readonly runIds?: readonly string[];
  readonly x?: number;
  readonly y?: number;
  readonly fontSize?: number;
}): PdfLayoutBlock {
  const resolvedRunIds = runIds ?? [`${id}-run`];
  return {
    id,
    pageNumber: 1,
    readingOrder,
    text,
    role,
    roleConfidence: role === "heading" ? 0.92 : 0.84,
    startsParagraph: true,
    runIds: resolvedRunIds,
    glyphIds: resolvedRunIds.map((runId) => `${runId}-glyph`),
    resolutionMethod: "page-tree",
    ...(x === undefined || y === undefined ? {} : { anchor: { x, y } }),
    fontSize,
  };
}

function createSinglePageObservation(runs: readonly PdfObservedTextRun[]): PdfObservedDocument {
  return {
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: runs.map((run) => run.text).join("\n"),
    knownLimits: [],
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        glyphs: [],
        runs,
        marks: [],
      },
    ],
  };
}

function createObservedRun({
  id,
  contentOrder,
  text,
  x = 72,
  y,
  fontSize = 12,
}: {
  readonly id: string;
  readonly contentOrder: number;
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
  readonly fontSize?: number;
}): PdfObservedTextRun {
  return {
    id,
    pageNumber: 1,
    contentOrder,
    text,
    glyphIds: [`${id}-glyph`],
    origin: "native-text",
    anchor: { x, y: y ?? 740 - contentOrder * 20 },
    fontSize,
    startsNewLine: true,
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
