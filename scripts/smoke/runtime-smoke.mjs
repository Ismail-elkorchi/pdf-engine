function getArgs() {
  if (typeof Deno !== "undefined") {
    return Deno.args;
  }

  if (typeof Bun !== "undefined") {
    return Bun.argv.slice(2);
  }

  if (typeof process !== "undefined") {
    return process.argv.slice(2);
  }

  return [];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const [moduleSpecifier, expectedRuntime] = getArgs();

assert(typeof moduleSpecifier === "string" && moduleSpecifier.length > 0, "Missing module specifier.");
assert(typeof expectedRuntime === "string" && expectedRuntime.length > 0, "Missing expected runtime.");

const moduleNamespace = await import(moduleSpecifier);
assert(typeof moduleNamespace.createPdfEngine === "function", "Module does not export createPdfEngine().");

const syntheticPdf = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 29 >>",
  "stream",
  "BT",
  "(Hello PDF Engine) Tj",
  "ET",
  "endstream",
  "endobj",
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  "0",
  "%%EOF",
  "",
].join("\n");

const engine = moduleNamespace.createPdfEngine();
const result = await engine.run({
  source: {
    bytes: new TextEncoder().encode(syntheticPdf),
    fileName: "synthetic.pdf",
    mediaType: "application/pdf",
  },
});

assert(result.runtime.kind === expectedRuntime, `Expected runtime ${expectedRuntime} but received ${result.runtime.kind}.`);
assert(result.admission.status === "completed", `Admission status was ${result.admission.status}.`);
assert(result.ir.status === "completed", `IR status was ${result.ir.status}.`);
assert(result.observation.status === "completed", `Observation status was ${result.observation.status}.`);
assert(
  result.observation.value?.extractedText === "Hello PDF Engine",
  `Unexpected extracted text: ${JSON.stringify(result.observation.value?.extractedText ?? null)}.`,
);

console.log(
  JSON.stringify(
    {
      runtime: result.runtime.kind,
      admission: result.admission.status,
      ir: result.ir.status,
      observation: result.observation.status,
      text: result.observation.value?.extractedText ?? null,
    },
    null,
    2,
  ),
);
