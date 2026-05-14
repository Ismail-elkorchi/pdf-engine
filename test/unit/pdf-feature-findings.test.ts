import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/engine-core.ts";
import { evaluatePdfFeatureFindings } from "../../src/pdf-feature-findings.ts";
import { type PdfShellAnalysis, analyzePdfShell } from "../../src/shell-parse.ts";
import type { PdfNormalizedAdmissionPolicy } from "../../src/contracts.ts";

const textEncoder = new TextEncoder();

function buildPdfFromObjects(objects: readonly { readonly objectNumber: number; readonly body: string }[]): Uint8Array {
  const offsets = new Map<number, number>();
  const sortedObjects = [...objects].toSorted((left, right) => left.objectNumber - right.objectNumber);
  let pdfText = "%PDF-1.4\n";

  for (const object of sortedObjects) {
    offsets.set(object.objectNumber, textEncoder.encode(pdfText).byteLength);
    pdfText += `${String(object.objectNumber)} 0 obj\n${object.body}\nendobj\n`;
  }

  const xrefOffset = textEncoder.encode(pdfText).byteLength;
  const objectCount = Math.max(...sortedObjects.map((object) => object.objectNumber)) + 1;
  pdfText += `xref\n0 ${String(objectCount)}\n`;
  pdfText += "0000000000 65535 f \n";

  for (let objectNumber = 1; objectNumber < objectCount; objectNumber += 1) {
    const offset = offsets.get(objectNumber);
    pdfText += offset === undefined
      ? "0000000000 65535 f \n"
      : `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  pdfText += `trailer\n<< /Root 1 0 R /Size ${String(objectCount)} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return textEncoder.encode(pdfText);
}

function buildFeatureFindingPdf(): Uint8Array {
  const contentStream = [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "/OC /MC1 BDC",
    "(Visible Layer) Tj",
    "EMC",
    "ET",
  ].join("\n");

  return buildPdfFromObjects([
    {
      objectNumber: 1,
      body:
        "<< /Type /Catalog /Pages 2 0 R /AcroForm 10 0 R /OCProperties 11 0 R /OpenAction 5 0 R >>",
    },
    {
      objectNumber: 2,
      body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    },
    {
      objectNumber: 3,
      body:
        "<< /Type /Page /Parent 2 0 R /Resources 16 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [8 0 R] >>",
    },
    {
      objectNumber: 4,
      body: `<< /Length ${String(textEncoder.encode(contentStream).byteLength)} >>\nstream\n${contentStream}\nendstream`,
    },
    {
      objectNumber: 5,
      body: "<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>",
    },
    {
      objectNumber: 6,
      body: "<< /Type /Action /S /Launch /F (tool.exe) >>",
    },
    {
      objectNumber: 7,
      body: "<< /Type /EmbeddedFile /Length 4 >>\nstream\nDATA\nendstream",
    },
    {
      objectNumber: 8,
      body: "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A 5 0 R >>",
    },
    {
      objectNumber: 9,
      body: "<< /Type /ObjStm /N 0 /First 0 /Length 0 >>\nstream\n\nendstream",
    },
    {
      objectNumber: 10,
      body: "<< /Fields [12 0 R] >>",
    },
    {
      objectNumber: 11,
      body: "<< /OCGs [13 0 R] /D << /ON [13 0 R] >> >>",
    },
    {
      objectNumber: 12,
      body: "<< /FT /Tx /T (Name) >>",
    },
    {
      objectNumber: 13,
      body: "<< /Type /OCG /Name (Layer 1) >>",
    },
    {
      objectNumber: 15,
      body:
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /OC 13 0 R /Length 1 >>\nstream\nA\nendstream",
    },
    {
      objectNumber: 16,
      body: "<< /Font << /F1 17 0 R >> /XObject << /Im1 15 0 R >> >>",
    },
    {
      objectNumber: 17,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
    {
      objectNumber: 18,
      body: "<< /Type /XRef /Size 19 /W [1 1 1] /Length 3 >>\nstream\nABC\nendstream",
    },
  ]);
}

function buildScanFallbackAnalysis(scanText: string): PdfShellAnalysis {
  return {
    scanText,
    byteLength: scanText.length,
    isTruncated: false,
    usedFullStructureScan: false,
    fileType: "pdf",
    startXrefResolved: false,
    crossReferenceKind: "classic",
    crossReferenceSections: [],
    indirectObjects: [],
    objectIndex: new Map(),
    pageEntries: [],
    pageTreeResolved: false,
    inheritedPageStateResolved: false,
    expandedObjectStreams: false,
    decodedXrefStreamEntries: false,
    parseCoverage: {
      header: true,
      indirectObjects: false,
      crossReference: false,
      trailer: false,
      startXref: false,
      pageTree: false,
    },
    repairState: "clean",
  };
}

function countFindingsByKind(
  findings: readonly { readonly kind: string }[],
  kind: string,
): number {
  return findings.filter((finding) => finding.kind === kind).length;
}

test("evaluatePdfFeatureFindings keeps authoritative object evidence separate from scan-only findings", async () => {
  const engine = createPdfEngine();
  const policy = engine.defaultPolicy;
  const analysis = await analyzePdfShell(
    {
      bytes: buildFeatureFindingPdf(),
      fileName: "feature-findings.pdf",
    },
    policy,
  );

  const evaluation = evaluatePdfFeatureFindings(analysis, policy);

  assert.equal(analysis.crossReferenceKind, "hybrid");
  assert.ok(evaluation.authoritativeFeatureKinds.includes("javascript-actions"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("launch-actions"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("embedded-files"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("forms"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("optional-content"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("object-streams"));
  assert.ok(evaluation.authoritativeFeatureKinds.includes("xref-streams"));
  assert.equal(evaluation.scanFallbackPolicyKinds.length, 0);

  const javascriptFinding = evaluation.featureFindings.find((finding) => finding.kind === "javascript-actions");
  const launchFinding = evaluation.featureFindings.find((finding) => finding.kind === "launch-actions");
  const embeddedFileFinding = evaluation.featureFindings.find((finding) => finding.kind === "embedded-files");
  const formFinding = evaluation.featureFindings.find((finding) => finding.kind === "forms");
  const optionalContentFinding = evaluation.featureFindings.find((finding) => finding.kind === "optional-content");
  const objectStreamFinding = evaluation.featureFindings.find((finding) => finding.kind === "object-streams");
  const xrefStreamFinding = evaluation.featureFindings.find((finding) => finding.kind === "xref-streams");
  const hiddenTextFinding = evaluation.featureFindings.find((finding) => finding.kind === "hidden-text");

  assert.equal(javascriptFinding?.evidenceSource, "object");
  assert.equal(javascriptFinding?.action, "deny");
  assert.equal(launchFinding?.evidenceSource, "object");
  assert.equal(launchFinding?.action, "deny");
  assert.equal(embeddedFileFinding?.evidenceSource, "object");
  assert.equal(formFinding?.evidenceSource, "object");
  assert.deepEqual("fieldRefs" in (formFinding ?? {}) ? formFinding.fieldRefs : [], [
    { objectNumber: 12, generationNumber: 0 },
  ]);
  assert.equal(optionalContentFinding?.evidenceSource, "object");
  assert.deepEqual("groupRefs" in (optionalContentFinding ?? {}) ? optionalContentFinding.groupRefs : [], [
    { objectNumber: 13, generationNumber: 0 },
  ]);
  assert.deepEqual("memberObjectRefs" in (optionalContentFinding ?? {}) ? optionalContentFinding.memberObjectRefs : [], [
    { objectNumber: 15, generationNumber: 0 },
    { objectNumber: 13, generationNumber: 0 },
  ]);
  assert.equal(objectStreamFinding?.evidenceSource, "object");
  assert.equal(xrefStreamFinding?.evidenceSource, "object");
  assert.equal(hiddenTextFinding?.evidenceSource, "scan");
  assert.equal(
    countFindingsByKind(evaluation.featureFindings, "javascript-actions"),
    1,
  );
});

test("evaluatePdfFeatureFindings uses scan fallback when parsed object coverage is unavailable", () => {
  const policy: PdfNormalizedAdmissionPolicy = createPdfEngine().defaultPolicy;
  const analysis = buildScanFallbackAnalysis(
    "/JavaScript /Launch /EmbeddedFile /AcroForm /ObjStm /Type /XRef /ActualText /Subtype /Image /Font",
  );

  const evaluation = evaluatePdfFeatureFindings(analysis, policy);

  assert.ok(evaluation.scanFallbackPolicyKinds.includes("javascript-actions"));
  assert.ok(evaluation.scanFallbackPolicyKinds.includes("launch-actions"));
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "javascript-actions")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "launch-actions")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "embedded-files")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "forms")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "object-streams")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "xref-streams")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "hidden-text")?.evidenceSource,
    "scan",
  );
  assert.equal(
    evaluation.featureFindings.find((finding) => finding.kind === "duplicate-text-layer")?.evidenceSource,
    "scan",
  );
});
