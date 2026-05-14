import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

import fc from "fast-check";

import { createPdfEngine } from "../../dist/index.js";

const fuzzSeed = 20260316;
const fuzzRuns = 200;
const maxByteLength = 4096;
const caseTimeoutMs = 30_000;
const progressEveryCases = 25;
const progressIntervalMs = 30_000;
const textEncoder = new TextEncoder();
const engine = createPdfEngine();

const familyDefinitions = [
  {
    familyId: "raw-bytes",
    arbitrary: fc.oneof(
      fc.constant({
        bytes: new Uint8Array(),
        fileName: "raw-bytes.bin",
        expectsNativeText: false,
      }),
      fc.uint8Array({ maxLength: maxByteLength }).map((bytes) => ({
        bytes,
        fileName: "raw-bytes.bin",
        expectsNativeText: false,
      })),
    ),
  },
  {
    familyId: "pdf-like-shell",
    arbitrary: fc.record({
      versionMinor: fc.integer({ min: 0, max: 7 }),
      text: nativeTextArbitrary(),
      trailerNoise: fc.uint8Array({ maxLength: 32 }),
    }).map(({ versionMinor, text, trailerNoise }) => ({
      bytes: buildSimpleTextPdf({
        versionMinor,
        text,
        trailerExtras: `/Info 8 0 R /ID [<${bytesToHex(trailerNoise.slice(0, 8)) || "00"}> <${bytesToHex(trailerNoise.slice(0, 8)) || "00"}>]`,
        extraObjects: [
          {
            objectNumber: 8,
            body: "<< /Producer (fuzz) >>",
          },
        ],
      }),
      fileName: "pdf-like-shell.pdf",
      expectsNativeText: true,
    })),
  },
  {
    familyId: "xref-streams",
    arbitrary: fc.record({
      text: nativeTextArbitrary(),
      streamBody: fc.uint8Array({ maxLength: 24 }),
    }).map(({ text, streamBody }) => ({
      bytes: buildSimpleTextPdf({
        versionMinor: 7,
        text,
        extraObjects: [
          {
            objectNumber: 8,
            body:
              `<< /Type /XRef /Size 9 /W [1 1 1] /Length ${String(Math.max(1, streamBody.byteLength))} >>\nstream\n${decodeAscii(streamBody) || "A"}\nendstream`,
          },
        ],
      }),
      fileName: "xref-streams.pdf",
      expectsNativeText: true,
    })),
  },
  {
    familyId: "object-streams",
    arbitrary: fc.record({
      text: nativeTextArbitrary(),
      objectBody: fc.uint8Array({ maxLength: 64 }),
    }).map(({ text, objectBody }) => ({
      bytes: buildSimpleTextPdf({
        versionMinor: 7,
        text,
        extraObjects: [
          {
            objectNumber: 8,
            body:
              `<< /Type /ObjStm /N 1 /First 4 /Length ${String(Math.max(4, objectBody.byteLength))} >>\nstream\n${decodeAscii(objectBody) || "1 0 <<>>"}\nendstream`,
          },
        ],
      }),
      fileName: "object-streams.pdf",
      expectsNativeText: true,
    })),
  },
  {
    familyId: "filter-chains",
    arbitrary: fc.record({
      payload: fc.uint8Array({ maxLength: 64 }),
      useArrayForm: fc.boolean(),
    }).map(({ payload, useArrayForm }) => ({
      bytes: buildSimpleTextPdf({
        versionMinor: 5,
        text: "FILTER",
        contentObjectNumber: 4,
        contentStreamBody:
          `${decodeAscii(payload) || "4142>"}\n`,
        contentDictionaryExtras: useArrayForm
          ? "/Filter [/ASCIIHexDecode /FlateDecode]"
          : "/Filter /ASCIIHexDecode",
      }),
      fileName: "filter-chains.pdf",
      expectsNativeText: false,
    })),
  },
  {
    familyId: "encryption-dictionaries",
    arbitrary: fc.record({
      text: nativeTextArbitrary(),
      ownerBytes: fc.uint8Array({ minLength: 16, maxLength: 16 }),
      userBytes: fc.uint8Array({ minLength: 16, maxLength: 16 }),
    }).map(({ text, ownerBytes, userBytes }) => ({
      bytes: buildSimpleTextPdf({
        versionMinor: 7,
        text,
        trailerExtras: "/Encrypt 8 0 R",
        extraObjects: [
          {
            objectNumber: 8,
            body:
              `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${bytesToHex(ownerBytes)}> /U <${bytesToHex(userBytes)}> /P -4 >>`,
          },
        ],
      }),
      fileName: "encryption-dictionaries.pdf",
      expectsNativeText: false,
    })),
  },
  {
    familyId: "inherited-resources-and-page-tree",
    arbitrary: fc.record({
      firstText: nativeTextArbitrary(),
      secondText: nativeTextArbitrary(),
    }).map(({ firstText, secondText }) => ({
      bytes: buildInheritedResourcesPdf(firstText, secondText),
      fileName: "inherited-resources.pdf",
      expectsNativeText: true,
    })),
  },
  {
    familyId: "pathological-geometry-and-content",
    arbitrary: fc.record({
      text: nativeTextArbitrary(),
      scale: fc.integer({ min: 1, max: 5000 }),
      translateX: fc.integer({ min: -5000, max: 5000 }),
      translateY: fc.integer({ min: -5000, max: 5000 }),
      rectangleCount: fc.integer({ min: 4, max: 18 }),
    }).map(({ text, scale, translateX, translateY, rectangleCount }) => ({
      bytes: buildGeometryStressPdf({ text, scale, translateX, translateY, rectangleCount }),
      fileName: "pathological-geometry.pdf",
      expectsNativeText: true,
    })),
  },
];

const cases = sampleFamilyCases();
const familySummaries = new Map(
  familyDefinitions.map((definition) => [
    definition.familyId,
    {
      familyId: definition.familyId,
      runCount: 0,
      failingInvariant: null,
      topSlowCases: [],
    },
  ]),
);
const slowestCases = [];
let ok = true;
let failure = null;
let completedCases = 0;
let currentCase = null;

const progressTimer = setInterval(() => {
  if (currentCase) {
    const elapsedMs = Number((performance.now() - currentCase.startedAt).toFixed(3));
    process.stderr.write(
      `[fuzz] progress completed=${String(completedCases)}/${String(cases.length)} currentFamily=${currentCase.familyId} currentHash=${currentCase.caseHash} elapsedMs=${String(elapsedMs)}\n`,
    );
  }
}, progressIntervalMs);
progressTimer.unref();

for (const testCase of cases) {
  const familySummary = familySummaries.get(testCase.familyId);
  if (familySummary) {
    familySummary.runCount += 1;
  }

  try {
    currentCase = {
      familyId: testCase.familyId,
      caseHash: hashCase(testCase.bytes),
      startedAt: performance.now(),
    };
    await runCase(testCase);
    completedCases += 1;
    if (completedCases % progressEveryCases === 0 || completedCases === cases.length) {
      process.stderr.write(`[fuzz] completed=${String(completedCases)}/${String(cases.length)}\n`);
    }
  } catch (error) {
    ok = false;
    const message = error instanceof Error ? error.message : String(error);
    if (familySummary) {
      familySummary.failingInvariant ??= message;
    }
    failure = {
      familyId: testCase.familyId,
      caseHash: hashCase(testCase.bytes),
      message,
    };
    break;
  } finally {
    currentCase = null;
  }
}

clearInterval(progressTimer);

process.stdout.write(
  `${JSON.stringify(
    {
      suite: "fuzz",
      ok,
      seed: fuzzSeed,
      runs: cases.length,
      familySummaries: [...familySummaries.values()],
      slowestCases,
      ...(failure ? { failure } : {}),
    },
    null,
    2,
  )}\n`,
);

if (!ok) {
  process.exitCode = 1;
}

function nativeTextArbitrary() {
  return fc
    .array(fc.integer({ min: 0, max: 26 }), { minLength: 1, maxLength: 18 })
    .map((values) =>
      values.map((value) => (value === 26 ? " " : String.fromCharCode(65 + value))).join("").trim() || "TEXT",
    );
}

function sampleFamilyCases() {
  const baseRunCount = Math.floor(fuzzRuns / familyDefinitions.length);
  const remainder = fuzzRuns % familyDefinitions.length;
  const sampledCases = [];

  for (const [index, definition] of familyDefinitions.entries()) {
    const runCount = baseRunCount + (index < remainder ? 1 : 0);
    const samples = fc.sample(definition.arbitrary, {
      seed: fuzzSeed + index * 101,
      numRuns: runCount,
    });

    for (const sample of samples) {
      sampledCases.push({
        familyId: definition.familyId,
        ...sample,
      });
    }
  }

  return sampledCases;
}

async function runCase(testCase) {
  const startedAt = performance.now();
  const first = await runEngineWithTimeout(testCase, "first");
  const second = await runEngineWithTimeout(testCase, "second");
  const durationMs = performance.now() - startedAt;
  const caseSummary = {
    familyId: testCase.familyId,
    caseHash: hashCase(testCase.bytes),
    byteLength: testCase.bytes.byteLength,
    durationMs: Number(durationMs.toFixed(3)),
    admissionStatus: first.admission.status,
  };

  recordSlowCase(slowestCases, caseSummary, 10);
  const familySummary = familySummaries.get(testCase.familyId);
  if (familySummary) {
    recordSlowCase(familySummary.topSlowCases, caseSummary, 3);
  }

  assertPipelineResult(testCase, first);
  assertPipelineResult(testCase, second);
  assertRepeatedRunDeterminism(first, second);
}

async function runEngineWithTimeout(testCase, runLabel) {
  let timeoutHandle;
  try {
    return await Promise.race([
      engine.run({
        source: {
          bytes: testCase.bytes,
          fileName: testCase.fileName,
        },
      }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `fuzz case timed out: family=${testCase.familyId} hash=${hashCase(testCase.bytes)} run=${runLabel} timeoutMs=${String(caseTimeoutMs)}`,
            ),
          );
        }, caseTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildSimpleTextPdf({
  versionMinor,
  text,
  trailerExtras = "",
  extraObjects = [],
  contentObjectNumber = 4,
  contentStreamBody,
  contentDictionaryExtras = "",
}) {
  const contentText = contentStreamBody ?? [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `(${escapePdfString(text)}) Tj`,
    "ET",
  ].join("\n");
  const contentLength = textEncoder.encode(contentText).byteLength;

  return buildPdfFromObjects(
    [
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
        body: `<< /Type /Page /Parent 2 0 R /Resources 5 0 R /MediaBox [0 0 612 792] /Contents ${String(contentObjectNumber)} 0 R >>`,
      },
      {
        objectNumber: contentObjectNumber,
        body:
          `<< /Length ${String(contentLength)}` +
          (contentDictionaryExtras.length > 0 ? ` ${contentDictionaryExtras}` : "") +
          ` >>\nstream\n${contentText}\nendstream`,
      },
      {
        objectNumber: 5,
        body: "<< /Font << /F1 6 0 R >> >>",
      },
      {
        objectNumber: 6,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
      ...extraObjects,
    ],
    versionMinor,
    trailerExtras,
  );
}

function buildInheritedResourcesPdf(firstText, secondText) {
  const firstContent = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `(${escapePdfString(firstText)}) Tj`,
    "ET",
  ].join("\n");
  const secondContent = [
    "BT",
    "/F1 12 Tf",
    "72 680 Td",
    `(${escapePdfString(secondText)}) Tj`,
    "ET",
  ].join("\n");

  return buildPdfFromObjects([
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
      body: "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /Resources 8 0 R /MediaBox [0 0 612 792] >>",
    },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 3 0 R /Contents 6 0 R >>",
    },
    {
      objectNumber: 5,
      body: "<< /Type /Page /Parent 3 0 R /Contents 7 0 R >>",
    },
    {
      objectNumber: 6,
      body: `<< /Length ${String(textEncoder.encode(firstContent).byteLength)} >>\nstream\n${firstContent}\nendstream`,
    },
    {
      objectNumber: 7,
      body: `<< /Length ${String(textEncoder.encode(secondContent).byteLength)} >>\nstream\n${secondContent}\nendstream`,
    },
    {
      objectNumber: 8,
      body: "<< /Font << /F1 9 0 R >> >>",
    },
    {
      objectNumber: 9,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
  ], 7);
}

function buildGeometryStressPdf({ text, scale, translateX, translateY, rectangleCount }) {
  const commands = [
    "q",
    `${String(scale)} 0 0 ${String(scale)} ${String(translateX)} ${String(translateY)} cm`,
    "0 0 1 rg",
    "0 0 1 RG",
    "1 w",
  ];

  for (let index = 0; index < rectangleCount; index += 1) {
    const x = 5 + index * 3;
    const y = 10 + index * 2;
    const width = 20 + (index % 5) * 4;
    const height = 8 + (index % 4) * 3;
    commands.push(`${String(x)} ${String(y)} ${String(width)} ${String(height)} re`);
    commands.push(index % 2 === 0 ? "S" : "f");
  }

  commands.push(
    "BT",
    "/F1 10 Tf",
    "1 0 0 1 0 0 Tm",
    `(${escapePdfString(text)}) Tj`,
    "ET",
    "Q",
  );

  return buildSimpleTextPdf({
    versionMinor: 7,
    text,
    contentStreamBody: commands.join("\n"),
  });
}

function buildPdfFromObjects(objects, versionMinor = 7, trailerExtras = "") {
  const offsets = new Map();
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

  pdfText += `trailer\n<< /Root 1 0 R /Size ${String(objectCount)}${trailerExtras.length > 0 ? ` ${trailerExtras}` : ""} >>\n`;
  pdfText += `startxref\n${String(xrefOffset)}\n%%EOF\n`;
  return textEncoder.encode(pdfText);
}

function escapePdfString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function decodeAscii(bytes) {
  return Array.from(bytes, (value) => String.fromCharCode(32 + (value % 95))).join("");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function hashCase(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function assertPipelineResult(testCase, result) {
  if (result.source.byteLength !== testCase.bytes.byteLength) {
    throw new Error(`source byte length mismatch: ${result.source.byteLength} !== ${testCase.bytes.byteLength}`);
  }

  const stages = [
    result.admission.stage,
    result.ir.stage,
    result.observation.stage,
    result.layout.stage,
    result.knowledge.stage,
    result.render.stage,
  ];
  const expectedStages = ["admission", "ir", "observation", "layout", "knowledge", "render"];
  if (JSON.stringify(stages) !== JSON.stringify(expectedStages)) {
    throw new Error(`pipeline stages are out of contract order: ${JSON.stringify(stages)}`);
  }

  if (!Array.isArray(result.diagnostics)) {
    throw new Error("diagnostics must be an array");
  }
  for (const diagnostic of result.diagnostics) {
    if (
      typeof diagnostic !== "object" ||
      diagnostic === null ||
      typeof diagnostic.stage !== "string" ||
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.message !== "string"
    ) {
      throw new Error("diagnostics must preserve the public array/object shape");
    }
  }

  const admissionValue = result.admission.value;
  if (admissionValue && admissionValue.byteLength !== testCase.bytes.byteLength) {
    throw new Error("admission byte length does not match source byte length");
  }
  if (admissionValue?.fileType === "unknown" && admissionValue.decision === "accepted") {
    throw new Error("unknown files must not be accepted");
  }

  const irValue = result.ir.value;
  if (irValue && irValue.byteLength !== testCase.bytes.byteLength) {
    throw new Error("ir byte length does not match source byte length");
  }

  const observationValue = result.observation.value;
  if (observationValue && !Array.isArray(observationValue.pages)) {
    throw new Error("observation pages must be an array");
  }

  if (testCase.expectsNativeText) {
    const extractedText = observationValue?.extractedText?.trim() ?? "";
    if (admissionValue?.decision === "accepted" && extractedText.length === 0) {
      throw new Error("searchable native-text case produced a silent empty success");
    }
  }

  assertFiniteNumbers(result.observation.value?.pages, "observation.pages");
  assertFiniteNumbers(result.layout.value?.pages, "layout.pages");
  assertFiniteNumbers(result.knowledge.value?.chunks, "knowledge.chunks");
  assertFiniteNumbers(result.knowledge.value?.tables, "knowledge.tables");
  assertFiniteNumbers(result.render.value?.pages, "render.pages");
}

function assertRepeatedRunDeterminism(first, second) {
  if (first.admission.status !== second.admission.status) {
    throw new Error("repeated runs changed the admission status");
  }
  if (first.ir.status !== second.ir.status) {
    throw new Error("repeated runs changed the ir status");
  }
  if (first.observation.status !== second.observation.status) {
    throw new Error("repeated runs changed the observation status");
  }
  if ((first.observation.value?.extractedText ?? "") !== (second.observation.value?.extractedText ?? "")) {
    throw new Error("repeated runs changed extracted text");
  }
  if (JSON.stringify(first.diagnostics) !== JSON.stringify(second.diagnostics)) {
    throw new Error("repeated runs changed diagnostics");
  }

  const firstRenderHash = first.render.value?.renderHash?.hex;
  const secondRenderHash = second.render.value?.renderHash?.hex;
  if (firstRenderHash !== undefined || secondRenderHash !== undefined) {
    if (firstRenderHash !== secondRenderHash) {
      throw new Error("render hashes changed across repeated runs");
    }
  }
}

function assertFiniteNumbers(value, path) {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number detected at ${path}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertFiniteNumbers(entry, `${path}[${index}]`);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertFiniteNumbers(entry, `${path}.${key}`);
    }
  }
}

function recordSlowCase(target, entry, limit) {
  target.push(entry);
  target.sort((left, right) => right.durationMs - left.durationMs);
  target.splice(limit);
}
