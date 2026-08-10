const moduleSpecifier = runtimeArguments()[0];
const expectedRuntime = runtimeArguments()[1];
if (moduleSpecifier === undefined || expectedRuntime === undefined) {
  throw new Error("Usage: runtime-smoke.mjs <module-specifier> <runtime>");
}

const { createPdfEngine } = await import(moduleSpecifier);
assert(typeof createPdfEngine === "function", "Package entry point does not export createPdfEngine().");

const bytes = buildPdf("Portable Session");
const engine = createPdfEngine();
try {
  assert(engine.identity.version === "0.1.0", "Package version changed unexpectedly.");
  assert(engine.identity.mode === "read", "Package mode is not read-only.");
  assert(engine.runtime.kind === expectedRuntime, `Expected ${expectedRuntime}, received ${engine.runtime.kind}.`);

  const opened = await engine.open({
    source: { kind: "bytes", bytes, fileName: "portable-session.pdf" },
  });
  const document = valueOf(opened, "open");
  const structure = valueOf(await document.structure(), "structure");
  const observation = valueOf(await document.extract(), "extract");
  const layout = valueOf(await document.layout(), "layout");
  const knowledge = valueOf(await document.knowledge(), "knowledge");
  const search = valueOf(await document.search({ query: "portable", caseSensitive: false }), "search");
  const read = valueOf(await document.read({ maxCharacters: 8 }), "read");
  const features = valueOf(await document.features(), "features");

  assert(structure.pageCount === 1, "Structure page count is incorrect.");
  assert(observation.extractedText === "Portable Session", "Text extraction differs from the source.");
  assert(layout.pages.length === 1, "Layout did not preserve the page.");
  assert(knowledge.markdown.includes("Portable Session"), "Knowledge projection omitted source text.");
  assert(search.matches.length === 1, "Search did not recover the expected match.");
  assert(read.fragments.map((fragment) => fragment.text).join("") === "Portable", "Bounded read returned unexpected text.");
  assert(features.pageLabels[0]?.label === "1", "Default page labels are missing.");

  const randomAccess = valueOf(await engine.open({
    source: {
      kind: "random-access",
      byteLength: bytes.byteLength,
      read: async ({ offset, length }) => Uint8Array.from(bytes.subarray(offset, offset + length)),
    },
  }), "random-access open");
  assert(
    valueOf(await randomAccess.extract(), "random-access extract").extractedText === observation.extractedText,
    "Random-access source semantics differ from byte-source semantics.",
  );

  const invalid = await engine.open({
    source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
    policy: { repairMode: "strict" },
  });
  assert(invalid.status === "failed", "Malformed input did not produce a discriminated failure.");

  writeOutput(`${JSON.stringify({
    runtime: engine.runtime.kind,
    version: engine.identity.version,
    pageCount: structure.pageCount,
    text: observation.extractedText,
    searchCount: search.matches.length,
    invalidStatus: invalid.status,
  }, null, 2)}\n`);
} finally {
  await engine.dispose();
}

function valueOf(result, operation) {
  if (result.status !== "completed" && result.status !== "partial") {
    throw new Error(`${operation} returned ${result.status}.`);
  }
  return result.value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runtimeArguments() {
  if (typeof Deno !== "undefined") {
    return Deno.args;
  }
  if (typeof Bun !== "undefined") {
    return Bun.argv.slice(2);
  }
  return process.argv.slice(2);
}

function writeOutput(value) {
  if (typeof Deno !== "undefined") {
    Deno.stdout.writeSync(new TextEncoder().encode(value));
    return;
  }
  process.stdout.write(value);
}

function buildPdf(text) {
  const encoder = new TextEncoder();
  const content = `BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(${escapePdfString(text)}) Tj\nET`;
  const objects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"],
    [5, `<< /Length ${String(encoder.encode(content).byteLength)} >>\nstream\n${content}\nendstream`],
  ];
  const offsets = new Map();
  let pdf = "%PDF-1.4\n";
  for (const [number, body] of objects) {
    offsets.set(number, encoder.encode(pdf).byteLength);
    pdf += `${String(number)} 0 obj\n${body}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).byteLength;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let number = 1; number <= 5; number += 1) {
    pdf += `${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function escapePdfString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
