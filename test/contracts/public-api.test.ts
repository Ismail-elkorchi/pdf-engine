import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine, type PdfDocument, type PdfResult } from "../../src/index.ts";
import {
  buildPdfWithImageResource,
  buildPdfWithCyclicPageBranch,
  buildPdfWithInvalidSignature,
  buildPdfWithMultipleDirectActions,
  buildPdfWithNativeFeatures,
  buildPdfWithPageContents,
  buildPdfWithPageSpecs,
  buildPdfWithSplitContentInstruction,
} from "../shared/pdf-builders.ts";

function valueOf<T>(result: PdfResult<T>): T {
  if (result.status !== "completed" && result.status !== "partial") {
    assert.fail(`Expected a value result, received ${result.status}.`);
  }
  return result.value;
}

async function openTextDocument(text: string): Promise<{ readonly engine: ReturnType<typeof createPdfEngine>; readonly document: PdfDocument }> {
  const engine = createPdfEngine();
  const result = await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageContents([`BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(${text}) Tj\nET`]),
      fileName: "public-api.pdf",
    },
  });
  return { engine, document: valueOf(result) };
}

test("the public surface exposes one cached read session", async () => {
  const { engine, document } = await openTextDocument("Session Text");
  assert.deepEqual(engine.identity, {
    name: "@ismail-elkorchi/pdf-engine",
    version: "0.1.0",
    mode: "read",
    supportedRuntimes: ["node", "deno", "bun", "web"],
  });
  assert.equal(document.summary.pageCount, 1);
  assert.equal(document.summary.pdfVersion, "1.4");
  assert.equal(document.permissions.copy, true);

  const first = valueOf(await document.extract());
  const second = valueOf(await document.extract());
  assert.equal(first, second);
  assert.equal(first.extractedText, "Session Text");

  const layout = valueOf(await document.layout());
  const knowledge = valueOf(await document.knowledge());
  assert.equal(layout.pages.length, 1);
  assert.match(knowledge.markdown, /Session Text/u);

  const search = valueOf(await document.search({ query: "session", caseSensitive: false }));
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.text, "Session");

  const read = valueOf(await document.read({ maxCharacters: 7 }));
  assert.equal(read.characterCount, 7);
  assert.equal(read.fragments.map((fragment) => fragment.text).join(""), "Session");
  assert.deepEqual(read.nextCursor, {
    pageNumber: 1,
    fragmentId: read.fragments[0]?.id,
    characterOffset: 7,
  });
  const resumed = valueOf(await document.read({ maxCharacters: 20, cursor: read.nextCursor }));
  assert.equal(resumed.fragments.map((fragment) => fragment.text).join(""), " Text");

  await document.dispose();
  await assert.rejects(async () => document.structure(), /disposed/u);
  await engine.dispose();
});

test("image resources and their page placements are explicit read products", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: { kind: "bytes", bytes: buildPdfWithImageResource() },
  }));
  const images = valueOf(await document.images({ includeBytes: true }));
  assert.equal(images.resources.length, 1);
  assert.equal(images.placements.length, 1);
  assert.deepEqual(images.resources[0]?.objectRef, { objectNumber: 20, generationNumber: 0 });
  assert.deepEqual(images.resources[0]?.bytes, new Uint8Array([65]));
  assert.equal(images.resources[0]?.interpolate, true);
  assert.deepEqual(images.placements[0]?.bounds, { x: 144, y: 600, width: 12, height: 12 });
  assert.equal(images.placements[0]?.resourceId, images.resources[0]?.id);
  assert.equal(images.placements[0]?.pageNumber, 1);
  await engine.dispose();
});

test("native feature catalogs and accessibility content remain typed and searchable", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: { kind: "bytes", bytes: buildPdfWithNativeFeatures() },
  }));
  const features = valueOf(await document.features());
  assert.equal(features.metadata.title, "Feature Catalog");
  assert.equal(features.metadata.author, "PDF Engine");
  assert.equal(features.metadata.custom["Department"], "Research");
  assert.match(features.metadata.xmp?.text ?? "", /Catalog XMP/u);
  assert.deepEqual(features.namedDestinations, [{
    name: "intro",
    destination: {
      pageRef: { objectNumber: 4, generationNumber: 0 },
      pageNumber: 1,
      mode: "Fit",
      parameters: [],
    },
  }]);
  assert.deepEqual(features.pageLabels, [{
    pageNumber: 1,
    label: "A-iii",
    prefix: "A-",
    style: "roman-lower",
    sequenceNumber: 3,
  }]);
  assert.equal(features.structureTree[0]?.role, "P");
  assert.equal(features.structureTree[0]?.children[0]?.markedContentId, 0);

  const accessibility = valueOf(await document.search({ query: "alternative", channels: ["accessibility"] }));
  assert.equal(accessibility.matches[0]?.channel, "accessibility");
  assert.equal(accessibility.matches[0]?.pageNumber, 1);
  const metadata = valueOf(await document.search({ query: "Research", channels: ["metadata"] }));
  assert.equal(metadata.matches[0]?.pageNumber, undefined);
  assert.equal(metadata.matches[0]?.channel, "metadata");
  await engine.dispose();
});

test("direct security-relevant actions receive distinct deterministic identifiers", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: { kind: "bytes", bytes: buildPdfWithMultipleDirectActions() },
    policy: {
      javascriptActions: "report",
      launchActions: "report",
    },
  }));

  const first = valueOf(await document.features()).activeContent;
  const second = valueOf(await document.features()).activeContent;

  assert.equal(first, second);
  assert.deepEqual(first.map((item) => item.kind), ["javascript", "javascript", "launch"]);
  assert.equal(new Set(first.map((item) => item.id)).size, first.length);
  await engine.dispose();
});

test("signature verification rejects byte ranges that do not cover the document", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: { kind: "bytes", bytes: buildPdfWithInvalidSignature() },
  }));
  const features = valueOf(await document.features());
  assert.equal(features.signatures.length, 1);
  const verification = valueOf(await document.verifySignatures({
    trustPolicy: { trustAnchors: [], validationTime: new Date("2026-01-01T00:00:00Z") },
  }));
  assert.equal(verification[0]?.integrity, "invalid");
  assert.equal(verification[0]?.diagnostics[0]?.code, "signature-verification-failed");
  assert.match(verification[0]?.diagnostics[0]?.message ?? "", /ByteRange/u);
  await engine.dispose();
});

test("bytes, Blob, and random-access sources have equivalent semantics", async () => {
  const bytes = buildPdfWithPageContents(["BT\n/F1 12 Tf\n(Source Equivalence) Tj\nET"]);
  const engine = createPdfEngine();
  const sources = [
    { kind: "bytes" as const, bytes },
    { kind: "blob" as const, blob: new Blob([Uint8Array.from(bytes).buffer], { type: "application/pdf" }) },
    {
      kind: "random-access" as const,
      byteLength: bytes.byteLength,
      read: async ({ offset, length }: { readonly offset: number; readonly length: number }) =>
        Uint8Array.from(bytes.subarray(offset, offset + length)),
    },
  ];
  const texts: string[] = [];
  for (const source of sources) {
    const document = valueOf(await engine.open({ source }));
    texts.push(valueOf(await document.extract()).extractedText);
  }
  assert.deepEqual(texts, ["Source Equivalence", "Source Equivalence", "Source Equivalence"]);
  await engine.dispose();
});

test("page-scoped extraction does not read unrelated random-access streams", async () => {
  const largeUnrelatedText = "x".repeat(2_000_000);
  const bytes = buildPdfWithPageContents([
    "BT\n/F1 12 Tf\n(Page One) Tj\nET",
    `BT\n/F1 12 Tf\n(${largeUnrelatedText}) Tj\nET`,
    "BT\n/F1 12 Tf\n(Page Three) Tj\nET",
  ]);
  let bytesRead = 0;
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "random-access",
      byteLength: bytes.byteLength,
      read: async ({ offset, length }) => {
        bytesRead += length;
        return Uint8Array.from(bytes.subarray(offset, offset + length));
      },
    },
  }));

  const observation = valueOf(await document.extract({
    pages: { kind: "numbers", pages: [1] },
  }));

  assert.equal(observation.extractedText, "Page One");
  assert.deepEqual(observation.pages.map((page) => page.pageNumber), [1]);
  assert.ok(bytesRead < bytes.byteLength / 4, `read ${String(bytesRead)} of ${String(bytes.byteLength)} bytes`);
  await engine.dispose();
});

test("low-level object and stream access preserve typed values and source bytes", async () => {
  const { engine, document } = await openTextDocument("Typed Values");
  const catalog = valueOf(await document.object({ ref: document.summary.root }));
  assert.equal(catalog.value.kind, "dictionary");
  const content = valueOf(await document.stream({ ref: { objectNumber: 5, generationNumber: 0 } }));
  assert.equal(content.decoded, false);
  assert.match(new TextDecoder().decode(content.bytes), /Typed Values/u);
  await engine.dispose();
});

test("page content arrays remain one instruction sequence with source provenance", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: { kind: "bytes", bytes: buildPdfWithSplitContentInstruction() },
  }));
  const observation = valueOf(await document.extract());
  assert.equal(observation.extractedText, "Split Stream");
  assert.deepEqual(observation.pages[0]?.runs[0]?.contentStreamRef, { objectNumber: 5, generationNumber: 0 });
  await engine.dispose();
});

test("marked content preserves explicit spaces across text-array operands", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageContents([
        "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n/P BMC\n[(Lorem ) -8 (Ipsum) 12 ( text ) -4 (with lists)] TJ\nEMC\nET",
      ]),
    },
  }));
  assert.equal(valueOf(await document.extract()).extractedText, "Lorem Ipsum text with lists");
  await engine.dispose();
});

test("text-array adjustments distinguish kerning from omitted word spaces", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageContents([
        "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n[(reser) -25 (ved) -240 (rights)] TJ\nET",
      ]),
    },
  }));
  assert.equal(valueOf(await document.extract()).extractedText, "reserved rights");
  await engine.dispose();
});

test("text anchors and font sizes are expressed in page space", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageContents([
        "q\n1 0 0 1 30 700 cm\nBT\n/F1 1 Tf\n12 0 0 12 0 0 Tm\n0 2 Td\n(Page Space) Tj\nET\nQ",
      ]),
    },
  }));
  const run = valueOf(await document.extract()).pages[0]?.runs[0];
  assert.deepEqual(run?.anchor, { x: 30, y: 724 });
  assert.equal(run?.fontSize, 12);
  await engine.dispose();
});

test("short horizontal rows are not misclassified as vertical writing", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageContents([[
        "BT",
        "/F1 12 Tf",
        "1 0 0 1 72 700 Tm (Qty) Tj",
        "1 0 0 1 180 700 Tm (Description) Tj",
        "1 0 0 1 360 700 Tm (Price) Tj",
        "1 0 0 1 450 700 Tm (Amount) Tj",
        "ET",
      ].join("\n")]),
    },
  }));
  const runs = valueOf(await document.extract()).pages[0]?.runs ?? [];
  assert.ok(runs.every((run) => run.writingMode === undefined));
  await engine.dispose();
});

test("page rotation normalizes text orientation and anchors", async () => {
  const engine = createPdfEngine();
  const document = valueOf(await engine.open({
    source: {
      kind: "bytes",
      bytes: buildPdfWithPageSpecs([{
        rotate: 90,
        content: "BT\n/F1 1 Tf\n0 12 -12 0 100 200 Tm\n(Rotated Page) Tj\nET",
      }]),
    },
  }));
  const run = valueOf(await document.extract()).pages[0]?.runs[0];
  assert.deepEqual(run?.anchor, { x: 200, y: 512 });
  assert.equal(run?.fontSize, 12);
  assert.equal(run?.writingMode, undefined);
  await engine.dispose();
});

test("safe repair prunes cyclic page branches while strict mode rejects them", async () => {
  const bytes = buildPdfWithCyclicPageBranch();
  const engine = createPdfEngine();
  const repaired = await engine.open({ source: { kind: "bytes", bytes } });
  assert.equal(repaired.status, "partial");
  assert.equal(valueOf(repaired).summary.repaired, true);
  assert.equal(valueOf(await valueOf(repaired).extract()).extractedText, "Cycle Recovered");
  const strict = await engine.open({ source: { kind: "bytes", bytes }, policy: { repairMode: "strict" } });
  assert.equal(strict.status, "failed");
  await engine.dispose();
});

test("expected document failures are discriminated results while API misuse throws", async () => {
  const engine = createPdfEngine();
  const invalid = await engine.open({ source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }, policy: { repairMode: "strict" } });
  assert.equal(invalid.status, "failed");

  const { document } = await openTextDocument("Misuse");
  await assert.rejects(async () => document.search({ query: "" }), TypeError);
  await assert.rejects(async () => document.read({ maxCharacters: 0 }), TypeError);
  await assert.rejects(async () => engine.open({
    source: { kind: "bytes", bytes: buildPdfWithPageContents([]) },
    policy: { resourceBudget: { maxBytes: 0 } },
  }), TypeError);
  await engine.dispose();
});
