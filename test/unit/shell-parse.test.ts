import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  analyzePdfShell,
  decodePdfLiteral,
  findFirstDictionaryToken,
  parseContentStreamOperators,
  parseDictionaryEntries,
  parseTextOperatorRuns,
  readObjectRefValue,
  readObjectRefsValue,
} from "../../src/shell-parse.ts";

const textEncoder = new TextEncoder();
const defaultPolicy = {
  javascriptActions: "deny",
  launchActions: "deny",
  embeddedFiles: "report",
  repairMode: "safe",
  passwordPolicy: "known-only",
  allowEncryptedMetadata: false,
  resourceBudget: {
    maxBytes: 64_000_000,
    maxPages: 10_000,
    maxObjects: 2_000_000,
    maxMilliseconds: 5_000,
    maxRecursionDepth: 64,
    maxScanBytes: 1_500_000,
  },
} as const;

function buildPdfFromObjects(
  objects: ReadonlyArray<{ readonly objectNumber: number; readonly body: string }>,
  versionMinor = 7,
): Uint8Array {
  const offsets = new Map<number, number>();
  const sortedObjects = [...objects].sort((left, right) => left.objectNumber - right.objectNumber);
  let pdfText = `%PDF-1.${versionMinor}\n`;

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

  pdfText += `trailer\n<< /Root 1 0 R /Size ${String(objectCount)} >>\n`;
  pdfText += `startxref\n${String(xrefOffset)}\n%%EOF\n`;
  return textEncoder.encode(pdfText);
}

test("parseDictionaryEntries keeps nested dictionaries and arrays intact", () => {
  const entries = parseDictionaryEntries(
    "<< /Type /Page /Kids [4 0 R 5 0 R] /Resources << /Font << /F1 3 0 R >> >> >>",
  );

  assert.equal(entries.get("Type"), "/Page");
  assert.equal(entries.get("Kids"), "[4 0 R 5 0 R]");
  assert.equal(entries.get("Resources"), "<< /Font << /F1 3 0 R >> >>");
});

test("parseDictionaryEntries preserves decimal numeric values", () => {
  const entries = parseDictionaryEntries(
    "<< /Type /ExtGState /CA 0.5 /ca 0.25 /BM /Multiply >>",
  );

  assert.equal(entries.get("CA"), "0.5");
  assert.equal(entries.get("ca"), "0.25");
  assert.equal(entries.get("BM"), "/Multiply");
});

test("readObjectRefValue and readObjectRefsValue recover direct and array references", () => {
  assert.deepEqual(readObjectRefValue("12 0 R"), {
    objectNumber: 12,
    generationNumber: 0,
  });
  assert.equal(readObjectRefValue("12 0"), undefined);
  assert.deepEqual(readObjectRefsValue("[4 0 R 5 2 R 9 0 R]"), [
    {
      objectNumber: 4,
      generationNumber: 0,
    },
    {
      objectNumber: 5,
      generationNumber: 2,
    },
    {
      objectNumber: 9,
      generationNumber: 0,
    },
  ]);
});

test("parseContentStreamOperators and parseTextOperatorRuns recover operator-level text state", () => {
  const text = [
    "q",
    "% comment before path",
    "0 0 m",
    "10 0 l",
    "S",
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Hello\\040World) Tj",
    "ET",
    "Q",
  ].join("\n");

  assert.deepEqual(
    parseContentStreamOperators(text).map((operator) => operator.operator),
    ["q", "m", "l", "S", "BT", "Tf", "Tm", "Tj", "ET", "Q"],
  );

  const runs = parseTextOperatorRuns(text);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.operator, "Tj");
  assert.equal(runs[0]?.fontResourceName, "F1");
  assert.equal(runs[0]?.fontSize, 12);
  assert.equal(runs[0]?.startsNewLine, true);
  assert.deepEqual(runs[0]?.anchor, {
    x: 72,
    y: 720,
  });
  assert.deepEqual(runs[0]?.operands, [
    {
      kind: "literal",
      token: "(Hello\\040World)",
    },
  ]);
});

test("decodePdfLiteral and findFirstDictionaryToken handle escaped content", () => {
  assert.equal(
    decodePdfLiteral("(Hello\\040World\\n\\050ok\\051)"),
    "Hello World\n(ok)",
  );
  assert.equal(
    findFirstDictionaryToken("5 0 obj\n<< /Type /Page /Count 1 >>\nendobj"),
    "<< /Type /Page /Count 1 >>",
  );
});

test("analyzePdfShell preserves direct objects when object-stream expansion reuses a ref", async () => {
  const contentText = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "(P TMLNRYRDKN) Tj",
    "ET",
  ].join("\n");
  const bytes = buildPdfFromObjects([
    {
      objectNumber: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      objectNumber: 2,
      body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    },
    {
      objectNumber: 3,
      body: "<< /Type /Page /Parent 2 0 R /Resources 5 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    },
    {
      objectNumber: 4,
      body: `<< /Length ${String(textEncoder.encode(contentText).byteLength)} >>\nstream\n${contentText}\nendstream`,
    },
    {
      objectNumber: 5,
      body: "<< /Font << /F1 6 0 R >> >>",
    },
    {
      objectNumber: 6,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
    {
      objectNumber: 8,
      body: "<< /Type /ObjStm /N 1 /First 4 /Length 8 >>\nstream\n4,3nGR4K\nendstream",
    },
  ]);

  const analysis = await analyzePdfShell({ bytes, fileName: "object-streams.pdf" }, defaultPolicy);
  const contentObject = analysis.objectIndex.get("4:0");

  assert.equal(contentObject?.streamRole, "content");
  assert.equal(contentObject?.streamText, contentText);
  assert.equal(analysis.pageEntries[0]?.contentStreamRefs[0]?.objectNumber, 4);
});
