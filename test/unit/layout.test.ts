import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PdfObservedDocument, PdfObservedTextRun } from "../../src/contracts.ts";
import { buildLayoutDocument, buildObservationParagraphText } from "../../src/layout.ts";

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

test("layout recognizes distinct narrow columns when their text regions overlap vertically", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-left-1", 0, "Left one", 40, 700),
    run("run-middle-1", 1, "Middle one", 135, 685),
    run("run-right-1", 2, "Right one", 230, 680),
    run("run-left-2", 3, "Left two", 40, 665),
    run("run-middle-2", 4, "Middle two", 135, 660),
    run("run-right-2", 5, "Right two", 230, 645),
  ]));

  assert.deepEqual(layout.pages[0]?.blocks.map((block) => block.text), [
    "Left one",
    "Left two",
    "Middle one",
    "Middle two",
    "Right one",
    "Right two",
  ]);
  assert.ok(layout.pages[0]?.blocks.every((block) =>
    block.inferences?.some((inference) => inference.method === "geometry-column-order")
  ));
});

test("layout does not mistake offset page boundaries for a text column", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Overview of Document Reading Order", 72, 700, 18),
    run("run-author", 1, "Example Author", 72, 670, 12),
    run("run-body", 2, "The body begins with material content for the reader.", 72, 620, 12),
    run("run-header", 3, "Working Papers on Information Systems", 250, 760, 14),
    run("run-footer", 4, "Publication archive reference", 250, 30, 10),
  ]));

  const blocks = layout.pages[0]?.blocks ?? [];
  assert.deepEqual(blocks.map((block) => block.text), [
    "Working Papers on Information Systems",
    "Overview of Document Reading Order",
    "Example Author",
    "The body begins with material content for the reader.",
    "Publication archive reference",
  ]);
  assert.ok(blocks.every((block) =>
    block.inferences?.some((inference) => inference.method === "geometry-line-order")
  ));
});

test("layout places a late-emitted table header above its rows using page geometry", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Demo Table", 72, 760, 20),
    run("run-row-1", 1, "1 Mouse 115.00", 72, 680, 12),
    run("run-row-2", 2, "3 Unicorn 250000.00", 72, 650, 12),
    run("run-header", 3, "Qty Description Price Amount", 72, 710, 14),
  ]));

  const texts = layout.pages[0]?.blocks.map((block) => block.text) ?? [];
  assert.deepEqual(texts.slice(0, 2), ["Demo Table", "Qty Description Price Amount"]);
  assert.deepEqual(texts.slice(2), ["1 Mouse 115.00", "3 Unicorn 250000.00"]);
});

test("layout preserves a paragraph break after a short sentence-ending tail line", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-tail", 0, "at.", 72, 700),
    run("run-next", 1, "This paper provides a historical overview of the model and later usage.", 96, 700),
  ]));

  assert.match(layout.extractedText, /at\.\n\nThis paper provides/u);
  assert.equal(layout.pages[0]?.blocks[1]?.startsParagraph, true);
  assert.ok(
    layout.pages[0]?.blocks[1]?.inferences?.some((inference) =>
      inference.kind === "paragraph-flow" &&
      inference.status === "inferred" &&
      inference.method === "paragraph-geometry"
    ),
  );
});

test("layout keeps ordinary sentence continuation lines in the same paragraph", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-previous", 0, "The first sentence ends here after a substantial line of context.", 72, 700),
    run("run-current", 1, "The same paragraph continues with another sentence on the next line.", 72, 688),
  ]));

  assert.doesNotMatch(layout.extractedText, /context\.\n\nThe same paragraph continues/u);
  assert.match(layout.extractedText, /context\. The same paragraph continues/u);
});

test("layout moves a leading carry-over tail before the next paragraph boundary", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-previous", 0, "The preceding line wraps at the final key term", 72, 700),
    run("run-tail-next", 1, "Model. This paper provides a separate overview of the subject.", 72, 660),
  ]));

  assert.match(layout.extractedText, /key term Model\.\n\nThis paper provides/u);
  assert.deepEqual(
    layout.pages[0]?.blocks.map((block) => ({
      text: block.text,
      startsParagraph: block.startsParagraph,
    })),
    [
      {
        text: "The preceding line wraps at the final key term",
        startsParagraph: true,
      },
      {
        text: "Model.",
        startsParagraph: false,
      },
      {
        text: "This paper provides a separate overview of the subject.",
        startsParagraph: true,
      },
    ],
  );
});

test("layout does not split abbreviation-like leading text as a carry-over tail", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-previous", 0, "The preceding line introduces the reviewer", 72, 700),
    run("run-abbreviation", 1, "Dr. Smith provides a separate overview of the subject.", 72, 660),
  ]));

  assert.match(layout.extractedText, /reviewer\n\nDr\. Smith provides/u);
  assert.deepEqual(layout.pages[0]?.blocks.map((block) => block.text), [
    "The preceding line introduces the reviewer",
    "Dr. Smith provides a separate overview of the subject.",
  ]);
});

test("layout does not split a leading tail when geometry does not support continuation", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-previous", 0, "The preceding line wraps at the final key term", 72, 700),
    run("run-other-column", 1, "Model. This paper provides a separate overview of the subject.", 300, 660),
  ]));

  assert.match(layout.extractedText, /key term\n\nModel\. This paper provides/u);
  assert.deepEqual(layout.pages[0]?.blocks.map((block) => block.text), [
    "The preceding line wraps at the final key term",
    "Model. This paper provides a separate overview of the subject.",
  ]);
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
  assert.match(layout.extractedText, /Project Header|Confidential Footer/u);
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

test("layout keeps repeated compact table boundaries out of footer role", () => {
  const layout = buildLayoutDocument({
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: "",
    knownLimits: [],
    pages: [1, 2].map((pageNumber) => ({
      pageNumber,
      resolutionMethod: "page-tree",
      glyphs: [],
      runs: [
        run(`run-p${String(pageNumber)}-party`, 0, "Supplier", 84, 150, 10, pageNumber),
        run(`run-p${String(pageNumber)}-method`, 1, "Selection method", 96, 132, 10, pageNumber),
        run(`run-p${String(pageNumber)}-amount`, 2, "Amount", 108, 114, 10, pageNumber),
        run(`run-p${String(pageNumber)}-remarks`, 3, "Status", 120, 96, 10, pageNumber),
        run(`run-p${String(pageNumber)}-row-1`, 4, `${String(20 + pageNumber)} Traffic signals ${String(38_000 + pageNumber)}.83`, 132, 76, 10, pageNumber),
        run(`run-p${String(pageNumber)}-row-2`, 5, `${String(30 + pageNumber)} Software licenses ${String(98_000 + pageNumber)}.82`, 144, 56, 10, pageNumber),
        run(`run-p${String(pageNumber)}-serial`, 6, "Item No. Description", 156, 36, 10, pageNumber),
      ],
      marks: [],
    })),
  });

  assert.ok(
    layout.pages.every((page) => {
      const repeatedHeader = page.blocks.find((block) => block.text === "Item No. Description");
      return repeatedHeader?.role === "heading" &&
        repeatedHeader.inferences?.some((inference) =>
          inference.kind === "structural-role" &&
          inference.method === "repeated-boundary-table-heading"
        );
    }),
  );
  assert.match(layout.extractedText, /Item No\. Description/u);
  assert.doesNotMatch(layout.pages.map((page) => page.blocks.at(-1)?.role).join(" "), /footer/u);
});

test("layout emits a provenance-backed table region from anchored header and row evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-specimen", 0, "Specimen", 72, 700),
    run("run-header-nominal", 1, "Nominal Width", 180, 700),
    run("run-header-measured", 2, "Measured Width", 310, 700),
    run("run-header-result", 3, "Result", 450, 700),
    run("run-row-alpha", 4, "Alpha 10.0 mm 10.4 mm pass", 72, 676),
    run("run-row-beta", 5, "Beta 12.0 mm 11.1 mm review", 72, 656),
    run("run-row-gamma", 6, "Gamma 8.0 mm 8.0 mm pass", 72, 636),
  ]));

  const page = layout.pages[0];
  const tableRegion = page?.regions?.find((region) => region.kind === "table");

  assert.ok(tableRegion);
  assert.equal(tableRegion?.pageNumber, 1);
  assert.ok((tableRegion?.confidence ?? 0) >= 0.7);
  assert.ok(tableRegion?.blockIds.length);
  assert.ok(tableRegion?.bbox);
  assert.ok(tableRegion?.inferences?.some((inference) =>
    inference.kind === "region" &&
    inference.method === "geometry-table" &&
    inference.status === "inferred" &&
    inference.evidenceRunIds.includes("run-header-specimen") &&
    inference.evidenceRunIds.includes("run-row-gamma")
  ));
});

test("layout keeps contract-award party cells inside the inferred table region", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-serial", 0, "Serial No. Contract Description", 72, 740),
    run("run-header-party", 1, "Contractor/Suppliers /Consultant", 220, 740),
    run("run-header-amount", 2, "Contract Amount", 360, 740),
    run("run-header-remarks", 3, "Remarks", 470, 740),
    run("run-description-1", 4, "24 Procurement of traffic engineering equipment", 72, 700),
    run("run-party-1", 5, "ICB Example Systems Limited Box 40", 220, 680),
    run("run-amount-1", 6, "38,192.83 GBP Completed", 360, 660),
    run("run-description-2", 7, "23 Procurement of software licenses", 72, 620),
    run("run-party-2", 8, "Shopping Sample Ghana Ltd Box 18", 220, 600),
    run("run-amount-2", 9, "98,439.82 GHS Completed", 360, 580),
    run("run-unrelated", 10, "Shopping guidance for the company appears in the appendix.", 72, 520),
  ]));

  const page = layout.pages[0];
  const tableRegion = page?.regions?.find((region) => region.kind === "table");
  const partyBlockIds = (page?.blocks ?? [])
    .filter((block) => /Example Systems|Sample Ghana/u.test(block.text))
    .map((block) => block.id);
  const unrelatedBlock = page?.blocks.find((block) => block.text.startsWith("Shopping guidance"));

  assert.ok(tableRegion);
  assert.equal(partyBlockIds.length, 2);
  assert.ok(partyBlockIds.every((blockId) => tableRegion.blockIds.includes(blockId)));
  assert.ok(unrelatedBlock);
  assert.ok(!tableRegion.blockIds.includes(unrelatedBlock.id));
});

test("layout classifies numbered section headings before table-row evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Dense Retrieval Paper", 72, 760, 16),
    run("run-metadata", 1, "CIKM 2021", 330, 700, 9),
    run("run-section", 2, "1 INTRODUCTION", 72, 700, 11),
    run(
      "run-body",
      3,
      "Search engine architectures often follow a cascading architecture [10, 18] with BM25 candidate retrieval.",
      72,
      680,
      9,
    ),
  ]));

  const sectionBlock = layout.pages[0]?.blocks.find((block) => block.text === "1 INTRODUCTION");
  const bodyBlock = layout.pages[0]?.blocks.find((block) => block.text.startsWith("Search engine architectures"));

  assert.equal(sectionBlock?.role, "heading");
  assert.equal(bodyBlock?.role, "body");
  assert.ok(layout.extractedText.indexOf("1 INTRODUCTION") < layout.extractedText.indexOf("Search engine architectures"));
});

test("layout keeps numbered table row descriptors as body evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-item", 0, "Item", 72, 700),
    run("run-header-amount", 1, "Amount", 200, 700),
    run("run-header-status", 2, "Status", 320, 700),
    run("run-row-label", 3, "1 Hardware", 72, 676),
    run("run-row-amount", 4, "$1200", 200, 676),
    run("run-row-status", 5, "paid", 320, 676),
    run("run-row-label-2", 6, "2 Services", 72, 652),
    run("run-row-amount-2", 7, "$900", 200, 652),
    run("run-row-status-2", 8, "pending", 320, 652),
  ]));

  const firstRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "1 Hardware");
  const tableRegion = layout.pages[0]?.regions?.find((region) => region.kind === "table");

  assert.equal(firstRowLabel?.role, "body");
  assert.ok(tableRegion);
});

test("layout keeps uppercase table row labels as body evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-code", 0, "Code", 72, 700),
    run("run-header-description", 1, "Description", 160, 700),
    run("run-header-amount", 2, "Amount", 320, 700),
    run("run-row-code", 3, "100040", 72, 676),
    run("run-row-label", 4, "BASE SALARY", 160, 676),
    run("run-row-amount", 5, "1200.00", 320, 676),
    run("run-row-code-2", 6, "109510", 72, 652),
    run("run-row-label-2", 7, "OVERTIME PAY", 160, 652),
    run("run-row-amount-2", 8, "85.50", 320, 652),
    run("run-row-code-3", 9, "699500", 72, 628),
    run("run-row-label-3", 10, "***TOTAL DUE***", 160, 628),
    run("run-row-amount-3", 11, "1285.50", 320, 628),
  ]));

  const firstRowCode = layout.pages[0]?.blocks.find((block) => block.text === "100040");
  const firstRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "BASE SALARY");
  const secondRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "OVERTIME PAY");
  const totalRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "***TOTAL DUE***");
  const header = layout.pages[0]?.blocks.find((block) => block.text === "Amount");
  const tableRegion = layout.pages[0]?.regions?.find((region) => region.kind === "table");

  assert.notEqual(firstRowCode?.role, "heading");
  assert.equal(firstRowLabel?.role, "body");
  assert.equal(secondRowLabel?.role, "body");
  assert.equal(totalRowLabel?.role, "body");
  assert.equal(header?.role, "heading");
  assert.ok(tableRegion);
  assert.ok(layout.pages[0]?.blocks.every((block) =>
    block.inferences?.some((inference) => inference.method === "geometry-line-order")
  ));
});

test("layout preserves compact row boundaries without hiding narrative evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-code", 0, "Rub", 72, 720),
    run("run-header-label", 1, "Label", 160, 720),
    run("run-header-base", 2, "Base or Count", 300, 720),
    run("run-notice-retain", 3, "Please retain this statement without limitation for your records.", 72, 680, 9),
    run("run-notice-reference", 4, "Refer to the document section available online for payroll details.", 72, 660, 9),
    run("run-row-base", 5, "BASE SALARY", 72, 620),
    run("run-row-overtime", 6, "Hrs overtime 25%", 72, 604),
    run("run-row-allowance", 7, "Allowance total", 72, 588),
    run("run-row-total", 8, "***TOTAL PAY***", 72, 572),
  ]));

  const retentionNotice = layout.pages[0]?.blocks.find((block) => block.text.startsWith("Please retain"));
  const referenceNotice = layout.pages[0]?.blocks.find((block) => block.text.startsWith("Refer to the document"));
  const baseRow = layout.pages[0]?.blocks.find((block) => block.text === "BASE SALARY");
  const overtimeRow = layout.pages[0]?.blocks.find((block) => block.text === "Hrs overtime 25%");
  const totalRow = layout.pages[0]?.blocks.find((block) => block.text === "***TOTAL PAY***");

  assert.equal(retentionNotice?.role, "body");
  assert.equal(referenceNotice?.role, "body");
  assert.equal(baseRow?.startsParagraph, true);
  assert.equal(overtimeRow?.startsParagraph, true);
  assert.equal(totalRow?.startsParagraph, true);
  assert.match(layout.extractedText, /BASE SALARY\n\nHrs overtime 25%/u);
  assert.match(layout.extractedText, /retain this statement|available online/u);
});

test("layout keeps uppercase section labels as headings beside narrative text", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Dense Retrieval Paper", 72, 740, 16),
    run("run-section", 1, "ABSTRACT", 72, 700, 11),
    run(
      "run-other-column",
      2,
      "A related paragraph mentions results [11] while sharing a similar baseline in another column.",
      330,
      700,
      10,
    ),
    run(
      "run-body",
      3,
      "This paragraph introduces the topic and should remain body text under the section label.",
      72,
      680,
      10,
    ),
  ]));

  const section = layout.pages[0]?.blocks.find((block) => block.text === "ABSTRACT");
  const body = layout.pages[0]?.blocks.find((block) => block.text.startsWith("This paragraph introduces"));

  assert.equal(section?.role, "heading");
  assert.equal(body?.role, "body");
});

test("layout classifies leaflet titles after production metadata as headings", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-diecut", 0, "1-DIECUT", 72, 760, 1),
    run("run-revision", 1, "1 01.01.2026 124X640 GI-100-2026-01-P", 72, 744, 1),
    run("run-name", 2, "Pr. Name: Examplemed 6mg/ml Concentrate", 72, 728, 1),
    run("run-code", 3, "ACME PACKAGE LEAFLET EXAMPLEMED", 72, 712, 1),
    run("run-colours", 4, "Non Printing colours:", 72, 696, 1),
    run("run-component", 5, "Min. Pt. Size: Text Font: Braille Text: PZN: Supplier: Component: INN:", 72, 680, 1),
    run("run-title", 6, "PATIENT INFORMATION: Examplemed 6 mg/ml", 72, 640, 10),
    run("run-body", 7, "Read all of this leaflet carefully before you start using this medicine.", 72, 612, 10),
  ]));

  const title = layout.pages[0]?.blocks.find((block) => block.text === "PATIENT INFORMATION: Examplemed 6 mg/ml");
  const body = layout.pages[0]?.blocks.find((block) => block.text.startsWith("Read all of this leaflet"));

  assert.equal(title?.role, "heading");
  assert.equal(body?.role, "body");
});

test("layout keeps title-case table row descriptors as body with row evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-header-qty", 0, "Qty", 72, 720, 16),
    run("run-header-description", 1, "Description", 180, 720, 16),
    run("run-header-amount", 2, "Amount", 320, 720, 16),
    run("run-row-qty", 3, "1", 72, 692),
    run("run-row-description", 4, "Mouse", 180, 692),
    run("run-row-amount", 5, "$115.00", 320, 692),
    run("run-row-qty-2", 6, "3", 72, 670),
    run("run-row-description-2", 7, "Unicorn", 180, 670),
    run("run-row-amount-2", 8, "$750,000.00", 320, 670),
  ]));

  const header = layout.pages[0]?.blocks.find((block) => block.text === "Qty");
  const firstRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "Mouse");
  const secondRowLabel = layout.pages[0]?.blocks.find((block) => block.text === "Unicorn");

  assert.equal(header?.role, "heading");
  assert.equal(firstRowLabel?.role, "body");
  assert.equal(secondRowLabel?.role, "body");
});

test("layout keeps contents entry labels as headings beside page references", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Contents", 72, 720, 18),
    run("run-entry-introduction", 1, "Introduction", 72, 688),
    run("run-page-introduction", 2, "1", 300, 688),
    run("run-entry-installation", 3, "Installation", 72, 664),
    run("run-page-installation", 4, "2", 300, 664),
  ]));

  const introduction = layout.pages[0]?.blocks.find((block) => block.text === "Introduction");
  const installation = layout.pages[0]?.blocks.find((block) => block.text === "Installation");

  assert.equal(introduction?.role, "heading");
  assert.equal(installation?.role, "heading");
});

test("layout does not emit a table region from incidental numeric prose", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Quarterly Amount Review", 72, 700, 16),
    run("run-body-1", 1, "The report mentions an amount and remarks in a narrative paragraph.", 72, 670),
    run("run-body-2", 2, "The specimen was reviewed, but no table headers or row grid are present.", 72, 648),
  ]));

  assert.deepEqual(layout.pages[0]?.regions ?? [], []);
});

test("layout emits a conservative form-like region from repeated field evidence", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Application Form", 72, 700, 16),
    run("run-name-label", 1, "Name:", 72, 668),
    run("run-name-value", 2, "Alex Doe", 170, 668),
    run("run-date-label", 3, "Date:", 72, 646),
    run("run-date-value", 4, "2026-05-15", 170, 646),
    run("run-signature-label", 5, "Signature:", 72, 624),
    run("run-signature-value", 6, "Signed", 170, 624),
  ]));

  const formRegion = layout.pages[0]?.regions?.find((region) => region.kind === "form-like");

  assert.ok(formRegion);
  assert.ok((formRegion?.confidence ?? 1) < 0.75);
  assert.ok(formRegion?.blockIds.includes("block-1-2"));
  assert.ok(formRegion?.inferences?.some((inference) =>
    inference.kind === "region" &&
    inference.method === "field-cluster" &&
    inference.evidenceRunIds.includes("run-signature-label")
  ));
});

test("layout orders compact form field labels by geometry when producer order is unstable", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Registration Form", 72, 760, 18),
    run("run-city", 1, "City: Preferred City:", 310, 700),
    run("run-name-date", 2, "First Name: Last Name: Birth Date:", 72, 724),
    run("run-prompt", 3, "1) Please tell us about yourself:", 72, 660),
    run("run-gender", 4, "female male non-binary Gender:", 72, 700),
  ]));

  const firstNameIndex = layout.extractedText.indexOf("First Name:");
  const genderIndex = layout.extractedText.indexOf("Gender:");
  const cityIndex = layout.extractedText.indexOf("City:");

  assert.ok(firstNameIndex >= 0);
  assert.ok(genderIndex > firstNameIndex);
  assert.ok(cityIndex > genderIndex);
  assert.ok(
    layout.pages[0]?.blocks.some((block) =>
      block.text === "First Name: Last Name: Birth Date:" &&
      block.inferences?.some((inference) =>
        inference.kind === "reading-order" &&
        inference.method === "geometry-line-order" &&
        inference.status === "inferred"
      )
    ),
  );
});

test("layout orders vertical field groups by page geometry", () => {
  const layout = buildLayoutDocument(createObservation([
    run("run-title", 0, "Registration Form", 340, 0, 18, 1, "vertical"),
    run("run-field-a", 1, "Field A:", 300, 0, 12, 1, "vertical"),
    run("run-field-b", 2, "Field B:", 200, 0, 12, 1, "vertical"),
    run("run-field-c", 3, "Field C:", 100, 0, 12, 1, "vertical"),
  ]));

  const fieldAIndex = layout.extractedText.indexOf("Field A:");
  const fieldBIndex = layout.extractedText.indexOf("Field B:");
  const fieldCIndex = layout.extractedText.indexOf("Field C:");

  assert.ok(fieldAIndex >= 0);
  assert.ok(fieldBIndex > fieldAIndex);
  assert.ok(fieldCIndex > fieldBIndex);
  assert.ok(
    layout.pages[0]?.blocks.some((block) =>
      block.text === "Field A:" &&
      block.inferences?.some((inference) =>
        inference.kind === "reading-order" &&
        inference.method === "geometry-line-order" &&
        inference.status === "inferred"
      )
    ),
  );
});

test("layout keeps repeated compact form titles as headings", () => {
  const layout = buildLayoutDocument({
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: "",
    knownLimits: [],
    pages: [1, 2].map((pageNumber) => ({
      pageNumber,
      resolutionMethod: "page-tree",
      glyphs: [],
      runs: [
        run(`run-p${String(pageNumber)}-title`, 0, "Registration Form", 0, 6, 20, pageNumber, "vertical"),
        run(`run-p${String(pageNumber)}-prompt`, 1, "1) Applicant details:", 0, 3, 14, pageNumber, "vertical"),
        run(`run-p${String(pageNumber)}-first-name`, 2, "First Name:", 0, 4.2, 10, pageNumber, "vertical"),
        run(`run-p${String(pageNumber)}-gender`, 3, "Gender:", 0, 3, 12, pageNumber, "vertical"),
        run(`run-p${String(pageNumber)}-city`, 4, "City:", 0, 8, 10, pageNumber, "vertical"),
      ],
      marks: [],
    })),
  });

  assert.ok(
    layout.pages.every((page) => {
      const titleBlock = page.blocks.find((block) => block.text === "Registration Form");
      return titleBlock?.role === "heading" &&
        titleBlock.inferences?.some((inference) =>
          inference.kind === "structural-role" &&
          inference.method === "repeated-boundary-heading"
        );
    }),
  );
});

test("layout grouping remains order-independent when paragraph text and layout are both requested", () => {
  const runs = [
    run("run-left-1", 0, "Left column begins the first paragraph", 72, 700),
    run("run-right-1", 1, "Right column begins after the left column", 340, 700),
    run("run-left-2", 2, "Left column continues with stable ordering", 72, 684),
    run("run-right-2", 3, "Right column continues without changing output", 340, 684),
  ];
  const paragraphFirstObservation = createObservation(runs);
  const layoutFirstObservation = createObservation(runs);

  const paragraphFirstText = buildObservationParagraphText(paragraphFirstObservation);
  const paragraphFirstLayout = buildLayoutDocument(paragraphFirstObservation);
  const layoutFirstLayout = buildLayoutDocument(layoutFirstObservation);
  const layoutFirstText = buildObservationParagraphText(layoutFirstObservation);

  assert.equal(paragraphFirstText, layoutFirstText);
  assert.equal(paragraphFirstText, paragraphFirstLayout.extractedText);
  assert.equal(layoutFirstText, layoutFirstLayout.extractedText);
  assert.deepEqual(
    paragraphFirstLayout.pages[0]?.blocks.map((block) => ({
      text: block.text,
      readingOrder: block.readingOrder,
      runIds: block.runIds,
      glyphIds: block.glyphIds,
      role: block.role,
      roleConfidence: block.roleConfidence,
    })),
    layoutFirstLayout.pages[0]?.blocks.map((block) => ({
      text: block.text,
      readingOrder: block.readingOrder,
      runIds: block.runIds,
      glyphIds: block.glyphIds,
      role: block.role,
      roleConfidence: block.roleConfidence,
    })),
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
  writingMode?: PdfObservedTextRun["writingMode"],
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
    ...(writingMode !== undefined ? { writingMode } : {}),
  };
}
