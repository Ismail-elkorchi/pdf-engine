import fc from "fast-check";
import { performance } from "node:perf_hooks";

import { createPdfEngine } from "../../dist/index.js";

const fuzzSeed = 20260316;
const fuzzRuns = 200;
const maxByteLength = 4096;
const textEncoder = new TextEncoder();

const engine = createPdfEngine();
const slowestCases = [];

await fc.assert(
  fc.asyncProperty(pdfInputArbitrary(), async (bytes) => {
    const startedAt = performance.now();
    const result = await engine.run({
      source: {
        bytes,
        fileName: "fuzz-input.pdf",
      },
    });
    const durationMs = performance.now() - startedAt;

    recordSlowCase(durationMs, bytes.byteLength, result.admission.status);
    assertPipelineResult(bytes, result);
  }),
  {
    numRuns: fuzzRuns,
    seed: fuzzSeed,
    examples: [
      [new Uint8Array()],
      [textEncoder.encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF")],
      [textEncoder.encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nstream\nbroken")],
    ],
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      suite: "fuzz",
      ok: true,
      seed: fuzzSeed,
      runs: fuzzRuns,
      slowestCases,
    },
    null,
    2,
  )}\n`,
);

function pdfInputArbitrary() {
  return fc.oneof(
    fc.uint8Array({ maxLength: maxByteLength }),
    fc
      .record({
        versionMinor: fc.integer({ min: 0, max: 7 }),
        objectBody: fc.uint8Array({ maxLength: 1024 }),
        trailerBody: fc.uint8Array({ maxLength: 256 }),
      })
      .map(({ versionMinor, objectBody, trailerBody }) =>
        encodePdfLikeText(
          `%PDF-1.${versionMinor}\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nstream\n${decodeAscii(objectBody)}\nendstream\nendobj\ntrailer\n<< ${decodeAscii(trailerBody)} >>\nstartxref\n9\n%%EOF`,
        ),
      ),
    fc
      .record({
        prefix: fc.uint8Array({ maxLength: 128 }),
        suffix: fc.uint8Array({ maxLength: 1024 }),
      })
      .map(({ prefix, suffix }) =>
        concatBytes(prefix, encodePdfLikeText("%PDF-1.4\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\n"), suffix),
      ),
  );
}

function encodePdfLikeText(value) {
  return textEncoder.encode(value);
}

function decodeAscii(bytes) {
  return Array.from(bytes, (value) => String.fromCharCode(32 + (value % 95))).join("");
}

function concatBytes(...parts) {
  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function assertPipelineResult(bytes, result) {
  if (result.source.byteLength !== bytes.byteLength) {
    throw new Error(`source byte length mismatch: ${result.source.byteLength} !== ${bytes.byteLength}`);
  }

  if (result.admission.stage !== "admission" || result.ir.stage !== "ir" || result.observation.stage !== "observation") {
    throw new Error("pipeline stages are out of contract order");
  }

  if (!Array.isArray(result.diagnostics)) {
    throw new Error("diagnostics must be an array");
  }

  const admissionValue = result.admission.value;
  if (admissionValue && admissionValue.byteLength !== bytes.byteLength) {
    throw new Error("admission byte length does not match source byte length");
  }

  if (admissionValue?.fileType === "unknown" && admissionValue.decision === "accepted") {
    throw new Error("unknown files must not be accepted");
  }

  const irValue = result.ir.value;
  if (irValue && irValue.byteLength !== bytes.byteLength) {
    throw new Error("ir byte length does not match source byte length");
  }

  const observationValue = result.observation.value;
  if (observationValue && !Array.isArray(observationValue.pages)) {
    throw new Error("observation pages must be an array");
  }
}

function recordSlowCase(durationMs, byteLength, admissionStatus) {
  slowestCases.push({
    durationMs: Number(durationMs.toFixed(3)),
    byteLength,
    admissionStatus,
  });
  slowestCases.sort((left, right) => right.durationMs - left.durationMs);
  slowestCases.splice(5);
}
