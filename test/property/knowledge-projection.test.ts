import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  PdfLayoutBlock,
  PdfLayoutDocument,
} from "../../src/contracts.ts";
import { buildKnowledgeDocument } from "../../src/knowledge.ts";

test("adding unrelated later prose does not change prior knowledge identifiers", () => {
  const baseLayout = createTableFixtureLayout();
  const extendedLayout = appendBlock(baseLayout, createBlock({
    id: "later-prose",
    readingOrder: 11,
    text: "Later unrelated prose that should become its own downstream evidence.",
    role: "body",
    x: 72,
    y: 620,
  }));

  const baseKnowledge = buildKnowledgeDocument(baseLayout);
  const extendedKnowledge = buildKnowledgeDocument(extendedLayout);

  assert.equal(extendedKnowledge.chunks[0]?.id, baseKnowledge.chunks[0]?.id);
  assert.equal(extendedKnowledge.tables[0]?.id, baseKnowledge.tables[0]?.id);
  assert.deepEqual(
    extendedKnowledge.tables[0]?.cells.map((cell) => cell.citations.map((citation) => citation.id)),
    baseKnowledge.tables[0]?.cells.map((cell) => cell.citations.map((citation) => citation.id)),
  );
});

test("repeated page boundaries do not enter knowledge chunks or markdown", () => {
  const layout = createMultiPageLayout([
    [
      createBlock({ id: "p1-header", pageNumber: 1, readingOrder: 0, text: "Program Header", role: "header", x: 72, y: 760 }),
      createBlock({ id: "p1-body", pageNumber: 1, readingOrder: 1, text: "First page body evidence.", role: "body", x: 72, y: 720 }),
      createBlock({ id: "p1-footer", pageNumber: 1, readingOrder: 2, text: "Page footer", role: "footer", x: 72, y: 40 }),
    ],
    [
      createBlock({ id: "p2-header", pageNumber: 2, readingOrder: 0, text: "Program Header", role: "header", x: 72, y: 760 }),
      createBlock({ id: "p2-body", pageNumber: 2, readingOrder: 1, text: "Second page body evidence.", role: "body", x: 72, y: 720 }),
      createBlock({ id: "p2-footer", pageNumber: 2, readingOrder: 2, text: "Page footer", role: "footer", x: 72, y: 40 }),
    ],
  ]);

  const knowledge = buildKnowledgeDocument(layout);

  assert.doesNotMatch(knowledge.extractedText, /Program Header|Page footer/u);
  assert.doesNotMatch(knowledge.markdown, /Program Header|Page footer/u);
  assert.deepEqual(knowledge.chunks.flatMap((chunk) => chunk.blockIds), ["p1-body", "p2-body"]);
});

test("projected table markdown stays at the table source position", () => {
  const layout = createTableFixtureLayout([
    createBlock({ id: "opening", readingOrder: 1, text: "Opening paragraph before the table.", role: "body", x: 72, y: 744 }),
  ], [
    createBlock({ id: "closing", readingOrder: 11, text: "Closing paragraph after the table.", role: "body", x: 72, y: 620 }),
  ]);

  const knowledge = buildKnowledgeDocument(layout);
  const openingIndex = knowledge.markdown.indexOf("Opening paragraph before the table.");
  const tableIndex = knowledge.markdown.indexOf("| Item | Quantity | Status |");
  const closingIndex = knowledge.markdown.indexOf("Closing paragraph after the table.");

  assert.ok(openingIndex >= 0);
  assert.ok(tableIndex > openingIndex);
  assert.ok(closingIndex > tableIndex);
  assert.equal(knowledge.markdown.match(/^Item$/gmu)?.length ?? 0, 0);
  assert.equal(knowledge.markdown.match(/^Alpha$/gmu)?.length ?? 0, 0);
});

function createTableFixtureLayout(
  beforeTableBlocks: readonly PdfLayoutBlock[] = [],
  afterTableBlocks: readonly PdfLayoutBlock[] = [],
): PdfLayoutDocument {
  return createSinglePageLayout([
    createBlock({ id: "title", readingOrder: 0, text: "Inventory Summary", role: "heading", x: 72, y: 770, fontSize: 18 }),
    ...beforeTableBlocks,
    createBlock({ id: "h-item", readingOrder: 2, text: "Item", x: 72, y: 720 }),
    createBlock({ id: "h-qty", readingOrder: 3, text: "Quantity", x: 180, y: 720 }),
    createBlock({ id: "h-status", readingOrder: 4, text: "Status", x: 300, y: 720 }),
    createBlock({ id: "r1-item", readingOrder: 5, text: "Alpha", x: 72, y: 696 }),
    createBlock({ id: "r1-qty", readingOrder: 6, text: "10", x: 180, y: 696 }),
    createBlock({ id: "r1-status", readingOrder: 7, text: "Active", x: 300, y: 696 }),
    createBlock({ id: "r2-item", readingOrder: 8, text: "Beta", x: 72, y: 672 }),
    createBlock({ id: "r2-qty", readingOrder: 9, text: "12", x: 180, y: 672 }),
    createBlock({ id: "r2-status", readingOrder: 10, text: "Pending", x: 300, y: 672 }),
    ...afterTableBlocks,
  ]);
}

function createSinglePageLayout(blocks: readonly PdfLayoutBlock[]): PdfLayoutDocument {
  return createMultiPageLayout([blocks]);
}

function createMultiPageLayout(pages: readonly (readonly PdfLayoutBlock[])[]): PdfLayoutDocument {
  return {
    kind: "pdf-layout",
    strategy: "line-blocks",
    pages: pages.map((blocks, index) => ({
      pageNumber: index + 1,
      resolutionMethod: "page-tree",
      blocks,
    })),
    extractedText: pages.flat().map((block) => block.text).join("\n"),
    knownLimits: [],
  };
}

function appendBlock(layout: PdfLayoutDocument, block: PdfLayoutBlock): PdfLayoutDocument {
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

function createBlock({
  id,
  pageNumber = 1,
  readingOrder,
  text,
  role = "body",
  x,
  y,
  fontSize = 12,
}: {
  readonly id: string;
  readonly pageNumber?: number;
  readonly readingOrder: number;
  readonly text: string;
  readonly role?: PdfLayoutBlock["role"];
  readonly x: number;
  readonly y: number;
  readonly fontSize?: number;
}): PdfLayoutBlock {
  const runId = `${id}-run`;
  return {
    id,
    pageNumber,
    readingOrder,
    text,
    role,
    roleConfidence: role === "heading" ? 0.92 : 0.84,
    startsParagraph: true,
    runIds: [runId],
    glyphIds: [`${runId}-glyph`],
    resolutionMethod: "page-tree",
    anchor: { x, y },
    fontSize,
  };
}
