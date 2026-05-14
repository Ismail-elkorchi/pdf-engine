import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PdfObservedDocument, PdfObservedTextRun } from "../../src/contracts.ts";
import { buildLayoutDocument } from "../../src/layout.ts";

test("layout orders anchored multi-column text by column and records inference evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-left-1", 0, "Left column begins with a long technical paragraph", 72, 700),
    run("run-right-1", 1, "Right column starts after the left column should finish", 330, 700),
    run("run-left-2", 2, "continues in the left column without a paragraph break", 72, 684),
    run("run-right-2", 3, "continues in the right column without interrupting the left", 330, 684),
  ]));

  const blocks = layout.pages[0]?.blocks ?? [];

  assert.deepEqual(blocks.map((block) => block.text), [
    "Left column begins with a long technical paragraph",
    "continues in the left column without a paragraph break",
    "Right column starts after the left column should finish",
    "continues in the right column without interrupting the left",
  ]);
  assert.deepEqual(blocks.map((block) => block.readingOrder), [0, 1, 2, 3]);
  assert.equal(blocks[1]?.startsParagraph, false);
  assert.equal(blocks[0]?.bbox?.x, 72);
  assert.ok(
    blocks.every((block) =>
      block.inferences?.some((inference) =>
        inference.kind === "reading-order" &&
        inference.status === "inferred" &&
        inference.method === "geometry-column-order" &&
        inference.evidenceRunIds.length > 0
      )
    ),
  );
  assert.ok(
    blocks[1]?.inferences?.some((inference) =>
      inference.kind === "paragraph-flow" &&
      inference.status === "inferred" &&
      inference.method === "paragraph-geometry"
    ),
  );
  assert.match(layout.extractedText, /Left column begins[\s\S]*continues in the left column[\s\S]*Right column starts/u);
});

test("layout separates repeated page boundaries from body flow without dropping source blocks", () => {
  const layout = buildLayoutDocument({
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: "",
    knownLimits: [],
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        glyphs: [],
        runs: [
          run("run-p1-header", 0, "Project Header", 72, 760, 9, 1),
          run("run-p1-body", 1, "First page body paragraph with material content", 72, 700, 12, 1),
          run("run-p1-footer", 2, "Confidential Footer", 72, 36, 9, 1),
        ],
        marks: [],
      },
      {
        pageNumber: 2,
        resolutionMethod: "page-tree",
        glyphs: [],
        runs: [
          run("run-p2-header", 0, "Project Header", 72, 760, 9, 2),
          run("run-p2-body", 1, "Second page body paragraph with different content", 72, 700, 12, 2),
          run("run-p2-footer", 2, "Confidential Footer", 72, 36, 9, 2),
        ],
        marks: [],
      },
    ],
  });

  const firstPageBlocks = layout.pages[0]?.blocks ?? [];
  const secondPageBlocks = layout.pages[1]?.blocks ?? [];

  assert.deepEqual(firstPageBlocks.map((block) => block.role), ["header", "body", "footer"]);
  assert.deepEqual(secondPageBlocks.map((block) => block.role), ["header", "body", "footer"]);
  assert.equal(firstPageBlocks[0]?.text, "Project Header");
  assert.equal(firstPageBlocks[2]?.text, "Confidential Footer");
  assert.doesNotMatch(layout.extractedText, /Project Header|Confidential Footer/u);
  assert.match(layout.extractedText, /First page body paragraph/u);
  assert.match(layout.extractedText, /Second page body paragraph/u);
  assert.ok(
    firstPageBlocks[0]?.inferences?.some((inference) =>
      inference.kind === "structural-role" &&
      inference.method === "repeated-boundary" &&
      inference.evidenceRunIds.includes("run-p1-header")
    ),
  );
});

function createObservation(runs: readonly PdfObservedTextRun[]): PdfObservedDocument {
  return {
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: runs.map((candidate) => candidate.text).join("\n"),
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

function run(
  id: string,
  contentOrder: number,
  text: string,
  x: number,
  y: number,
  fontSize = 12,
  pageNumber = 1,
): PdfObservedTextRun {
  return {
    id,
    pageNumber,
    contentOrder,
    text,
    glyphIds: [`glyph-${id}`],
    origin: "native-text",
    anchor: { x, y },
    bbox: {
      x,
      y: y - fontSize,
      width: Math.min(168, Math.max(12, text.length * fontSize * 0.32)),
      height: fontSize,
    },
    fontSize,
    startsNewLine: true,
  };
}
